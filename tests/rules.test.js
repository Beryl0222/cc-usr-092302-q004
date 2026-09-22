import assert from "node:assert/strict";
import test from "node:test";
import { RuleBook } from "../src/rules.js";

test("按时点解析生效版本", () => {
  const rb = new RuleBook()
    .publish("hourly_fee", 1, "2026-01-01T00:00:00+08:00", { rate_per_hour: 30 })
    .publish("hourly_fee", 2, "2026-09-01T00:00:00+08:00", { rate_per_hour: 36 });
  assert.equal(rb.resolve("hourly_fee", "2026-06-01T00:00:00+08:00").version, 1);
  assert.equal(rb.resolve("hourly_fee", "2026-09-22T00:00:00+08:00").rules.rate_per_hour, 36);
});

test("早于所有版本时报错，不允许无规则决策", () => {
  const rb = new RuleBook().publish("booking", 1, "2026-01-01T00:00:00+08:00", {});
  assert.throws(() => rb.resolve("booking", "2025-01-01T00:00:00+08:00"), /尚无生效版本/);
});

test("同一版本不能重复发布", () => {
  const rb = new RuleBook().publish("booking", 1, "2026-01-01T00:00:00+08:00", {});
  assert.throws(() => rb.publish("booking", 1, "2026-02-01T00:00:00+08:00", {}), /已发布过/);
});
