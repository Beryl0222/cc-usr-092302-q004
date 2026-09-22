// 项目与点位聚合（subject: site:{id}）。
// 关键规则：
// - 以城市为单元的 "1+N"：kind=CENTER 为综合服务中心（1），
//   COMMUNITY（社区嵌入式）/ EMPLOYER（用人单位办托）为 N。
// - 竣工延期是"点位内"事件：只改本中心的计划竣工日与一年期限，
//   不产生任何市级冻结事件；网络读模型里其他点位照常运营。
// - 综合服务中心原则上竣工后一年内运营：竣工日 +1 年为 operateBy，
//   逾期允许开业但打上 overdue 标记，供市级统筹与负责人监督。

import { oneYearAfter } from "../clock.js";
import { monotonicStage, requireState } from "./util.js";

export function initial() {
  return null;
}

export function apply(state, e) {
  const p = e.payload;
  switch (e.kind) {
    case "SITE_REGISTERED":
      return {
        id: p.id,
        city: p.city,
        name: p.name,
        kind: p.kind,
        status: "REGISTERED",
        registeredAt: p.at,
        plannedCompletion: p.plannedCompletion,
        completionAt: null,
        operateBy: null,
        openedAt: null,
        overdue: false,
        milestones: [{ key: "REGISTERED", at: p.at }],
        postponements: [],
        mchAgreements: [],
      };
    case "MILESTONE_RECORDED":
      return { ...state, milestones: [...state.milestones, { key: p.key, at: p.at, note: p.note ?? "" }] };
    case "COMPLETION_POSTPONED":
      return {
        ...state,
        plannedCompletion: p.to,
        postponements: [...state.postponements, { from: p.from, to: p.to, reason: p.reason, at: e.occurred_at }],
      };
    case "CONSTRUCTION_COMPLETED":
      return { ...state, status: "COMPLETED", completionAt: p.at, operateBy: oneYearAfter(p.at.slice(0, 10)) };
    case "OPERATIONS_OPENED":
      return { ...state, status: "OPERATING", openedAt: p.at, overdue: p.overdue === true };
    case "SITE_SUSPENDED":
      return { ...state, status: "SUSPENDED", suspendedReason: p.reason, suspendedAt: p.at };
    case "SITE_RESUMED":
      return { ...state, status: "OPERATING", suspendedReason: null, suspendedAt: null };
    case "MCH_AGREEMENT_LINKED":
      return {
        ...state,
        mchAgreements: [
          ...state.mchAgreements,
          { orgId: p.orgId, orgName: p.orgName, services: p.services, from: p.from, to: p.to ?? null },
        ],
      };
    default:
      return state;
  }
}

export function decide(state, cmd) {
  const now = cmd.at;
  switch (cmd.type) {
    case "registerSite": {
      requireState(state, (s) => s === null, "点位已登记，不能重复建档");
      if (!["CENTER", "COMMUNITY", "EMPLOYER"].includes(cmd.kind)) throw new Error("点位类型必须为 CENTER/COMMUNITY/EMPLOYER");
      if (!cmd.city || !cmd.plannedCompletion) throw new Error("缺少城市或计划竣工日");
      return [{ kind: "SITE_REGISTERED", occurred_at: now, payload: { id: cmd.id, city: cmd.city, name: cmd.name, kind: cmd.kind, plannedCompletion: cmd.plannedCompletion, at: now } }];
    }
    case "recordMilestone": {
      requireState(state, (s) => s, "点位未登记");
      return [{ kind: "MILESTONE_RECORDED", occurred_at: now, payload: { key: cmd.key, at: cmd.occurredOn ?? now.slice(0, 10), note: cmd.note ?? "" } }];
    }
    case "postponeCompletion": {
      // 爆炸半径约束就在这里：事件只挂在 site:{本点位} 流上。
      requireState(state, (s) => s && s.status === "REGISTERED", "只有在建点位可申报竣工延期");
      if (cmd.to <= state.plannedCompletion) throw new Error("延期后的竣工日必须晚于原计划");
      return [{ kind: "COMPLETION_POSTPONED", occurred_at: now, payload: { from: state.plannedCompletion, to: cmd.to, reason: cmd.reason } }];
    }
    case "completeConstruction": {
      requireState(state, (s) => s && s.status === "REGISTERED", "只有在建点位可竣工");
      if (cmd.at.slice(0, 10) > state.plannedCompletion) {
        throw new Error("实际竣工晚于计划竣工日，请先办理竣工延期");
      }
      return [{ kind: "CONSTRUCTION_COMPLETED", occurred_at: now, payload: { at: cmd.occurredOn ?? now.slice(0, 10) } }];
    }
    case "openOperations": {
      requireState(state, (s) => s && s.status === "COMPLETED", "只有已竣工点位可开业");
      const openDate = (cmd.occurredOn ?? now).slice(0, 10);
      const overdue = openDate > state.operateBy; // 原则上一年内；逾期标红但不抹除事实
      return [{ kind: "OPERATIONS_OPENED", occurred_at: now, payload: { at: cmd.occurredOn ?? openDate, overdue, operateBy: state.operateBy } }];
    }
    case "suspendSite": {
      monotonicStage(state.status, ["OPERATING"], "SUSPENDED", "点位停整");
      return [{ kind: "SITE_SUSPENDED", occurred_at: now, payload: { reason: cmd.reason, at: (cmd.occurredOn ?? now).slice(0, 10) } }];
    }
    case "resumeSite": {
      monotonicStage(state.status, ["SUSPENDED"], "OPERATING", "点位复业");
      return [{ kind: "SITE_RESUMED", occurred_at: now, payload: {} }];
    }
    case "linkMchAgreement": {
      requireState(state, (s) => s, "点位未登记");
      return [{
        kind: "MCH_AGREEMENT_LINKED",
        occurred_at: now,
        payload: { orgId: cmd.orgId, orgName: cmd.orgName, services: cmd.services, from: cmd.from, to: cmd.to ?? null },
      }];
    }
    default:
      throw new Error(`site 聚合不认识命令 ${cmd.type}`);
  }
}
