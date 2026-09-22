import { KINDS } from "./kinds.js";

// 签约服务包、社区活动、转介的轻量投影。
// 这三类业务当前只需要有序留痕与最新状态，
// 深度规则（如服务包核销）落地时在各自模块扩展。

// 婴幼儿签约服务包：同一儿童可先后签约，最新一份为当前有效包
export function packageProjection(events) {
  const packages = [];
  for (const e of events) {
    if (e.kind === KINDS.PACKAGE_SIGNED) packages.push({ ...e.data, at: e.occurred_at });
  }
  return { packages, current: packages[packages.length - 1] ?? null };
}

// 社区活动台账
export function activityLog(events) {
  return events
    .filter((e) => e.kind === KINDS.ACTIVITY_HELD)
    .map((e) => ({ ...e.data, at: e.occurred_at }));
}

// 转介：从一家机构转往另一家，接收方只有在实际承担服务后
// 才能依据家长授权调阅健康资料（见 src/consent.js）
export function referralProjection(events) {
  const referrals = [];
  for (const e of events) {
    if (e.kind === KINDS.REFERRAL_MADE) referrals.push({ ...e.data, at: e.occurred_at });
  }
  return { referrals, latest: referrals[referrals.length - 1] ?? null };
}
