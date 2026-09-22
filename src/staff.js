import { KINDS } from "./kinds.js";

export const STAFF_SUBJECT = (staffId) => `staff:${staffId}`;

// 保育人员投影。调班事件可能乱序到达，
// 但存储已按 version 排序，最后一条 SHIFT_ASSIGNED 即当前班次。
export function staffProjection(events) {
  const trainings = [];
  let shift = null;
  for (const e of events) {
    if (e.kind === KINDS.STAFF_TRAINED) trainings.push(e.data);
    if (e.kind === KINDS.SHIFT_ASSIGNED) shift = e.data;
  }
  return { trainings, shift };
}

// 资质核验：岗位要求由培训规则版本给出，
// 证书需在 at 时点处于有效期内（有效期按日口径，含截止日当天）。
export function isQualified(events, rulebook, role, at) {
  const rule = rulebook.resolve("training", at);
  const required = rule.rules.required[role];
  if (!required) return false;
  const atMs = Date.parse(at);
  const { trainings } = staffProjection(events);
  return trainings.some(
    (t) =>
      t.certificate === required &&
      (!t.valid_until || Date.parse(`${t.valid_until}T23:59:59+08:00`) >= atMs),
  );
}
