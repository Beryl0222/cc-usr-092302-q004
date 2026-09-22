import assert from "node:assert/strict";
import test from "node:test";
import { buildSystem, seedOperatingSite, ts, expectThrow } from "./helpers.js";
import { balance } from "../src/domain/billing.js";

function enroll(sys, { siteId = "N01", childId = "K1", orgId = "ORG-N01", at = ts("2026-09-10") } = {}) {
  sys.dispatch(`child:${childId}`, { type: "enrollChild", at, childId, siteId, providerOrgId: orgId, packageType: "HOURLY", packageName: "计时托" });
  sys.dispatch(`billing:${childId}`, { type: "openBilling", at, childId });
  return childId;
}

test("计时托跨午夜按实际服务时段结算（含夜间附加，盖当时规则版本）", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  const childId = enroll(sys, { childId: "K1" });

  // 21:00 签到，次日 01:30 签退 → 270 分钟；30 分钟一块 = 9 块 × 35 + 10 夜间 = 325 元。
  sys.dispatch("child:K1", { type: "checkIn", at: ts("2026-09-15", "21:00:00"), sessionId: "S1", bookingId: "B1" });
  sys.dispatch("child:K1", { type: "checkOut", at: ts("2026-09-16", "01:30:00"), sessionId: "S1" });

  const att = sys.state("child:K1").attendance[0];
  assert.equal(att.minutes, 270);
  assert.equal(att.crossMidnight, true);

  const calc = sys.settleHourlySession("K1", { sessionId: "S1", chargeId: "CHG1", at: ts("2026-09-16", "09:00:00") });
  assert.equal(calc.amount, 325);
  assert.equal(calc.crossMidnight, true);

  const chg = sys.state("billing:K1").charges.get("CHG1");
  assert.equal(chg.amount, 325);
  assert.equal(chg.minutes, 270);
  assert.equal(chg.ruleVersion, 2); // 9 月适用 v2
});

test("计时托改期后按实际发生时段结算，原预约保留可溯", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  sys.dispatch("catalog:N01", { type: "defineOffering", at: ts("2026-09-10"), offeringId: "HOUR1", offeringType: "HOURLY", name: "计时托", dailyCapacity: 5 });
  // 原约 9-10 点。
  sys.dispatch("catalog:N01", { type: "reserveSeat", at: ts("2026-09-10"), bookingId: "B2", childId: "K2", offeringId: "HOUR1", offeringType: "HOURLY", date: "2026-09-20", plannedStart: ts("2026-09-20", "09:00:00"), plannedEnd: ts("2026-09-20", "10:00:00") });
  // 改期到当天 14-16 点。
  sys.dispatch("catalog:N01", { type: "rescheduleBooking", at: ts("2026-09-18"), bookingId: "B2", plannedStart: ts("2026-09-20", "14:00:00"), plannedEnd: ts("2026-09-20", "16:00:00"), reason: "家长改时间" });

  const booking = sys.state("catalog:N01").bookings.get("B2");
  assert.equal(booking.plannedStart, ts("2026-09-20", "14:00:00"));
  assert.equal(booking.history.length, 2); // RESERVED + RESCHEDULED，原事实不丢

  enroll(sys, { childId: "K2" });
  // 实际 14:00-16:10 → 130 分钟，30 分钟一块向上取整 = 5 块 × 35 = 175。
  sys.dispatch("child:K2", { type: "checkIn", at: ts("2026-09-20", "14:00:00"), sessionId: "S2", bookingId: "B2" });
  sys.dispatch("child:K2", { type: "checkOut", at: ts("2026-09-20", "16:10:00"), sessionId: "S2" });
  const calc = sys.settleHourlySession("K2", { sessionId: "S2", chargeId: "CHG2", at: ts("2026-09-20", "18:00:00") });
  assert.equal(calc.minutes, 130);
  assert.equal(calc.blocks, 5);
  assert.equal(calc.amount, 175);
});

test("同一 request_id 重复扣费只收一次", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  enroll(sys, { childId: "K3" });
  sys.dispatch("billing:K3", { type: "raiseCharge", at: ts("2026-09-16"), chargeId: "CHG3", kind: "FULL", amount: 2200, period: "2026-09" });

  // 家长点了两次 / 网络重试。
  const pay = { type: "takePayment", at: ts("2026-09-16"), chargeId: "CHG3", amount: 2200, request_id: "REQ-77" };
  sys.dispatch("billing:K3", pay);
  sys.dispatch("billing:K3", pay); // 幂等吞掉

  const b = sys.state("billing:K3");
  assert.equal(b.payments.length, 1);
  assert.equal(b.charges.get("CHG3").status, "PAID");
  // 第三次换 request_id 再来 → 账单已支付，明确拒绝。
  expectThrow(() => sys.dispatch("billing:K3", { ...pay, request_id: "REQ-78" }), "DOMAIN_REJECTED");
});

test("收费减免只追加调整，不抹改原账单", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  enroll(sys, { childId: "K4" });
  sys.dispatch("billing:K4", { type: "raiseCharge", at: ts("2026-09-16"), chargeId: "CHG4", kind: "FULL", amount: 2200, period: "2026-09" });
  sys.dispatch("billing:K4", { type: "applyDiscountOrAdjustment", at: ts("2026-09-17"), adjustmentId: "ADJ1", chargeId: "CHG4", delta: -500, reason: "低保家庭减免", category: "FEE_WAIVER" });
  const b = sys.state("billing:K4");
  assert.equal(b.charges.get("CHG4").amount, 2200); // 原账单不变
  assert.equal(b.adjustments.length, 1);
  assert.equal(balance(b).due, 1700);
});
