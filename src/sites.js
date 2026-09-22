import { KINDS } from "./kinds.js";

export const SITE_SUBJECT = (siteId) => `site:${siteId}`;

function addMonths(iso, months) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

// 单个点位的状态投影。每个中心/社区点位是独立 subject，
// 某中心竣工延期只改写自己的事件流，不会波及已运营的其他点位。
export function siteProjection(events, rulebook, now) {
  const state = {
    completed_at: null, // 竣工时间
    opening_deadline: null, // 原则上竣工后一年内运营
    deadline_rule_version: null, // 期限依据的规则版本
    delayed: null,
    opened_at: null,
    status: "建设中",
  };
  for (const e of events) {
    switch (e.kind) {
      case KINDS.MILESTONE_REACHED:
        if (e.data.milestone === "竣工") {
          state.completed_at = e.occurred_at;
          const rule = rulebook.resolve("opening", e.occurred_at);
          state.opening_deadline = addMonths(e.occurred_at, rule.rules.grace_months);
          state.deadline_rule_version = rule.version;
        }
        break;
      case KINDS.OPENING_DELAYED:
        state.delayed = {
          reason: e.data.reason,
          expected_opening: e.data.expected_opening,
          at: e.occurred_at,
        };
        break;
      case KINDS.SITE_OPENED:
        state.opened_at = e.occurred_at;
        break;
    }
  }
  if (state.opened_at) state.status = "运营中";
  else if (state.opening_deadline && Date.parse(now) > Date.parse(state.opening_deadline)) {
    state.status = "逾期未运营";
  }
  else if (state.delayed) state.status = "延期";
  else if (state.completed_at) state.status = "待运营";
  return state;
}

// 市级统筹视角：逐点位独立投影，1+N 网络中任何一个中心的问题
// 都只影响它自己，社区嵌入式点位和用人单位办托照常运转。
export function portfolioView(store, rulebook, now) {
  const view = {};
  for (const subject of store.subjects()) {
    if (subject.startsWith("site:")) {
      view[subject] = siteProjection(store.of(subject), rulebook, now);
    }
  }
  return view;
}
