import assert from "node:assert/strict";
import test from "node:test";
import { KINDS } from "../src/kinds.js";
import { activityLog, packageProjection, referralProjection } from "../src/operations.js";
import { EventStore } from "../src/store.js";

test("签约服务包取最新一份，活动与转介有序留痕", () => {
  const store = new EventStore();
  store.append({ event_id: "p1", kind: KINDS.PACKAGE_SIGNED, occurred_at: "2026-03-01T10:00:00+08:00", subject_id: "child:c1", version: 1, data: { package: "全日托基础包" } });
  store.append({ event_id: "p2", kind: KINDS.PACKAGE_SIGNED, occurred_at: "2026-09-01T10:00:00+08:00", subject_id: "child:c1", version: 2, data: { package: "全日托+健康包" } });
  assert.equal(packageProjection(store.of("child:c1")).current.package, "全日托+健康包");

  store.append({ event_id: "a1", kind: KINDS.ACTIVITY_HELD, occurred_at: "2026-09-20T10:00:00+08:00", subject_id: "site:s2", version: 1, data: { theme: "亲子阅读", participants: 18 } });
  assert.equal(activityLog(store.of("site:s2")).length, 1);

  store.append({ event_id: "rf1", kind: KINDS.REFERRAL_MADE, occurred_at: "2026-09-21T10:00:00+08:00", subject_id: "child:c1", version: 3, data: { from: "inst-1", to: "inst-2", reason: "听力筛查异常转介" } });
  assert.equal(referralProjection(store.of("child:c1")).latest.to, "inst-2");
});
