// 社区育儿活动（subject: activity:{siteId}）。
// 综合服务中心牵头、社区点位参与的活动与报名。
// 报名占活动名额；取消释放；活动是否开放也只取决于本主体，
// 不受其他点位竣工延期影响。

import { requireState } from "./util.js";

export function initial() {
  return { siteId: null, activities: new Map() };
}

function clone(s) {
  return { siteId: s.siteId, activities: new Map(Array.from(s.activities, ([k, a]) => [k, { ...a, signups: [...a.signups] }])) };
}

export function apply(state, e) {
  const p = e.payload;
  switch (e.kind) {
    case "ACTIVITY_LEDGER_OPENED":
      return { ...state, siteId: p.siteId };
    case "COMMUNITY_ACTIVITY_CREATED": {
      const s = clone(state);
      s.activities.set(p.activityId, { activityId: p.activityId, title: p.title, startAt: p.startAt, capacity: p.capacity, hostSiteId: p.hostSiteId, status: "OPEN", signups: [] });
      return s;
    }
    case "ACTIVITY_SIGNUP_ACCEPTED": {
      const s = clone(state);
      const a = s.activities.get(p.activityId);
      if (a && !a.signups.some((x) => x.childId === p.childId)) a.signups.push({ childId: p.childId, at: p.at, status: "SIGNED" });
      return s;
    }
    case "ACTIVITY_SIGNUP_CANCELLED": {
      const s = clone(state);
      const a = s.activities.get(p.activityId);
      if (a) for (const x of a.signups) if (x.childId === p.childId) x.status = "CANCELLED";
      return s;
    }
    case "COMMUNITY_ACTIVITY_CLOSED": {
      const s = clone(state);
      const a = s.activities.get(p.activityId);
      if (a) a.status = "CLOSED";
      return s;
    }
    default:
      return state;
  }
}

export function activityAvailability(state, activityId) {
  const a = state.activities.get(activityId);
  if (!a) return null;
  const held = a.signups.filter((x) => x.status === "SIGNED").length;
  return { capacity: a.capacity, held, available: a.capacity - held };
}

export function decide(state, cmd) {
  const now = cmd.at;
  switch (cmd.type) {
    case "openActivityLedger":
      requireState(state, (s) => s.siteId === null, "活动台账已开立");
      return [{ kind: "ACTIVITY_LEDGER_OPENED", occurred_at: now, payload: { siteId: cmd.siteId } }];
    case "createActivity": {
      if (state.activities.has(cmd.activityId)) throw new Error("活动已存在");
      if (!Number.isInteger(cmd.capacity) || cmd.capacity < 1) throw new Error("活动名额必须为正整数");
      return [{ kind: "COMMUNITY_ACTIVITY_CREATED", occurred_at: now, payload: { activityId: cmd.activityId, title: cmd.title, startAt: cmd.startAt, capacity: cmd.capacity, hostSiteId: cmd.hostSiteId ?? state.siteId } }];
    }
    case "signupActivity": {
      const a = state.activities.get(cmd.activityId);
      requireState(state, () => a, "活动不存在");
      if (a.status !== "OPEN") throw new Error("活动未开放报名");
      if (a.signups.some((x) => x.childId === cmd.childId && x.status === "SIGNED")) throw new Error("已报名，勿重复");
      const avail = activityAvailability(state, cmd.activityId);
      if (avail.available <= 0) throw new Error("活动名额已满");
      return [{ kind: "ACTIVITY_SIGNUP_ACCEPTED", occurred_at: now, payload: { activityId: cmd.activityId, childId: cmd.childId, at: now } }];
    }
    case "cancelSignup": {
      const a = state.activities.get(cmd.activityId);
      requireState(state, () => a, "活动不存在");
      if (!a.signups.some((x) => x.childId === cmd.childId && x.status === "SIGNED")) throw new Error("未查到有效报名");
      return [{ kind: "ACTIVITY_SIGNUP_CANCELLED", occurred_at: now, payload: { activityId: cmd.activityId, childId: cmd.childId } }];
    }
    case "closeActivity": {
      const a = state.activities.get(cmd.activityId);
      requireState(state, () => a, "活动不存在");
      return [{ kind: "COMMUNITY_ACTIVITY_CLOSED", occurred_at: now, payload: { activityId: cmd.activityId } }];
    }
    default:
      throw new Error(`activity 聚合不认识命令 ${cmd.type}`);
  }
}
