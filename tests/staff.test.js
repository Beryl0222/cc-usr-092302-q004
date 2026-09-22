import assert from "node:assert/strict";
import test from "node:test";
import { KINDS } from "../src/kinds.js";
import { RuleBook } from "../src/rules.js";
import { isQualified, staffProjection, STAFF_SUBJECT } from "../src/staff.js";
import { EventStore } from "../src/store.js";

const SUBJECT = STAFF_SUBJECT("staff-1");

test("调班乱序到达时以最高版本为准", () => {
  const store = new EventStore();
  // 晚到的 v2 先入库，早先的 v1 后补传
  store.append({ event_id: "sh2", kind: KINDS.SHIFT_ASSIGNED, occurred_at: "2026-09-22T08:00:00+08:00", subject_id: SUBJECT, version: 2, data: { date: "2026-09-23", shift: "晚班" } });
  store.append({ event_id: "sh1", kind: KINDS.SHIFT_ASSIGNED, occurred_at: "2026-09-21T08:00:00+08:00", subject_id: SUBJECT, version: 1, data: { date: "2026-09-23", shift: "早班" } });
  assert.equal(staffProjection(store.of(SUBJECT)).shift.shift, "晚班");
});

test("资质按培训规则版本与证书有效期核验", () => {
  const store = new EventStore();
  store.append({ event_id: "t1", kind: KINDS.STAFF_TRAINED, occurred_at: "2026-03-01T10:00:00+08:00", subject_id: SUBJECT, version: 1, data: { certificate: "保育师", valid_until: "2027-01-01" } });
  const rb = new RuleBook().publish("training", 1, "2026-01-01T00:00:00+08:00", { required: { 保育员: "保育师" } });
  assert.equal(isQualified(store.of(SUBJECT), rb, "保育员", "2026-09-22"), true);
  assert.equal(isQualified(store.of(SUBJECT), rb, "保育员", "2027-06-01"), false); // 证书已过期
});
