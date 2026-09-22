import assert from "node:assert/strict";
import test from "node:test";
import { localDateOf, splitByLocalDay } from "../src/time.js";

test("本地日期按东八区口径", () => {
  assert.equal(localDateOf("2026-09-22T23:30:00+08:00"), "2026-09-22");
  // 同一时刻的 UTC 表示仍落在本地次日
  assert.equal(localDateOf("2026-09-22T16:30:00Z"), "2026-09-23");
});

test("跨午夜时段按本地零点拆成两段", () => {
  const segs = splitByLocalDay("2026-09-22T22:00:00+08:00", "2026-09-23T01:30:00+08:00");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].date, "2026-09-22");
  assert.equal(segs[0].hours, 2);
  assert.equal(segs[1].date, "2026-09-23");
  assert.equal(segs[1].hours, 1.5);
});

test("不跨午夜的时段只有一段", () => {
  const segs = splitByLocalDay("2026-09-22T09:00:00+08:00", "2026-09-22T12:00:00+08:00");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].hours, 3);
});

test("空时段不产生分段", () => {
  assert.deepEqual(splitByLocalDay("2026-09-22T09:00:00+08:00", "2026-09-22T09:00:00+08:00"), []);
});
