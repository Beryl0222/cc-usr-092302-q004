import assert from "node:assert/strict";
import test from "node:test";
import { EventStore, explain } from "../src/store.js";

const ev = (id, subject, version, kind = "CHECK_IN", at = "2026-09-22T10:00:00+08:00", data = {}) => ({
  event_id: id,
  kind,
  occurred_at: at,
  subject_id: subject,
  version,
  data,
});

test("重复 event_id 被忽略，事件只追加一次", () => {
  const store = new EventStore();
  assert.equal(store.append(ev("e1", "s", 1)), true);
  assert.equal(store.append(ev("e1", "s", 1)), false);
  assert.equal(store.of("s").length, 1);
});

test("乱序到达的事件按 version 还原顺序", () => {
  const store = new EventStore();
  store.append(ev("e3", "s", 3, "CHECK_OUT"));
  store.append(ev("e1", "s", 1));
  store.append(ev("e2", "s", 2));
  assert.deepEqual(store.of("s").map((e) => e.version), [1, 2, 3]);
});

test("不同 subject 各自排序互不影响", () => {
  const store = new EventStore();
  store.append(ev("b2", "site:B", 2));
  store.append(ev("a1", "site:A", 1));
  store.append(ev("b1", "site:B", 1));
  assert.deepEqual(store.of("site:A").map((e) => e.event_id), ["a1"]);
  assert.deepEqual(store.of("site:B").map((e) => e.event_id), ["b1", "b2"]);
});

test("缺字段的事件被拒绝", () => {
  const store = new EventStore();
  assert.throws(() => store.append({ event_id: "x" }), /缺少必填字段/);
});

test("explain 输出带规则版本的时间线", () => {
  const store = new EventStore();
  store.append(ev("e1", "s", 1, "BOOKING_PLACED", "2026-09-22T10:00:00+08:00", { rule_version: 2 }));
  const line = explain(store.of("s"));
  assert.equal(line[0].rule_version, 2);
  assert.equal(line[0].kind, "BOOKING_PLACED");
});
