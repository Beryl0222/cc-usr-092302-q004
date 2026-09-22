import assert from "node:assert/strict";
import test from "node:test";
import { buildSystem, seedOperatingSite, ts, expectThrow, views } from "./helpers.js";

function staffed(sys, siteId, date, staffIds) {
  for (let i = 0; i < staffIds.length; i++) {
    const id = staffIds[i];
    sys.dispatch(`staff:${siteId}`, { type: "addStaff", at: ts("2026-09-01"), staffId: id, name: id });
    sys.dispatch(`staff:${siteId}`, { type: "recordCredential", at: ts("2026-09-01"), staffId: id, credType: "保育员资格", validFrom: "2026-01-01", validTo: null });
    sys.dispatch(`staff:${siteId}`, { type: "assignStaff", at: ts("2026-09-01"), staffId: id, date, session: "AM" });
  }
}

test("家庭端展示真实可预约状态：运营状态、容量、持证保育配备三者同时满足", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  const date = "2026-09-20";
  sys.dispatch("catalog:N01", { type: "defineOffering", at: ts("2026-09-10"), offeringId: "FULL1", offeringType: "FULL", name: "全日托", dailyCapacity: 2 });
  sys.dispatch("catalog:N01", { type: "defineOffering", at: ts("2026-09-10"), offeringId: "HALF1", offeringType: "HALF", name: "半日托", dailyCapacity: 4, sessions: ["AM", "PM"] });

  // v2 要求每时段 2 名持证保育员。只配 1 人 → 全部不可约。
  staffed(sys, "N01", date, ["T1"]);
  let v = views(sys).familyAvailability("N01", date);
  assert.equal(v.rows.every((r) => r.bookable === false), true);
  assert.ok(v.rows[0].reasons.some((r) => r.includes("持证保育人员不足")));

  // 配齐 2 人。
  staffed(sys, "N01", date, ["T2"]);
  v = views(sys).familyAvailability("N01", date);
  const full = v.rows.find((r) => r.type === "FULL");
  assert.equal(full.bookable, true);
  assert.equal(full.available, 2);

  // 占满两个全日托名额 → 不可超售，视图实时变 0。
  sys.dispatch("catalog:N01", { type: "reserveSeat", at: ts("2026-09-11"), bookingId: "B1", childId: "K1", offeringId: "FULL1", offeringType: "FULL", date });
  sys.dispatch("catalog:N01", { type: "reserveSeat", at: ts("2026-09-11"), bookingId: "B2", childId: "K2", offeringId: "FULL1", offeringType: "FULL", date });
  v = views(sys).familyAvailability("N01", date);
  assert.equal(v.rows.find((r) => r.type === "FULL").available, 0);
  expectThrow(
    () => sys.dispatch("catalog:N01", { type: "reserveSeat", at: ts("2026-09-11"), bookingId: "B3", childId: "K3", offeringId: "FULL1", offeringType: "FULL", date }),
    "DOMAIN_REJECTED",
  );

  // 取消一个 → 名额立即释放回真实可约。
  sys.dispatch("catalog:N01", { type: "releaseSeat", at: ts("2026-09-12"), bookingId: "B2", reason: "CANCELLED" });
  v = views(sys).familyAvailability("N01", date);
  assert.equal(v.rows.find((r) => r.type === "FULL").available, 1);
});

test("点位停整时家庭端显式不可约，恢复后可约；其他点位不受影响", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  seedOperatingSite(sys, { siteId: "N02" });
  for (const siteId of ["N01", "N02"]) {
    sys.dispatch(`catalog:${siteId}`, { type: "defineOffering", at: ts("2026-09-10"), offeringId: "FULL1", offeringType: "FULL", name: "全日托", dailyCapacity: 3 });
    staffed(sys, siteId, "2026-09-20", ["T1", "T2"]);
  }
  sys.dispatch("site:N01", { type: "suspendSite", at: ts("2026-09-18"), reason: "消防整改" });
  assert.equal(views(sys).familyAvailability("N01", "2026-09-20").rows[0].bookable, false);
  assert.equal(views(sys).familyAvailability("N02", "2026-09-20").rows[0].bookable, true);
  sys.dispatch("site:N01", { type: "resumeSite", at: ts("2026-09-25") });
  assert.equal(views(sys).familyAvailability("N01", "2026-09-20").rows[0].bookable, true);
});

test("规则版本溯源：能说出名额、照护决定、整改结论各基于哪一版规则", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });

  // 8 月（v1 时代）的一个名额。
  sys.dispatch("catalog:N01", { type: "defineOffering", at: ts("2026-08-10"), offeringId: "FULL1", offeringType: "FULL", name: "全日托", dailyCapacity: 2 });
  sys.dispatch("catalog:N01", { type: "reserveSeat", at: ts("2026-08-15"), bookingId: "B-OLD", childId: "K9", offeringId: "FULL1", offeringType: "FULL", date: "2026-08-25" });
  // 9 月（v2）的一个名额。
  sys.dispatch("catalog:N01", { type: "reserveSeat", at: ts("2026-09-15"), bookingId: "B-NEW", childId: "K8", offeringId: "FULL1", offeringType: "FULL", date: "2026-09-25" });

  const prov = views(sys).ruleProvenance("catalog:N01");
  const reserved = prov.filter((p) => p.kind === "SEAT_RESERVED");
  assert.equal(reserved[0].rule_version, 1);
  assert.equal(reserved[0].rule.note, "初版运营规则");
  assert.equal(reserved[1].rule_version, 2);
  assert.equal(reserved[1].rule.rules.min_caregivers_per_session, 2);

  // 整改结论溯源。
  sys.dispatch("inspection:N01", { type: "openInspectionLedger", at: ts("2026-09-01"), siteId: "N01" });
  sys.dispatch("inspection:N01", { type: "openInspection", at: ts("2026-09-05"), caseId: "I1", category: "INJURY_PREVENTION", scope: "家具倒角", inspector: "丙" });
  sys.dispatch("inspection:N01", { type: "issueNotice", at: ts("2026-09-05"), caseId: "I1", findings: "柜角无防撞", deadline: "2026-09-12" });
  sys.dispatch("inspection:N01", { type: "submitRectification", at: ts("2026-09-11"), caseId: "I1", evidence: ["防撞条"] });
  sys.dispatch("inspection:N01", { type: "recordReceipt", at: ts("2026-09-12"), caseId: "I1", receiptId: "R1", accepted: true, conclusion: "整改通过" });
  const ip = views(sys).ruleProvenance("inspection:N01");
  assert.equal(ip.find((p) => p.kind === "RECTIFICATION_RECEIPTED").rule_version, 2);
});
