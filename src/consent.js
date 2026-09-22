import { KINDS } from "./kinds.js";

export const CHILD_SUBJECT = (childId) => `child:${childId}`;

// 授权与记录投影。授权、调阅、记录、更正全部只追加：
// 家长撤回授权是新增一条撤回事件，不是删改原授权；
// 安全/医疗记录的纠错是追加更正，原记录永不抹去。
export function consentProjection(events) {
  const consents = new Map(); // consent_id -> 授权（含撤回时间）
  const records = new Map(); // record_id -> { formed, corrections[] }
  const accessLog = []; // 调阅留痕
  for (const e of events) {
    switch (e.kind) {
      case KINDS.CONSENT_GRANTED:
        consents.set(e.data.consent_id, {
          ...e.data,
          granted_at: e.occurred_at,
          revoked_at: null,
        });
        break;
      case KINDS.CONSENT_REVOKED: {
        const consent = consents.get(e.data.consent_id);
        if (consent) consent.revoked_at = e.occurred_at;
        break;
      }
      case KINDS.DATA_ACCESSED:
        accessLog.push({ ...e.data, at: e.occurred_at });
        break;
      case KINDS.RECORD_FORMED:
        records.set(e.data.record_id, { formed: e.data, corrections: [] });
        break;
      case KINDS.RECORD_CORRECTED: {
        const record = records.get(e.data.record_id);
        if (record) record.corrections.push({ ...e.data, at: e.occurred_at });
        break;
      }
    }
  }
  return { consents, records, accessLog };
}

// 儿童健康资料只向承担服务的机构开放：
// 授权本身按机构+资料类别 scoped，且在 at 时点未被撤回才放行。
export function canAccess(events, institutionId, dataClass, at) {
  const { consents } = consentProjection(events);
  const atMs = Date.parse(at);
  for (const c of consents.values()) {
    if (
      c.institution_id === institutionId &&
      c.data_class === dataClass &&
      Date.parse(c.granted_at) <= atMs &&
      (!c.revoked_at || atMs < Date.parse(c.revoked_at))
    ) {
      return true;
    }
  }
  return false;
}

// 调阅指令：无权直接拒绝且不留事件；有权则追加调阅留痕。
// 家长撤回授权后，尚未用于照护的资料立即停止共享（canAccess 为否）。
export function accessData(store, { childId, institutionId, dataClass, at }) {
  const subject = CHILD_SUBJECT(childId);
  const events = store.of(subject);
  if (!canAccess(events, institutionId, dataClass, at)) {
    return { ok: false, reason: "无有效授权", event: null };
  }
  const event = {
    event_id: `access:${childId}:${institutionId}:${dataClass}:${at}`,
    kind: KINDS.DATA_ACCESSED,
    occurred_at: at,
    subject_id: subject,
    version: store.nextVersion(subject),
    data: { institution_id: institutionId, data_class: dataClass },
  };
  store.append(event);
  return { ok: true, reason: null, event };
}

// 已形成的安全/医疗记录只能追加更正：record 不存在时拒绝更正，
// 存在时返回完整沿革（原记录 + 历次更正），供监管与家长核对。
export function correctRecord(store, { childId, recordId, correction, at }) {
  const subject = CHILD_SUBJECT(childId);
  const events = store.of(subject);
  const { records } = consentProjection(events);
  if (!records.has(recordId)) {
    return { ok: false, reason: "记录不存在，不能更正", event: null };
  }
  const event = {
    event_id: `correction:${recordId}:${at}`,
    kind: KINDS.RECORD_CORRECTED,
    occurred_at: at,
    subject_id: subject,
    version: store.nextVersion(subject),
    data: { record_id: recordId, correction },
  };
  store.append(event);
  return { ok: true, reason: null, event };
}

export function recordView(events, recordId) {
  return consentProjection(events).records.get(recordId) ?? null;
}
