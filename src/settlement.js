import { KINDS } from "./kinds.js";
import { splitByLocalDay } from "./time.js";

export const SESSION_SUBJECT = (sessionId) => `session:${sessionId}`;

const round2 = (n) => Math.round(n * 100) / 100;

// 计时托会话投影。签到/签退可能断网补传、乱序到达，
// 以事件 data.at 的实际时刻为准：签到取最早、签退取最晚。
export function sessionProjection(events) {
  const state = {
    planned: null, // 计划时段（改期只影响它，不影响结算口径）
    check_in: null,
    check_out: null,
    waiver: null, // 收费减免
    charges: [], // 已出具扣费，按 charge_id 去重
  };
  for (const e of events) {
    switch (e.kind) {
      case KINDS.SESSION_SCHEDULED:
      case KINDS.SESSION_RESCHEDULED:
        state.planned = e.data;
        break;
      case KINDS.CHECK_IN:
        if (!state.check_in || e.data.at < state.check_in) state.check_in = e.data.at;
        break;
      case KINDS.CHECK_OUT:
        if (!state.check_out || e.data.at > state.check_out) state.check_out = e.data.at;
        break;
      case KINDS.WAIVER_GRANTED:
        state.waiver = e.data;
        break;
      case KINDS.CHARGE_ISSUED:
        if (!state.charges.some((c) => c.charge_id === e.data.charge_id)) {
          state.charges.push(e.data);
        }
        break;
    }
  }
  return state;
}

// 结算口径：按实际服务时段（签到至签退），跨午夜按本地零点拆段，
// 每段适用该段开始时刻生效的费率版本，再扣减免。
// 改期只改计划时段，结算永远以实际签到签退为准。
export function settleSession(events, rulebook) {
  const s = sessionProjection(events);
  if (!s.check_in || !s.check_out) return { segments: [], charges: [] };
  const sessionId = events[0]?.subject_id ?? "session:unknown";
  const segments = splitByLocalDay(s.check_in, s.check_out);
  const charges = segments.map((seg) => {
    const rule = rulebook.resolve("hourly_fee", seg.start);
    const gross = round2(seg.hours * rule.rules.rate_per_hour);
    const discount = s.waiver ? round2((gross * s.waiver.percent) / 100) : 0;
    return {
      charge_id: `${sessionId}:${seg.date}`, // 幂等键：同一时段只结算一次
      segment_date: seg.date,
      hours: round2(seg.hours),
      gross,
      discount,
      amount: round2(gross - discount),
      rule_version: rule.version,
    };
  });
  return { segments, charges };
}

// 出具扣费：已结算过的时段跳过，重复执行不会重复扣费。
export function settleAndIssue(store, sessionId, rulebook, at) {
  const subject = SESSION_SUBJECT(sessionId);
  const events = store.of(subject);
  const { charges } = settleSession(events, rulebook);
  const issued = new Set(
    sessionProjection(events).charges.map((c) => c.charge_id),
  );
  const appended = [];
  for (const charge of charges) {
    if (issued.has(charge.charge_id)) continue;
    const event = {
      event_id: `charge:${charge.charge_id}`,
      kind: KINDS.CHARGE_ISSUED,
      occurred_at: at,
      subject_id: subject,
      version: store.nextVersion(subject),
      data: charge,
    };
    store.append(event);
    appended.push(event);
  }
  return appended;
}
