// 时钟与时间区间工具。
// 全系统统一：业务时间一律带时区的 ISO 字符串；落库为瞬时（毫秒），
// 展示时按站点时区还原。计时托跨午夜按"实际服务时段"结算即依赖这里。

export function toInstant(isoLike) {
  const t = Date.parse(isoLike);
  if (Number.isNaN(t)) throw new Error(`非法时间: ${isoLike}`);
  return t;
}

export function instantToIso(ms, tzOffsetMinutes = 480) {
  // tzOffsetMinutes：站点本地时区相对 UTC 的偏移（东八区 +480）。
  const shifted = new Date(ms + tzOffsetMinutes * 60_000);
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  const a = Math.abs(tzOffsetMinutes);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.toISOString().slice(0, 19)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// 实际服务时段：签退缺失（断网未补）时按规则约定的兜底口径计费，
// 但绝不允许结束早于开始。
export function actualServiceMinutes(checkInAt, checkOutAt, { graceMinutes = 0 } = {}) {
  const start = toInstant(checkInAt);
  const end = checkOutAt ? toInstant(checkOutAt) : start + graceMinutes * 60_000;
  if (end < start) throw new Error("签退时间早于签到时间");
  return Math.round((end - start) / 60_000);
}

// 判断一次计时托服务是否跨过站点本地午夜（用于分段计费说明）。
export function crossesLocalMidnight(checkInAt, checkOutAt, tzOffsetMinutes = 480) {
  if (!checkOutAt) return false;
  const localDate = (ms) => instantToIso(ms, tzOffsetMinutes).slice(0, 10);
  return localDate(toInstant(checkInAt)) !== localDate(toInstant(checkOutAt));
}

// 竣工后一年期限（精确到日）。
export function oneYearAfter(isoDate) {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) throw new Error(`非法日期: ${isoDate}`);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIsoDate, toIsoDate) {
  return Math.round((toInstant(`${toIsoDate}T00:00:00Z`) - toInstant(`${fromIsoDate}T00:00:00Z`)) / 86_400_000);
}
