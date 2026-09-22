import assert from "node:assert/strict";
import test from "node:test";
import { accessData, canAccess, CHILD_SUBJECT, consentProjection, correctRecord, recordView } from "../src/consent.js";
import { KINDS } from "../src/kinds.js";
import { EventStore } from "../src/store.js";

const SUBJECT = CHILD_SUBJECT("child-1");

function buildStore() {
  const store = new EventStore();
  store.append({ event_id: "g1", kind: KINDS.CONSENT_GRANTED, occurred_at: "2026-09-01T09:00:00+08:00", subject_id: SUBJECT, version: 1, data: { consent_id: "k1", institution_id: "inst-1", data_class: "健康资料" } });
  return store;
}

test("仅承担服务的机构可调阅，未授权机构被拒绝", () => {
  const store = buildStore();
  const at = "2026-09-10T10:00:00+08:00";
  assert.equal(accessData(store, { childId: "child-1", institutionId: "inst-1", dataClass: "健康资料", at }).ok, true);
  const denied = accessData(store, { childId: "child-1", institutionId: "inst-2", dataClass: "健康资料", at });
  assert.equal(denied.ok, false);
  assert.equal(denied.event, null); // 拒绝不留调阅事件
});

test("撤回授权后停止共享，撤回前的历史调阅仍可审计", () => {
  const store = buildStore();
  accessData(store, { childId: "child-1", institutionId: "inst-1", dataClass: "健康资料", at: "2026-09-10T10:00:00+08:00" });
  store.append({ event_id: "rv1", kind: KINDS.CONSENT_REVOKED, occurred_at: "2026-09-20T09:00:00+08:00", subject_id: SUBJECT, version: store.nextVersion(SUBJECT), data: { consent_id: "k1" } });
  // 撤回后：新的调阅被拒绝
  assert.equal(accessData(store, { childId: "child-1", institutionId: "inst-1", dataClass: "健康资料", at: "2026-09-21T10:00:00+08:00" }).ok, false);
  // 但撤回时点之前的授权状态仍可还原（用于核对当时是否合规）
  assert.equal(canAccess(store.of(SUBJECT), "inst-1", "健康资料", "2026-09-10T10:00:00+08:00"), true);
  assert.equal(consentProjection(store.of(SUBJECT)).accessLog.length, 1);
});

test("已形成的记录不因撤回而抹去，只能追加更正", () => {
  const store = buildStore();
  store.append({ event_id: "rec1", kind: KINDS.RECORD_FORMED, occurred_at: "2026-09-15T10:00:00+08:00", subject_id: SUBJECT, version: store.nextVersion(SUBJECT), data: { record_id: "r1", kind: "安全记录", source_consent_id: "k1", content: "户外活动擦伤" } });
  store.append({ event_id: "rv1", kind: KINDS.CONSENT_REVOKED, occurred_at: "2026-09-20T09:00:00+08:00", subject_id: SUBJECT, version: store.nextVersion(SUBJECT), data: { consent_id: "k1" } });
  // 撤回后记录仍在
  const before = recordView(store.of(SUBJECT), "r1");
  assert.equal(before.formed.content, "户外活动擦伤");
  // 追加更正而非抹去
  const corrected = correctRecord(store, { childId: "child-1", recordId: "r1", correction: "实为室内活动擦伤", at: "2026-09-22T10:00:00+08:00" });
  assert.equal(corrected.ok, true);
  const after = recordView(store.of(SUBJECT), "r1");
  assert.equal(after.formed.content, "户外活动擦伤"); // 原记录保留
  assert.equal(after.corrections.length, 1);
  assert.equal(after.corrections[0].correction, "实为室内活动擦伤");
});

test("不存在的记录不能更正", () => {
  const store = buildStore();
  assert.equal(correctRecord(store, { childId: "child-1", recordId: "r-x", correction: "x", at: "2026-09-22T10:00:00+08:00" }).ok, false);
});
