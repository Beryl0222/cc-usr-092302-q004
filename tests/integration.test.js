import assert from "node:assert/strict";
import test from "node:test";
import { accessData } from "../src/consent.js";
import { KINDS } from "../src/kinds.js";
import { caseProjection, CASE_SUBJECT } from "../src/rectification.js";
import { RuleBook } from "../src/rules.js";
import { settleAndIssue, sessionProjection, SESSION_SUBJECT } from "../src/settlement.js";
import { portfolioView, SITE_SUBJECT } from "../src/sites.js";
import { availability, placeBooking } from "../src/slots.js";
import { EventStore, explain } from "../src/store.js";

const NOW = "2026-09-22T12:00:00+08:00";

// 综合场景：中心延期、社区点照常预约、计时托跨午夜结算、
// 授权撤回、整改结论——全部落在同一事件存储上。
function buildWorld() {
  const store = new EventStore();
  const rb = new RuleBook()
    .publish("opening", 1, "2025-01-01T00:00:00+08:00", { grace_months: 12 })
    .publish("booking", 1, "2026-01-01T00:00:00+08:00", { max_per_child: 1 })
    .publish("hourly_fee", 1, "2026-01-01T00:00:00+08:00", { rate_per_hour: 30 })
    .publish("hourly_fee", 2, "2026-09-23T00:00:00+08:00", { rate_per_hour: 40 });

  // 综合服务中心：竣工后延期，超过一年期限
  store.append({ event_id: "m1", kind: KINDS.MILESTONE_REACHED, occurred_at: "2025-06-01T10:00:00+08:00", subject_id: SITE_SUBJECT("center-1"), version: 1, data: { milestone: "竣工" } });
  store.append({ event_id: "d1", kind: KINDS.OPENING_DELAYED, occurred_at: "2026-05-01T10:00:00+08:00", subject_id: SITE_SUBJECT("center-1"), version: 2, data: { reason: "消防复验", expected_opening: "2026-12-01" } });

  // 社区嵌入式点位：已运营，全日托 1 个名额
  store.append({ event_id: "m2", kind: KINDS.MILESTONE_REACHED, occurred_at: "2026-01-10T10:00:00+08:00", subject_id: SITE_SUBJECT("site-2"), version: 1, data: { milestone: "竣工" } });
  store.append({ event_id: "o2", kind: KINDS.SITE_OPENED, occurred_at: "2026-02-01T09:00:00+08:00", subject_id: SITE_SUBJECT("site-2"), version: 2, data: {} });
  store.append({ event_id: "cap", kind: KINDS.CAPACITY_SET, occurred_at: "2026-09-20T09:00:00+08:00", subject_id: SITE_SUBJECT("site-2"), version: 3, data: { date: "2026-09-23", class_type: "全日托", capacity: 1 } });
  return { store, rb };
}

test("中心延期不停摆社区点位，家庭看到真实名额", () => {
  const { store, rb } = buildWorld();
  const view = portfolioView(store, rb, NOW);
  assert.equal(view[SITE_SUBJECT("center-1")].status, "逾期未运营");
  assert.equal(view[SITE_SUBJECT("site-2")].status, "运营中");

  // 家庭预约走社区点位，成功后名额立即反映为约满
  const placed = placeBooking(store, rb, { siteId: "site-2", bookingId: "bk-1", childId: "child-1", classType: "全日托", date: "2026-09-23", at: NOW });
  assert.equal(placed.ok, true);
  const day = availability(store.of(SITE_SUBJECT("site-2")), "2026-09-23").find((a) => a.class_type === "全日托");
  assert.equal(day.bookable, false);
});

test("计时托跨午夜结算、授权撤回、整改结论都可溯源到规则版本", () => {
  const { store, rb } = buildWorld();
  placeBooking(store, rb, { siteId: "site-2", bookingId: "bk-1", childId: "child-1", classType: "全日托", date: "2026-09-23", at: NOW });

  // 计时托：实际 22:00 至次日 01:30，断网补传乱序到达
  const session = SESSION_SUBJECT("sess-1");
  store.append({ event_id: "co", kind: KINDS.CHECK_OUT, occurred_at: "2026-09-23T08:00:00+08:00", subject_id: session, version: 2, data: { at: "2026-09-23T01:30:00+08:00", offline: true } });
  store.append({ event_id: "ci", kind: KINDS.CHECK_IN, occurred_at: "2026-09-23T07:00:00+08:00", subject_id: session, version: 1, data: { at: "2026-09-22T22:00:00+08:00", offline: true } });
  settleAndIssue(store, "sess-1", rb, "2026-09-23T09:00:00+08:00");
  settleAndIssue(store, "sess-1", rb, "2026-09-23T10:00:00+08:00"); // 重复结算不重复扣费
  const charges = sessionProjection(store.of(session)).charges;
  assert.equal(charges.length, 2);
  assert.equal(charges.reduce((s, c) => s + c.amount, 0), 120); // 2h×30 + 1.5h×40

  // 家长授权后撤回：撤回后机构调阅被拒
  store.append({ event_id: "g1", kind: KINDS.CONSENT_GRANTED, occurred_at: "2026-09-01T09:00:00+08:00", subject_id: "child:child-1", version: 1, data: { consent_id: "k1", institution_id: "inst-1", data_class: "健康资料" } });
  store.append({ event_id: "rv1", kind: KINDS.CONSENT_REVOKED, occurred_at: "2026-09-20T09:00:00+08:00", subject_id: "child:child-1", version: 2, data: { consent_id: "k1" } });
  assert.equal(accessData(store, { childId: "child-1", institutionId: "inst-1", dataClass: "健康资料", at: NOW }).ok, false);

  // 消防检查整改结论
  const kase = CASE_SUBJECT("case-1");
  store.append({ event_id: "i1", kind: KINDS.INSPECTION_RECORDED, occurred_at: "2026-09-10T10:00:00+08:00", subject_id: kase, version: 1, data: { category: "消防", findings: "疏散通道堆物", rule_version: 3 } });
  store.append({ event_id: "c1", kind: KINDS.RECTIFICATION_CONCLUDED, occurred_at: "2026-09-20T10:00:00+08:00", subject_id: kase, version: 2, data: { conclusion: "整改到位", rule_version: 3 } });
  assert.equal(caseProjection(store.of(kase)).conclusion.rule_version, 3);

  // 负责人溯源：名额、扣费、整改结论各自基于哪一版规则
  const bookingLine = explain(store.of(SITE_SUBJECT("site-2"))).find((e) => e.kind === "BOOKING_PLACED");
  assert.equal(bookingLine.rule_version, 1);
  const chargeLine = explain(store.of(session)).filter((e) => e.kind === "CHARGE_ISSUED");
  assert.deepEqual(chargeLine.map((e) => e.rule_version), [1, 2]);
  const caseLine = explain(store.of(kase)).find((e) => e.kind === "RECTIFICATION_CONCLUDED");
  assert.equal(caseLine.rule_version, 3);
});
