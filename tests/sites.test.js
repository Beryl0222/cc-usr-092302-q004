import assert from "node:assert/strict";
import test from "node:test";
import { KINDS } from "../src/kinds.js";
import { RuleBook } from "../src/rules.js";
import { portfolioView, siteProjection, SITE_SUBJECT } from "../src/sites.js";
import { EventStore } from "../src/store.js";

const NOW = "2026-09-22T12:00:00+08:00";

function rulebook() {
  return new RuleBook().publish("opening", 1, "2025-01-01T00:00:00+08:00", { grace_months: 12 });
}

const ev = (id, subject, version, kind, at, data = {}) => ({
  event_id: id, kind, occurred_at: at, subject_id: subject, version, data,
});

test("竣工后一年未运营标记为逾期未运营，期限带规则版本", () => {
  const rb = rulebook();
  const events = [
    ev("a1", SITE_SUBJECT("center-1"), 1, KINDS.MILESTONE_REACHED, "2025-06-01T10:00:00+08:00", { milestone: "竣工" }),
    ev("a2", SITE_SUBJECT("center-1"), 2, KINDS.OPENING_DELAYED, "2026-05-01T10:00:00+08:00", { reason: "验收整改", expected_opening: "2026-12-01" }),
  ];
  const s = siteProjection(events, rb, NOW);
  assert.equal(s.status, "逾期未运营");
  assert.equal(s.opening_deadline, "2026-06-01T02:00:00.000Z"); // 即北京时间 2026-06-01 10:00
  assert.equal(s.deadline_rule_version, 1);
});

test("某中心延期不影响已运营的社区点位", () => {
  const rb = rulebook();
  const store = new EventStore();
  // 中心：竣工后延期
  store.append(ev("c1", SITE_SUBJECT("center-1"), 1, KINDS.MILESTONE_REACHED, "2025-06-01T10:00:00+08:00", { milestone: "竣工" }));
  store.append(ev("c2", SITE_SUBJECT("center-1"), 2, KINDS.OPENING_DELAYED, "2026-05-01T10:00:00+08:00", { reason: "验收整改" }));
  // 社区嵌入式点位：已运营
  store.append(ev("s1", SITE_SUBJECT("site-2"), 1, KINDS.MILESTONE_REACHED, "2026-01-10T10:00:00+08:00", { milestone: "竣工" }));
  store.append(ev("s2", SITE_SUBJECT("site-2"), 2, KINDS.SITE_OPENED, "2026-02-01T09:00:00+08:00", {}));

  const view = portfolioView(store, rb, NOW);
  assert.equal(view[SITE_SUBJECT("center-1")].status, "逾期未运营");
  // 已运营点位照常运转，不随中心停摆
  assert.equal(view[SITE_SUBJECT("site-2")].status, "运营中");
  assert.equal(view[SITE_SUBJECT("site-2")].delayed, null);
});
