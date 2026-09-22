// 时间口径：全市统一按东八区本地日切分。
// 计时托跨午夜结算依赖这里的天界计算，不能用 UTC 日代替。
export const LOCAL_OFFSET_MINUTES = 8 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = LOCAL_OFFSET_MINUTES * 60 * 1000;

// 某一时刻所在的本地日期，如 "2026-09-22"
export function localDateOf(iso) {
  return new Date(new Date(iso).getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

// iso 所在本地日的下一个本地零点（返回 UTC 毫秒时间戳）
export function localMidnightAfter(iso) {
  const shifted = new Date(iso).getTime() + OFFSET_MS;
  return (Math.floor(shifted / DAY_MS) + 1) * DAY_MS - OFFSET_MS;
}

// 把实际服务时段 [startIso, endIso) 按本地零点切成若干段，
// 跨午夜的时段自然拆成两段，每段归属各自的本地日期。
export function splitByLocalDay(startIso, endIso) {
  const segments = [];
  let cursor = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!(cursor < end)) return segments;
  while (cursor < end) {
    const boundary = Math.min(localMidnightAfter(new Date(cursor).toISOString()), end);
    segments.push({
      date: localDateOf(new Date(cursor).toISOString()),
      start: new Date(cursor).toISOString(),
      end: new Date(boundary).toISOString(),
      hours: (boundary - cursor) / 3600000,
    });
    cursor = boundary;
  }
  return segments;
}
