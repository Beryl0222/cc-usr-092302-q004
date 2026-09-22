// 测试公共构造：两版规则 + 一个已运营的 1+N 城市网络。
import { OperationsSystem } from "../src/system.js";
import { ReadModels } from "../src/readmodels.js";

export const TZ = "+08:00";
export function ts(date, hms = "10:00:00") {
  return `${date}T${hms}${TZ}`;
}

export function buildSystem() {
  const sys = new OperationsSystem();
  // 规则 v1：2026 年全年初版；v2 自 9 月 1 日调价并提高人员配备要求。
  sys.rules.publish({
    version: 1,
    effective_from: "2026-01-01",
    published_at: ts("2025-12-20"),
    note: "初版运营规则",
    rules: {
      hourly_unit_amount: 30,
      hourly_billing_block_minutes: 30,
      overnight_surcharge: 10,
      min_caregivers_per_session: 1,
      full_month_fee: 2000,
      half_month_fee: 1200,
    },
  });
  sys.rules.publish({
    version: 2,
    effective_from: "2026-09-01",
    published_at: ts("2026-08-25"),
    note: "计时托调价，每时段持证保育员至少 2 人",
    rules: {
      hourly_unit_amount: 35,
      hourly_billing_block_minutes: 30,
      overnight_surcharge: 10,
      min_caregivers_per_session: 2,
      full_month_fee: 2200,
      half_month_fee: 1300,
    },
  });
  return sys;
}

export function views(sys) {
  return new ReadModels(sys);
}

// 建一个已开业点位（含班型目录、花名册），返回常用 id。
export function seedOperatingSite(sys, { siteId = "N01", kind = "COMMUNITY", completion = "2026-02-01", open = "2026-02-10" } = {}) {
  sys.dispatch(`site:${siteId}`, { type: "registerSite", at: ts("2026-01-05"), id: siteId, city: "示例市", name: `点位${siteId}`, kind, plannedCompletion: completion });
  sys.dispatch(`site:${siteId}`, { type: "completeConstruction", at: ts(completion) });
  sys.dispatch(`site:${siteId}`, { type: "openOperations", at: ts(open) });
  sys.dispatch(`catalog:${siteId}`, { type: "openCatalog", at: ts(open), siteId });
  sys.dispatch(`staff:${siteId}`, { type: "openRoster", at: ts(open), siteId });
  return siteId;
}

export function expectThrow(fn, code = null) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error("预期抛错但未抛出");
  if (code && err.code !== code) throw new Error(`预期错误码 ${code}，实际 ${err.code}：${err.message}`);
  return err;
}
