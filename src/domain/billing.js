// 收费、减免与结算（subject: billing:{childId}）。
// - 全日托/半日托按账单周期预收；计时托按"实际服务时段"结算：
//   跨午夜也按实际签到-签退分钟数计费；改期后按实际发生的时段结算。
// - 收费规则（计时单价/减免资格）来自 RuleBook，账单盖 rule_version。
// - 扣费请求带幂等键 request_id：网络重试、重复点击不会重复扣费。
// - 退款/减免只追加调整事件，账单金额不可变，错误用负向调整更正。

import { requireState } from "./util.js";

export function initial() {
  return { childId: null, charges: new Map(), adjustments: [], payments: [] };
}

function clone(s) {
  return { childId: s.childId, charges: new Map(Array.from(s.charges, ([k, c]) => [k, { ...c }])), adjustments: [...s.adjustments], payments: [...s.payments] };
}

export function apply(state, e) {
  const p = e.payload;
  switch (e.kind) {
    case "BILLING_OPENED":
      return { ...state, childId: p.childId };

    case "CHARGE_RAISED": {
      const s = clone(state);
      s.charges.set(p.chargeId, {
        chargeId: p.chargeId,
        kind: p.kind, // FULL/HALF/HOURLY
        amount: p.amount,
        currency: p.currency ?? "CNY",
        status: "UNPAID",
        period: p.period ?? null,
        sessionId: p.sessionId ?? null,
        minutes: p.minutes ?? null,
        crossMidnight: p.crossMidnight ?? false,
        detail: p.detail ?? "",
        ruleVersion: e.rule_version,
      });
      return s;
    }

    case "PAYMENT_TAKEN": {
      const s = clone(state);
      const c = s.charges.get(p.chargeId);
      s.payments.push({ requestId: p.request_id, chargeId: p.chargeId, amount: p.amount, at: p.at, result: p.result });
      if (c && p.result === "SUCCESS") c.status = "PAID";
      return s;
    }

    case "CHARGE_ADJUSTED": {
      // 减免或更正：负向为退减、正向为补收；不修改原账单。
      const s = clone(state);
      s.adjustments.push({ adjustmentId: p.adjustmentId, chargeId: p.chargeId, delta: p.delta, reason: p.reason, category: p.category, at: p.at });
      return s;
    }

    default:
      return state;
  }
}

export function balance(state) {
  let billed = 0;
  let paid = 0;
  let adjusted = 0;
  for (const c of state.charges.values()) billed += c.amount;
  for (const a of state.adjustments) adjusted += a.delta;
  for (const p of state.payments) if (p.result === "SUCCESS") paid += p.amount;
  return { billed, adjusted, paid, due: billed + adjusted - paid };
}

// 计时托按实际分钟数与当时规则计算金额。单价、计费粒度取自规则。
export function hourlyCharge({ minutes, rule, crossMidnight = false }) {
  const unit = rule.hourly_unit_amount; // 元/小时
  const blockMinutes = rule.hourly_billing_block_minutes ?? 60; // 默认整小时
  const blocks = Math.ceil(minutes / blockMinutes);
  const overnightExtra = crossMidnight ? rule.overnight_surcharge ?? 0 : 0;
  return { amount: blocks * unit + overnightExtra, blocks, overnightExtra };
}

export function decide(state, cmd) {
  const now = cmd.at;
  switch (cmd.type) {
    case "openBilling":
      requireState(state, (s) => s.childId === null, "计费账户已开立");
      return [{ kind: "BILLING_OPENED", occurred_at: now, payload: { childId: cmd.childId } }];

    case "raiseCharge": {
      if (state.charges.has(cmd.chargeId)) throw new Error("账单已存在");
      if (cmd.amount < 0) throw new Error("账单金额不能为负，退补请走调整");
      return [{
        kind: "CHARGE_RAISED",
        occurred_at: now,
        payload: { chargeId: cmd.chargeId, kind: cmd.kind, amount: cmd.amount, period: cmd.period ?? null, sessionId: cmd.sessionId ?? null, minutes: cmd.minutes ?? null, crossMidnight: cmd.crossMidnight ?? false, detail: cmd.detail ?? "" },
      }];
    }

    case "takePayment": {
      // 幂等扣费：同一 request_id 只成功一次。
      const seen = state.payments.find((p) => p.requestId === cmd.request_id);
      if (seen) return []; // 重试直接吞掉，不产生第二笔
      const c = state.charges.get(cmd.chargeId);
      requireState(state, () => c, "账单不存在");
      if (c.status === "PAID") throw new Error("账单已支付，拒绝重复扣费");
      if (cmd.amount !== c.amount) throw new Error("支付金额与账单不符，请先做减免/调整");
      return [{ kind: "PAYMENT_TAKEN", occurred_at: now, payload: { request_id: cmd.request_id, chargeId: cmd.chargeId, amount: cmd.amount, at: now, result: cmd.result ?? "SUCCESS" } }];
    }

    case "applyDiscountOrAdjustment": {
      const c = state.charges.get(cmd.chargeId);
      requireState(state, () => c, "账单不存在");
      if (state.adjustments.some((a) => a.adjustmentId === cmd.adjustmentId)) return [];
      return [{ kind: "CHARGE_ADJUSTED", occurred_at: now, payload: { adjustmentId: cmd.adjustmentId, chargeId: cmd.chargeId, delta: cmd.delta, reason: cmd.reason, category: cmd.category ?? "DISCOUNT" } }];
    }

    default:
      throw new Error(`billing 聚合不认识命令 ${cmd.type}`);
  }
}
