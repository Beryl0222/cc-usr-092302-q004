import assert from "node:assert/strict";
import test from "node:test";
import { buildSystem, seedOperatingSite, ts, expectThrow } from "./helpers.js";
import { OfflineRelay } from "../src/relay.js";

test("断网签到：离线记录、乱序/重复回放，结算仍只认一次实际时段", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  sys.dispatch("child:K1", { type: "enrollChild", at: ts("2026-09-10"), childId: "K1", siteId: "N01", providerOrgId: "ORG-N01", packageType: "HOURLY", packageName: "计时托" });

  const relay = new OfflineRelay(sys.store);
  // 设备断网：先本地记下签到、签退（恢复网络后才回放）。
  relay.enqueue({ device_id: "PAD-7", client_seq: 1, subject_id: "child:K1", kind: "SERVICE_CHECKED_IN", occurred_at: ts("2026-09-15", "19:00:00"), payload: { sessionId: "SX", at: ts("2026-09-15", "19:00:00"), deviceId: "PAD-7" }, rule_version: 2 });
  relay.enqueue({ device_id: "PAD-7", client_seq: 2, subject_id: "child:K1", kind: "SERVICE_CHECKED_OUT", occurred_at: ts("2026-09-15", "21:40:00"), payload: { sessionId: "SX", at: ts("2026-09-15", "21:40:00") }, rule_version: 2 });
  // 网络抖动：同一批再记一遍（幂等键相同）。
  relay.enqueue({ device_id: "PAD-7", client_seq: 1, subject_id: "child:K1", kind: "SERVICE_CHECKED_IN", occurred_at: ts("2026-09-15", "19:00:00"), payload: { sessionId: "SX", at: ts("2026-09-15", "19:00:00"), deviceId: "PAD-7" }, rule_version: 2 });

  // 故意乱序回放（seq 2 先于 1）。
  const results = relay.flush((r) => -r.client_seq);
  assert.deepEqual(results.map((r) => r.status).sort(), ["applied", "applied", "duplicate"]);

  const child = sys.state("child:K1"); // 按业务时间折叠
  assert.equal(child.attendance.length, 1);
  assert.equal(child.openSessions.size, 0);
  assert.equal(child.attendance[0].minutes, 160);
});

test("监管回执乱序：先于整改到达被拒登记，整改后重复回执幂等，结论只在有效阶段产生", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  sys.dispatch("inspection:N01", { type: "openInspectionLedger", at: ts("2026-09-01"), siteId: "N01" });
  sys.dispatch("inspection:N01", { type: "openInspection", at: ts("2026-09-05"), caseId: "F1", category: "FIRE", scope: "疏散通道", inspector: "监督员甲" });
  sys.dispatch("inspection:N01", { type: "issueNotice", at: ts("2026-09-05"), caseId: "F1", findings: "通道堆物", deadline: "2026-09-12" });

  // 回执比整改先到（乱序）→ 拒绝，要求先整改。
  expectThrow(
    () => sys.dispatch("inspection:N01", { type: "recordReceipt", at: ts("2026-09-10"), caseId: "F1", receiptId: "RC1", accepted: true, conclusion: "整改通过" }),
    "RECEIPT_OUT_OF_ORDER",
  );

  // 机构提交整改。
  sys.dispatch("inspection:N01", { type: "submitRectification", at: ts("2026-09-11"), caseId: "F1", evidence: ["照片A", "照片B"] });
  // 监管回执到达（重复投递两次，同一 receipt_id）。
  sys.dispatch("inspection:N01", { type: "recordReceipt", at: ts("2026-09-12"), caseId: "F1", receiptId: "RC1", accepted: true, conclusion: "整改通过" });
  sys.dispatch("inspection:N01", { type: "recordReceipt", at: ts("2026-09-12", "09:05:00"), caseId: "F1", receiptId: "RC1", accepted: true, conclusion: "整改通过" });

  const c = sys.state("inspection:N01").cases.get("F1");
  assert.equal(c.status, "RECEIPTED");
  assert.equal(c.receipts.length, 1); // 重复回执只留一条
  assert.equal(c.conclusion, "整改通过");
  assert.equal(c.conclusionRuleVersion, 2);

  // 已归档方向不能回退：再次下通知不允许。
  expectThrow(() => sys.dispatch("inspection:N01", { type: "issueNotice", at: ts("2026-09-13"), caseId: "F1", findings: "x", deadline: "2026-09-20" }), "STAGE_GUARD");
  sys.dispatch("inspection:N01", { type: "closeInspection", at: ts("2026-09-13"), caseId: "F1" });
  assert.equal(sys.state("inspection:N01").cases.get("F1").status, "CLOSED");
});

test("打回后重新整改再回执，全过程只追加", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  sys.dispatch("inspection:N01", { type: "openInspectionLedger", at: ts("2026-09-01"), siteId: "N01" });
  sys.dispatch("inspection:N01", { type: "openInspection", at: ts("2026-09-05"), caseId: "FD1", category: "FOOD", scope: "留样", inspector: "乙" });
  sys.dispatch("inspection:N01", { type: "issueNotice", at: ts("2026-09-05"), caseId: "FD1", findings: "留样不足48小时", deadline: "2026-09-12" });
  sys.dispatch("inspection:N01", { type: "submitRectification", at: ts("2026-09-11"), caseId: "FD1", evidence: ["制度"] });
  sys.dispatch("inspection:N01", { type: "recordReceipt", at: ts("2026-09-12"), caseId: "FD1", receiptId: "RC-A", accepted: false, note: "照片不清晰" });
  assert.equal(sys.state("inspection:N01").cases.get("FD1").status, "REJECTED");
  sys.dispatch("inspection:N01", { type: "submitRectification", at: ts("2026-09-14"), caseId: "FD1", evidence: ["新照片"] });
  sys.dispatch("inspection:N01", { type: "recordReceipt", at: ts("2026-09-15"), caseId: "FD1", receiptId: "RC-B", accepted: true, conclusion: "整改通过" });
  const c = sys.state("inspection:N01").cases.get("FD1");
  assert.equal(c.status, "RECEIPTED");
  assert.ok(c.timeline.length >= 5);
});

test("人员调班：基于过期排班版本的调班被乐观并发拒绝", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  sys.dispatch("staff:N01", { type: "addStaff", at: ts("2026-09-01"), staffId: "T1", name: "王老师" });
  sys.dispatch("staff:N01", { type: "recordCredential", at: ts("2026-09-01"), staffId: "T1", credType: "保育员资格", validFrom: "2026-01-01", validTo: null });
  sys.dispatch("staff:N01", { type: "assignStaff", at: ts("2026-09-01"), staffId: "T1", date: "2026-09-20", session: "AM" });
  const v = sys.store.version("staff:N01"); // 负责人 A 读到版本 v

  // 负责人 B 先做了一次无关的排班变更（流版本前进），但没动 T1 的 AM 当班。
  sys.dispatch("staff:N01", { type: "addStaff", at: ts("2026-09-02"), staffId: "T2", name: "李老师" });
  sys.dispatch("staff:N01", { type: "recordCredential", at: ts("2026-09-02"), staffId: "T2", credType: "保育员资格", validFrom: "2026-01-01", validTo: null });
  sys.dispatch("staff:N01", { type: "assignStaff", at: ts("2026-09-03"), staffId: "T2", date: "2026-09-20", session: "AM" });

  // A 仍拿旧版本提交把 T1 调到 PM → 冲突，要求其重读最新排班后再决定。
  expectThrow(
    () => sys.dispatch("staff:N01", { type: "reassignStaff", at: ts("2026-09-04"), staffId: "T1", date: "2026-09-20", session: "AM", newSession: "PM" }, { expectedVersion: v }),
    "VERSION_CONFLICT",
  );

  // 重读后再调即可成功。
  sys.dispatch("staff:N01", { type: "reassignStaff", at: ts("2026-09-04", "11:00:00"), staffId: "T1", date: "2026-09-20", session: "AM", newSession: "PM" });
  const roster = sys.state("staff:N01");
  assert.ok(roster.assignments.some((a) => a.staffId === "T1" && a.session === "PM"));
  assert.ok(!roster.assignments.some((a) => a.staffId === "T1" && a.session === "AM"));
});
