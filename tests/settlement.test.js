import assert from "node:assert/strict";
import test from "node:test";
import { KINDS } from "../src/kinds.js";
import { RuleBook } from "../src/rules.js";
import { SESSION_SUBJECT, sessionProjection, settleAndIssue, settleSession } from "../src/settlement.js";
import { EventStore } from "../src/store.js";

const SUBJECT = SESSION_SUBJECT("s1");

// 费率规则跨版本：9 月 23 日起涨价，用来验证跨午夜分段各自适用当时版本
function rulebook() {
  return new RuleBook()
    .publish("hourly_fee", 1, "2026-01-01T00:00:00+08:00", { rate_per_hour: 30 })
    .publish("hourly_fee", 2, "2026-09-23T00:00:00+08:00", { rate_per_hour: 40 });
}

function buildStore() {
  const store = new EventStore();
  // 计划上午，改期到下午——但结算只看实际签到签退
  store.append({ event_id: "sch", kind: KINDS.SESSION_SCHEDULED, occurred_at: "2026-09-20T10:00:00+08:00", subject_id: SUBJECT, version: 1, data: { planned_start: "2026-09-22T09:00:00+08:00", planned_end: "2026-09-22T12:00:00+08:00" } });
  store.append({ event_id: "rsch", kind: KINDS.SESSION_RESCHEDULED, occurred_at: "2026-09-21T10:00:00+08:00", subject_id: SUBJECT, version: 2, data: { planned_start: "2026-09-22T14:00:00+08:00", planned_end: "2026-09-22T18:00:00+08:00" } });
  // 断网补传：签退（v4）先于签到（v3）到达
  store.append({ event_id: "out", kind: KINDS.CHECK_OUT, occurred_at: "2026-09-23T08:00:00+08:00", subject_id: SUBJECT, version: 4, data: { at: "2026-09-23T01:30:00+08:00", offline: true } });
  store.append({ event_id: "in", kind: KINDS.CHECK_IN, occurred_at: "2026-09-23T07:30:00+08:00", subject_id: SUBJECT, version: 3, data: { at: "2026-09-22T22:00:00+08:00", offline: true } });
  store.append({ event_id: "waiver", kind: KINDS.WAIVER_GRANTED, occurred_at: "2026-09-22T09:00:00+08:00", subject_id: SUBJECT, version: 5, data: { percent: 50, reason: "低保家庭减免" } });
  return store;
}

test("跨午夜按实际服务时段分段结算，各段适用当时费率版本", () => {
  const store = buildStore();
  const { segments, charges } = settleSession(store.of(SUBJECT), rulebook());
  assert.equal(segments.length, 2);
  // 第一段 22:00-24:00 用 v1 费率 30：2h×30=60，减免 50% 后 30
  assert.deepEqual(
    charges.map((c) => [c.segment_date, c.hours, c.amount, c.rule_version]),
    [["2026-09-22", 2, 30, 1], ["2026-09-23", 1.5, 30, 2]],
  );
});

test("乱序补传的签到签退不影响结算结论", () => {
  const store = buildStore();
  const s = sessionProjection(store.of(SUBJECT));
  assert.equal(s.check_in, "2026-09-22T22:00:00+08:00");
  assert.equal(s.check_out, "2026-09-23T01:30:00+08:00");
});

test("重复执行结算不会重复扣费", () => {
  const store = buildStore();
  const rb = rulebook();
  const first = settleAndIssue(store, "s1", rb, "2026-09-23T09:00:00+08:00");
  assert.equal(first.length, 2);
  const second = settleAndIssue(store, "s1", rb, "2026-09-23T10:00:00+08:00");
  assert.equal(second.length, 0);
  const total = sessionProjection(store.of(SUBJECT)).charges.reduce((sum, c) => sum + c.amount, 0);
  assert.equal(total, 60);
});

test("同一时段的重复扣费事件被去重", () => {
  const store = buildStore();
  const rb = rulebook();
  settleAndIssue(store, "s1", rb, "2026-09-23T09:00:00+08:00");
  // 上游系统用另一个 event_id 重复上报同一时段扣费
  store.append({
    event_id: "charge:dup",
    kind: KINDS.CHARGE_ISSUED,
    occurred_at: "2026-09-23T09:05:00+08:00",
    subject_id: SUBJECT,
    version: store.nextVersion(SUBJECT),
    data: { charge_id: `${SUBJECT}:2026-09-22`, segment_date: "2026-09-22", hours: 2, gross: 60, discount: 30, amount: 30, rule_version: 1 },
  });
  const charges = sessionProjection(store.of(SUBJECT)).charges;
  assert.equal(charges.filter((c) => c.charge_id === `${SUBJECT}:2026-09-22`).length, 1);
});
