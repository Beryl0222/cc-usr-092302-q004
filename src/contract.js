// 事件信封最小校验，对应 contracts/event.schema.json。
// 基线要求 event_id/kind/occurred_at/subject_id/version；
// rule_version 为领域事件必填（决定溯源），payload 可选。

const required = ["event_id", "kind", "occurred_at", "subject_id", "version"];

export function validate(record) {
  const missing = required.filter((name) => !(name in record));
  if (missing.length) return missing;
  const badType = [];
  if (typeof record.event_id !== "string" || !record.event_id) badType.push("event_id");
  if (typeof record.kind !== "string" || !record.kind) badType.push("kind");
  if (typeof record.occurred_at !== "string" || Number.isNaN(Date.parse(record.occurred_at))) badType.push("occurred_at");
  if (typeof record.subject_id !== "string" || !record.subject_id) badType.push("subject_id");
  if (!Number.isInteger(record.version) || record.version < 1) badType.push("version");
  if ("rule_version" in record && record.rule_version !== null && !Number.isInteger(record.rule_version)) badType.push("rule_version");
  if ("payload" in record && (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload))) badType.push("payload");
  return badType;
}
