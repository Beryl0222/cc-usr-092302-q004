// 婴幼儿签约服务包、家长授权、健康资料共享、计时托考勤、照护决定与转介。
// subject: child:{id}
//
// 隐私语义（需求硬规则）：
// 1) 儿童健康资料只向"承担服务的机构"开放：每次共享必须命中一条
//    对该机构、该用途、仍有效的授权，且该机构与签约点位有服务关系。
// 2) 家长撤回授权后：尚未用于照护的共享立即关闭（停止共享）；
//    已经形成安全/医疗记录的部分不抹去，原记录保留且只允许"追加更正"。
// 3) 更正只追加 HEALTH_RECORD_CORRECTED，永不删除、不改写原事件。

import { actualServiceMinutes, crossesLocalMidnight, toInstant } from "../clock.js";
import { requireState } from "./util.js";

export function initial() {
  return null;
}

export function apply(state, e) {
  const p = e.payload;
  switch (e.kind) {
    case "CHILD_ENROLLED":
      return {
        childId: p.childId,
        siteId: p.siteId,
        providerOrgId: p.providerOrgId,
        packageType: p.packageType, // FULL/HALF/HOURLY
        packageName: p.packageName,
        enrolledAt: p.at,
        consents: new Map(), // grantId -> grant
        healthRecords: new Map(), // recordId -> record
        attendance: [], // { sessionId, checkIn, checkOut, minutes, crossMidnight }
        openSessions: new Map(), // sessionId -> checkIn event info
        decisions: [],
        referrals: [],
      };

    case "CONSENT_GRANTED": {
      const s = structured(state);
      s.consents.set(p.grantId, {
        grantId: p.grantId,
        scopes: p.scopes,
        orgId: p.orgId,
        orgName: p.orgName,
        purpose: p.purpose,
        grantedAt: p.at,
        validUntil: p.validUntil ?? null,
        status: "ACTIVE",
        withdrawnAt: null,
        ruleVersion: e.rule_version,
      });
      return s;
    }

    case "CONSENT_WITHDRAWN": {
      const s = structured(state);
      const g = s.consents.get(p.grantId);
      if (g) g.status = "WITHDRAWN", g.withdrawnAt = p.at;
      // 尚未用于照护的共享随之关闭。
      for (const r of s.healthRecords.values()) {
        if (r.grantId === p.grantId && r.accessStatus === "OPEN" && !r.usedForCare) {
          r.accessStatus = "CLOSED";
          r.closedAt = p.at;
        }
      }
      return s;
    }

    case "HEALTH_RECORD_SHARED": {
      const s = structured(state);
      s.healthRecords.set(p.recordId, {
        recordId: p.recordId,
        category: p.category,
        title: p.title,
        orgId: p.orgId,
        grantId: p.grantId,
        sharedAt: p.at,
        accessStatus: "OPEN",
        usedForCare: false,
        usedAt: null,
        corrections: [],
      });
      return s;
    }

    case "HEALTH_USED_FOR_CARE": {
      const s = structured(state);
      const r = s.healthRecords.get(p.recordId);
      if (r && !r.usedForCare) {
        r.usedForCare = true;
        r.usedAt = p.at;
        r.usedInDecision = p.decisionId ?? null;
      }
      return s;
    }

    case "HEALTH_RECORD_CORRECTED": {
      // 追加更正：原记录保留，更正单列且不可再删。
      const s = structured(state);
      const r = s.healthRecords.get(p.recordId);
      if (!r) return state;
      r.corrections.push({ correctionId: p.correctionId, content: p.content, reason: p.reason, at: p.at, ruleVersion: e.rule_version });
      return s;
    }

    case "SERVICE_CHECKED_IN": {
      const s = structured(state);
      s.openSessions.set(p.sessionId, { at: p.at, deviceId: p.deviceId ?? null, bookingId: p.bookingId ?? null });
      return s;
    }

    case "SERVICE_CHECKED_OUT": {
      const s = structured(state);
      const open = s.openSessions.get(p.sessionId);
      if (!open) return state;
      const minutes = actualServiceMinutes(open.at, p.at);
      const cross = crossesLocalMidnight(open.at, p.at);
      s.attendance.push({
        sessionId: p.sessionId,
        bookingId: open.bookingId,
        checkIn: open.at,
        checkOut: p.at,
        minutes,
        crossMidnight: cross,
        deviceId: open.deviceId,
      });
      s.openSessions.delete(p.sessionId);
      return s;
    }

    case "CARE_DECISION_MADE": {
      const s = structured(state);
      s.decisions.push({
        decisionId: p.decisionId,
        title: p.title,
        detail: p.detail,
        basedOnRecords: p.basedOnRecords ?? [],
        at: p.at,
        ruleVersion: e.rule_version,
      });
      return s;
    }

    case "REFERRAL_OPENED": {
      const s = structured(state);
      s.referrals.push({ referralId: p.referralId, toOrgId: p.toOrgId, service: p.service, reason: p.reason, status: "OPENED", openedAt: p.at, updates: [] });
      return s;
    }

    case "REFERRAL_UPDATED": {
      const s = structured(state);
      const r = s.referrals.find((x) => x.referralId === p.referralId);
      if (!r) return state;
      r.status = p.status;
      r.updates.push({ status: p.status, note: p.note ?? "", at: p.at });
      return s;
    }

    default:
      return state;
  }
}

// 折叠时需要深拷贝含 Map 的状态。
function structured(s) {
  return {
    ...s,
    consents: new Map(s.consents),
    healthRecords: new Map(Array.from(s.healthRecords, ([k, r]) => [k, { ...r, corrections: [...r.corrections] }])),
    openSessions: new Map(s.openSessions),
    attendance: [...s.attendance],
    decisions: [...s.decisions],
    referrals: s.referrals.map((r) => ({ ...r, updates: [...r.updates] })),
  };
}

// 授权在某时刻是否对某机构/用途/范围有效。
export function consentCovers(state, { orgId, scope, at }) {
  for (const g of state.consents.values()) {
    if (g.status !== "ACTIVE" || g.orgId !== orgId || !g.scopes.includes(scope)) continue;
    if (g.grantedAt > at) continue;
    if (g.validUntil && at > g.validUntil) continue;
    return g;
  }
  return null;
}

// 健康资料访问判定：仅承担服务的机构、命中有效授权、记录未因撤回而关闭。
export function canAccessHealth(state, { orgId, recordId, at }) {
  const r = state.healthRecords.get(recordId);
  if (!r) return { allowed: false, reason: "记录不存在" };
  if (r.orgId !== orgId) return { allowed: false, reason: "该机构不承担本儿童服务" };
  if (r.accessStatus === "CLOSED") return { allowed: false, reason: "授权已撤回且记录未用于照护，已停止共享" };
  const g = state.consents.get(r.grantId);
  if (!g || g.status !== "ACTIVE") return { allowed: false, reason: "授权已撤回" };
  if (g.grantedAt > at || (g.validUntil && at > g.validUntil)) return { allowed: false, reason: "授权不在有效期" };
  return { allowed: true, reason: "ok", record: r };
}

export function decide(state, cmd) {
  const now = cmd.at;
  switch (cmd.type) {
    case "enrollChild": {
      requireState(state, (s) => s === null, "儿童已签约");
      if (!["FULL", "HALF", "HOURLY"].includes(cmd.packageType)) throw new Error("服务包类型必须为 FULL/HALF/HOURLY");
      return [{ kind: "CHILD_ENROLLED", occurred_at: now, payload: { childId: cmd.childId, siteId: cmd.siteId, providerOrgId: cmd.providerOrgId, packageType: cmd.packageType, packageName: cmd.packageName, at: now } }];
    }

    case "grantConsent": {
      requireState(state, (s) => s, "儿童未签约");
      if (!cmd.scopes?.length) throw new Error("授权范围不能为空");
      if (state.consents.has(cmd.grantId)) throw new Error("授权编号重复");
      return [{
        kind: "CONSENT_GRANTED",
        occurred_at: now,
        payload: { grantId: cmd.grantId, scopes: cmd.scopes, orgId: cmd.orgId, orgName: cmd.orgName ?? "", purpose: cmd.purpose, at: now, validUntil: cmd.validUntil ?? null },
      }];
    }

    case "withdrawConsent": {
      requireState(state, (s) => s, "儿童未签约");
      const g = state.consents.get(cmd.grantId);
      requireState(state, () => g, "授权不存在");
      if (g.status === "WITHDRAWN") throw new Error("授权已撤回，不能重复撤回");
      return [{ kind: "CONSENT_WITHDRAWN", occurred_at: now, payload: { grantId: cmd.grantId, at: now } }];
    }

    case "shareHealthRecord": {
      requireState(state, (s) => s, "儿童未签约");
      const g = consentCovers(state, { orgId: cmd.orgId, scope: cmd.scope ?? "HEALTH_RECORD", at: now });
      if (!g) throw new Error("无对该机构的有效授权，拒绝共享健康资料");
      if (state.healthRecords.has(cmd.recordId)) throw new Error("健康记录编号已存在");
      return [{
        kind: "HEALTH_RECORD_SHARED",
        occurred_at: now,
        payload: { recordId: cmd.recordId, category: cmd.category, title: cmd.title, orgId: cmd.orgId, grantId: g.grantId, at: now },
      }];
    }

    case "correctHealthRecord": {
      requireState(state, (s) => s, "儿童未签约");
      const r = state.healthRecords.get(cmd.recordId);
      requireState(state, () => r, "记录不存在，无从更正");
      // 撤回后仍可更正已形成的记录；不存在删除通道。
      return [{
        kind: "HEALTH_RECORD_CORRECTED",
        occurred_at: now,
        payload: { recordId: cmd.recordId, correctionId: cmd.correctionId, content: cmd.content, reason: cmd.reason, at: now },
      }];
    }

    case "checkIn": {
      requireState(state, (s) => s, "儿童未签约");
      if (state.openSessions.has(cmd.sessionId)) throw new Error("该计时会话已签到");
      return [{ kind: "SERVICE_CHECKED_IN", occurred_at: now, payload: { sessionId: cmd.sessionId, deviceId: cmd.deviceId ?? null, bookingId: cmd.bookingId ?? null, at: now } }];
    }

    case "checkOut": {
      requireState(state, (s) => s, "儿童未签约");
      if (!state.openSessions.has(cmd.sessionId)) throw new Error("无对应签到记录（可能已结算或重复签退）");
      if (toInstant(now) < toInstant(state.openSessions.get(cmd.sessionId).at)) throw new Error("签退早于签到");
      return [{ kind: "SERVICE_CHECKED_OUT", occurred_at: now, payload: { sessionId: cmd.sessionId, at: now } }];
    }

    case "makeCareDecision": {
      requireState(state, (s) => s, "儿童未签约");
      // 决定引用的健康资料必须真实可访问，且一旦作为照护依据即固化为"已用于照护"。
      const events = [];
      for (const recordId of cmd.basedOnRecords ?? []) {
        const access = canAccessHealth(state, { orgId: cmd.orgId, recordId, at: now });
        if (!access.allowed) throw new Error(`照护决定引用资料被拒：${access.reason}`);
        events.push({ kind: "HEALTH_USED_FOR_CARE", occurred_at: now, payload: { recordId, at: now, decisionId: cmd.decisionId } });
      }
      events.push({
        kind: "CARE_DECISION_MADE",
        occurred_at: now,
        payload: { decisionId: cmd.decisionId, title: cmd.title, detail: cmd.detail, basedOnRecords: cmd.basedOnRecords ?? [], at: now },
      });
      return events;
    }

    case "openReferral": {
      requireState(state, (s) => s, "儿童未签约");
      if (state.referrals.some((r) => r.referralId === cmd.referralId)) throw new Error("转介编号重复");
      return [{ kind: "REFERRAL_OPENED", occurred_at: now, payload: { referralId: cmd.referralId, toOrgId: cmd.toOrgId, service: cmd.service, reason: cmd.reason, at: now } }];
    }

    case "updateReferral": {
      const r = state?.referrals.find((x) => x.referralId === cmd.referralId);
      requireState(state, () => r, "转介不存在");
      const order = ["OPENED", "ACCEPTED", "IN_PROGRESS", "FULFILLED", "CLOSED"];
      if (order.indexOf(cmd.status) <= order.indexOf(r.status) && cmd.status !== r.status) {
        throw new Error(`转介状态不能从 ${r.status} 回退到 ${cmd.status}`);
      }
      return [{ kind: "REFERRAL_UPDATED", occurred_at: now, payload: { referralId: cmd.referralId, status: cmd.status, note: cmd.note ?? "", at: now } }];
    }

    default:
      throw new Error(`agreement 聚合不认识命令 ${cmd.type}`);
  }
}
