import assert from "node:assert/strict";
import test from "node:test";
import { buildSystem, seedOperatingSite, ts, expectThrow, views } from "./helpers.js";
import { canAccessHealth } from "../src/domain/agreement.js";

function enroll(sys, childId = "K1", orgId = "ORG-N01") {
  sys.dispatch(`child:${childId}`, { type: "enrollChild", at: ts("2026-09-10"), childId, siteId: "N01", providerOrgId: orgId, packageType: "FULL", packageName: "全日托" });
}

test("健康资料只向承担服务的机构开放，无授权或他机构访问被拒", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  enroll(sys);

  // 无任何授权 → 不能共享。
  expectThrow(
    () => sys.dispatch("child:K1", { type: "shareHealthRecord", at: ts("2026-09-11"), recordId: "R0", orgId: "ORG-N01", category: "过敏史", title: "过敏原" }),
    "DOMAIN_REJECTED",
  );

  // 只授权给承担服务的 ORG-N01。
  sys.dispatch("child:K1", { type: "grantConsent", at: ts("2026-09-11"), grantId: "G1", orgId: "ORG-N01", orgName: "N01托育点", purpose: "日常照护", scopes: ["HEALTH_RECORD"] });
  sys.dispatch("child:K1", { type: "shareHealthRecord", at: ts("2026-09-11"), recordId: "R1", orgId: "ORG-N01", category: "过敏史", title: "花生过敏" });

  // 其他机构（未承担服务、无授权）访问被拒。
  const state = sys.state("child:K1");
  assert.equal(canAccessHealth(state, { orgId: "ORG-OTHER", recordId: "R1", at: ts("2026-09-12") }).allowed, false);
  assert.equal(canAccessHealth(state, { orgId: "ORG-N01", recordId: "R1", at: ts("2026-09-12") }).allowed, true);
});

test("撤回授权：尚未用于照护的记录立即停止共享", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  enroll(sys);
  sys.dispatch("child:K1", { type: "grantConsent", at: ts("2026-09-11"), grantId: "G1", orgId: "ORG-N01", purpose: "照护", scopes: ["HEALTH_RECORD"] });
  sys.dispatch("child:K1", { type: "shareHealthRecord", at: ts("2026-09-11"), recordId: "R1", orgId: "ORG-N01", category: "病史", title: "既往病史" });

  sys.dispatch("child:K1", { type: "withdrawConsent", at: ts("2026-09-13"), grantId: "G1" });

  const access = canAccessHealth(sys.state("child:K1"), { orgId: "ORG-N01", recordId: "R1", at: ts("2026-09-13") });
  assert.equal(access.allowed, false);
  assert.equal(access.reason, "授权已撤回且记录未用于照护，已停止共享");

  const row = views(sys).consentLedger("K1").records.find((r) => r.recordId === "R1");
  assert.equal(row.accessStatus, "CLOSED");
  assert.equal(row.usedForCare, false);
  assert.equal(row.disposition, "撤回时未用于照护：已停止共享");

  // 撤回后不能再基于该记录做照护决定。
  expectThrow(
    () => sys.dispatch("child:K1", { type: "makeCareDecision", at: ts("2026-09-14"), orgId: "ORG-N01", decisionId: "D1", title: "喂养安排", basedOnRecords: ["R1"] }),
    "DOMAIN_REJECTED",
  );
});

test("撤回授权：已形成照护记录的部分不抹去，只能追加更正", () => {
  const sys = buildSystem();
  seedOperatingSite(sys, { siteId: "N01" });
  enroll(sys);
  sys.dispatch("child:K1", { type: "grantConsent", at: ts("2026-09-11"), grantId: "G1", orgId: "ORG-N01", purpose: "照护", scopes: ["HEALTH_RECORD"] });
  sys.dispatch("child:K1", { type: "shareHealthRecord", at: ts("2026-09-11"), recordId: "R1", orgId: "ORG-N01", category: "过敏史", title: "牛奶过敏" });
  // 9-12 据记录做出照护决定 → 固化为"已用于照护"。
  sys.dispatch("child:K1", { type: "makeCareDecision", at: ts("2026-09-12"), orgId: "ORG-N01", decisionId: "D1", title: "改用豆奶", basedOnRecords: ["R1"] });

  // 9-13 家长撤回授权。
  sys.dispatch("child:K1", { type: "withdrawConsent", at: ts("2026-09-13"), grantId: "G1" });

  // 记录仍在且不被抹去（撤回不删除、不回滚决定）；决定事件保留。
  const rec = sys.state("child:K1").healthRecords.get("R1");
  assert.equal(rec.usedForCare, true);
  assert.equal(sys.state("child:K1").decisions.length, 1);
  assert.equal(sys.state("child:K1").consents.get("G1").status, "WITHDRAWN");

  // 仍可追加更正（例如过敏原信息修正），且更正被保留、可计数。
  sys.dispatch("child:K1", { type: "correctHealthRecord", at: ts("2026-09-15"), recordId: "R1", correctionId: "C1", content: "确认为乳糖不耐受而非牛奶蛋白过敏", reason: "医院复查" });
  const after = sys.state("child:K1").healthRecords.get("R1");
  assert.equal(after.corrections.length, 1);
  assert.equal(after.title, "牛奶过敏"); // 原记录不被改写

  const row = views(sys).consentLedger("K1").records.find((r) => r.recordId === "R1");
  assert.equal(row.disposition, "已形成照护记录：保留，仅允许追加更正");
  assert.equal(row.corrections, 1);

  // 记录事件本身在流中从未被删除。
  const kinds = sys.store.load("child:K1").map((e) => e.kind);
  assert.ok(kinds.includes("HEALTH_RECORD_SHARED"));
  assert.ok(kinds.includes("CARE_DECISION_MADE"));
  assert.ok(kinds.includes("HEALTH_RECORD_CORRECTED"));
});
