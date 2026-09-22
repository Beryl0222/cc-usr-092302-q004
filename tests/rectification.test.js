import assert from "node:assert/strict";
import test from "node:test";
import { KINDS } from "../src/kinds.js";
import { caseProjection, CASE_SUBJECT } from "../src/rectification.js";
import { EventStore, explain } from "../src/store.js";

const SUBJECT = CASE_SUBJECT("case-1");

test("检查-整改-结论全流程，结论携带规则版本，回执乱序不影响", () => {
  const store = new EventStore();
  store.append({ event_id: "i1", kind: KINDS.INSPECTION_RECORDED, occurred_at: "2026-09-10T10:00:00+08:00", subject_id: SUBJECT, version: 1, data: { category: "消防", findings: "疏散通道堆物", rule_version: 3 } });
  store.append({ event_id: "r1", kind: KINDS.RECTIFICATION_REQUIRED, occurred_at: "2026-09-11T10:00:00+08:00", subject_id: SUBJECT, version: 2, data: { items: ["清理疏散通道"], deadline: "2026-09-25" } });
  // 监管回执（v4）先于整改结论（v3）到达
  store.append({ event_id: "rc1", kind: KINDS.SUPERVISION_RECEIPT, occurred_at: "2026-09-21T10:00:00+08:00", subject_id: SUBJECT, version: 4, data: { receipt_no: "JG-2026-091" } });
  store.append({ event_id: "c1", kind: KINDS.RECTIFICATION_CONCLUDED, occurred_at: "2026-09-20T10:00:00+08:00", subject_id: SUBJECT, version: 3, data: { conclusion: "整改到位", rule_version: 3 } });

  const state = caseProjection(store.of(SUBJECT));
  assert.equal(state.conclusion.conclusion, "整改到位");
  assert.equal(state.conclusion.rule_version, 3);
  assert.equal(state.receipts.length, 1);

  // 中心负责人可复查每个结论依据的规则版本
  const line = explain(store.of(SUBJECT));
  assert.deepEqual(line.map((e) => e.kind), [
    "INSPECTION_RECORDED",
    "RECTIFICATION_REQUIRED",
    "RECTIFICATION_CONCLUDED",
    "SUPERVISION_RECEIPT",
  ]);
  assert.equal(line.find((e) => e.kind === "RECTIFICATION_CONCLUDED").rule_version, 3);
});
