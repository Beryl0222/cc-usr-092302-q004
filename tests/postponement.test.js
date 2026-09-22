import assert from "node:assert/strict";
import test from "node:test";
import { buildSystem, views, seedOperatingSite, ts, expectThrow } from "./helpers.js";

// 竣工延期的爆炸半径 + 竣工后一年内运营 + 1+N 网络不被连带停摆。
test("某中心竣工延期只影响本中心，社区点位照常运营", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "C1", kind: "CENTER", completion: "2026-02-01", open: "2026-02-10" });
  seedOperatingSite(sys, { siteId: "N01", kind: "COMMUNITY" });
  seedOperatingSite(sys, { siteId: "E01", kind: "EMPLOYER" });

  // 在建的第二中心申报延期。
  sys.dispatch("site:C2", { type: "registerSite", at: ts("2026-03-01"), id: "C2", city: "示例市", name: "第二中心", kind: "CENTER", plannedCompletion: "2026-06-01" });
  sys.dispatch("site:C2", { type: "postponeCompletion", at: ts("2026-05-20"), to: "2026-09-01", reason: "机电验收延后" });

  const c2 = sys.state("site:C2");
  assert.equal(c2.status, "REGISTERED"); // 仍是在建，没有开业也没有冻结别人
  assert.equal(c2.plannedCompletion, "2026-09-01");
  assert.equal(c2.postponements.length, 1);

  const net = views(sys).cityNetwork("示例市");
  assert.equal(net.shape, "1+2");
  // 延期发生在 C2 流上：C1、N01、E01 状态全部不变。
  assert.deepEqual(net.sites.filter((s) => s.siteId !== "C2").map((s) => s.status), ["OPERATING", "OPERATING", "OPERATING"]);
  assert.equal(net.networkServing, 3); // 三个点位都在服务，C2 尚未开业不计
  const n01 = net.sites.find((s) => s.siteId === "N01");
  assert.equal(n01.postponements, 0);
});

test("未办延期不能按更晚日期竣工", () => {
  const sys = buildSystem();
  sys.dispatch("site:C9", { type: "registerSite", at: ts("2026-03-01"), id: "C9", city: "示例市", name: "C9", kind: "CENTER", plannedCompletion: "2026-06-01" });
  expectThrow(() => sys.dispatch("site:C9", { type: "completeConstruction", at: ts("2026-07-01") }), "DOMAIN_REJECTED");
});

test("竣工后一年内开业正常；超期开业标红但事实保留", () => {
  const sys = buildSystem();
  // 按时：2026-03-01 竣工 → 期限 2027-03-01，3 月开业不逾期。
  sys.dispatch("site:A1", { type: "registerSite", at: ts("2026-01-05"), id: "A1", city: "示例市", name: "A1", kind: "CENTER", plannedCompletion: "2026-03-01" });
  sys.dispatch("site:A1", { type: "completeConstruction", at: ts("2026-03-01") });
  assert.equal(sys.state("site:A1").operateBy, "2027-03-01");
  sys.dispatch("site:A1", { type: "openOperations", at: ts("2026-03-10") });
  assert.equal(sys.state("site:A1").overdue, false);

  // 逾期：2026-03-01 竣工，2027-05 才开业。
  sys.dispatch("site:A2", { type: "registerSite", at: ts("2026-01-05"), id: "A2", city: "示例市", name: "A2", kind: "COMMUNITY", plannedCompletion: "2026-03-01" });
  sys.dispatch("site:A2", { type: "completeConstruction", at: ts("2026-03-01") });
  sys.dispatch("site:A2", { type: "openOperations", at: ts("2027-05-06") });
  assert.equal(sys.state("site:A2").overdue, true);
  assert.equal(sys.state("site:A2").status, "OPERATING"); // 仍记录真实开业事实，供市级督办
});
