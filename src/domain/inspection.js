// 消防、食品、伤害预防检查与监督整改（subject: inspection:{siteId}）。
// 一个主体流内含多个检查个案 caseId。
// 生命周期：OPENED -> NOTICED（已下整改通知）-> RECTIFIED（机构提交整改）->
//           RECEIPTED（监管回执确认）/ REJECTED（回执打回）-> CLOSED。
// 乱序语义：
// - 监管回执可能比机构整改提交"先到/迟到/重复到"。
//   RECEIPTED 必须基于 RECTIFIED；迟到的旧阶段事件不能回滚新阶段（阶段守卫）。
// - 每条结论盖 rule_version；回执重复（同 receipt_id）幂等忽略。
// - 被打回后允许重新提交整改并再次回执，全过程只追加。

import { monotonicStage, requireState } from "./util.js";

const ORDER = ["OPENED", "NOTICED", "RECTIFIED", "RECEIPTED", "REJECTED", "CLOSED"];

export function initial() {
  return { siteId: null, cases: new Map() };
}

function clone(s) {
  return { siteId: s.siteId, cases: new Map(Array.from(s.cases, ([k, c]) => [k, { ...c, timeline: [...c.timeline], receipts: [...c.receipts] }])) };
}

export function apply(state, e) {
  const p = e.payload;
  switch (e.kind) {
    case "INSPECTION_LEDGER_OPENED":
      return { ...state, siteId: p.siteId };
    case "INSPECTION_OPENED": {
      const s = clone(state);
      s.cases.set(p.caseId, { caseId: p.caseId, category: p.category, scope: p.scope, inspector: p.inspector, status: "OPENED", openedAt: p.at, timeline: [{ status: "OPENED", at: p.at }], receipts: [], conclusion: null, conclusionRuleVersion: null });
      return s;
    }
    case "RECTIFICATION_NOTICED": {
      const s = clone(state);
      const c = s.cases.get(p.caseId);
      if (c && c.status === "OPENED") { c.status = "NOTICED"; c.timeline.push({ status: "NOTICED", at: p.at, findings: p.findings, deadline: p.deadline }); }
      return s;
    }
    case "RECTIFICATION_SUBMITTED": {
      const s = clone(state);
      const c = s.cases.get(p.caseId);
      if (c && ["NOTICED", "REJECTED"].includes(c.status)) { c.status = "RECTIFIED"; c.timeline.push({ status: "RECTIFIED", at: p.at, evidence: p.evidence }); }
      return s;
    }
    case "RECTIFICATION_RECEIPTED": {
      const s = clone(state);
      const c = s.cases.get(p.caseId);
      if (!c || c.receipts.some((r) => r.receiptId === p.receiptId)) return state; // 重复回执幂等
      c.receipts.push({ receiptId: p.receiptId, accepted: p.accepted, at: p.at });
      if (c.status === "RECTIFIED") {
        c.status = p.accepted ? "RECEIPTED" : "REJECTED";
        if (p.accepted) {
          c.conclusion = p.conclusion ?? "整改通过";
          c.conclusionRuleVersion = e.rule_version;
        }
        c.timeline.push({ status: c.status, at: p.at, receiptId: p.receiptId, note: p.note ?? "" });
      }
      // 整改尚未提交时回执先到：登记回执但不改阶段，待 RECTIFIED 后可重新回执。
      return s;
    }
    case "INSPECTION_CLOSED": {
      const s = clone(state);
      const c = s.cases.get(p.caseId);
      if (c && ["RECEIPTED", "REJECTED"].includes(c.status)) { c.status = "CLOSED"; c.timeline.push({ status: "CLOSED", at: p.at }); }
      return s;
    }
    default:
      return state;
  }
}

export function decide(state, cmd) {
  const now = cmd.at;
  switch (cmd.type) {
    case "openInspectionLedger":
      requireState(state, (s) => s.siteId === null, "检查台账已开立");
      return [{ kind: "INSPECTION_LEDGER_OPENED", occurred_at: now, payload: { siteId: cmd.siteId } }];

    case "openInspection": {
      if (!["FIRE", "FOOD", "INJURY_PREVENTION", "OTHER"].includes(cmd.category)) throw new Error("检查类别不合法");
      if (state.cases.has(cmd.caseId)) throw new Error("检查个案已存在");
      return [{ kind: "INSPECTION_OPENED", occurred_at: now, payload: { caseId: cmd.caseId, category: cmd.category, scope: cmd.scope, inspector: cmd.inspector, at: now } }];
    }

    case "issueNotice": {
      const c = state.cases.get(cmd.caseId);
      requireState(state, () => c, "检查个案不存在");
      monotonicStage(c.status, ["OPENED"], "NOTICED", "下整改通知");
      return [{ kind: "RECTIFICATION_NOTICED", occurred_at: now, payload: { caseId: cmd.caseId, findings: cmd.findings, deadline: cmd.deadline } }];
    }

    case "submitRectification": {
      const c = state.cases.get(cmd.caseId);
      requireState(state, () => c, "检查个案不存在");
      monotonicStage(c.status, ["NOTICED", "REJECTED"], "RECTIFIED", "提交整改");
      return [{ kind: "RECTIFICATION_SUBMITTED", occurred_at: now, payload: { caseId: cmd.caseId, evidence: cmd.evidence } }];
    }

    case "recordReceipt": {
      // 监管回执乱序/重复：仅在 RECTIFIED 阶段可生效；过早回执登记但不推进。
      const c = state.cases.get(cmd.caseId);
      requireState(state, () => c, "检查个案不存在");
      if (c.receipts.some((r) => r.receiptId === cmd.receiptId)) return []; // 显式幂等：不产事件
      if (c.status !== "RECTIFIED") {
        const err = new Error(`回执到达时个案处于 ${c.status}，需先有整改提交`);
        err.code = "RECEIPT_OUT_OF_ORDER";
        throw err;
      }
      return [{
        kind: "RECTIFICATION_RECEIPTED",
        occurred_at: now,
        payload: { caseId: cmd.caseId, receiptId: cmd.receiptId, accepted: cmd.accepted, conclusion: cmd.conclusion, note: cmd.note ?? "" },
      }];
    }

    case "closeInspection": {
      const c = state.cases.get(cmd.caseId);
      requireState(state, () => c, "检查个案不存在");
      monotonicStage(c.status, ["RECEIPTED", "REJECTED"], "CLOSED", "归档");
      return [{ kind: "INSPECTION_CLOSED", occurred_at: now, payload: { caseId: cmd.caseId } }];
    }

    default:
      throw new Error(`inspection 聚合不认识命令 ${cmd.type}`);
  }
}

export { ORDER as STAGE_ORDER };
