import assert from "node:assert/strict";
import test from "node:test";
import { KINDS } from "../src/kinds.js";
import { RuleBook } from "../src/rules.js";
import { availability, placeBooking } from "../src/slots.js";
import { SITE_SUBJECT } from "../src/sites.js";
import { EventStore } from "../src/store.js";

const DATE = "2026-09-23";
const AT = "2026-09-22T10:00:00+08:00";

function setup() {
  const store = new EventStore();
  const rb = new RuleBook().publish("booking", 1, "2026-01-01T00:00:00+08:00", { max_per_child: 1 });
  const subject = SITE_SUBJECT("site-2");
  store.append({ event_id: "cap1", kind: KINDS.CAPACITY_SET, occurred_at: AT, subject_id: subject, version: 1, data: { date: DATE, class_type: "全日托", capacity: 2 } });
  store.append({ event_id: "cap2", kind: KINDS.CAPACITY_SET, occurred_at: AT, subject_id: subject, version: 2, data: { date: DATE, class_type: "计时托", capacity: 1 } });
  return { store, rb };
}

test("名额按班型核算，约满即拒", () => {
  const { store, rb } = setup();
  const base = { siteId: "site-2", classType: "全日托", date: DATE, at: AT };
  assert.equal(placeBooking(store, rb, { ...base, bookingId: "b1", childId: "c1" }).ok, true);
  assert.equal(placeBooking(store, rb, { ...base, bookingId: "b2", childId: "c2" }).ok, true);
  const third = placeBooking(store, rb, { ...base, bookingId: "b3", childId: "c3" });
  assert.equal(third.ok, false);
  assert.equal(third.reason, "约满");
});

test("同一 booking 重复提交幂等拒绝，事件不重复", () => {
  const { store, rb } = setup();
  const base = { siteId: "site-2", classType: "全日托", date: DATE, at: AT };
  placeBooking(store, rb, { ...base, bookingId: "b1", childId: "c1" });
  const dup = placeBooking(store, rb, { ...base, bookingId: "b1", childId: "c1" });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, "重复预约");
  const full = availability(store.of(SITE_SUBJECT("site-2")), DATE).find((a) => a.class_type === "全日托");
  assert.equal(full.booked, 1);
});

test("取消后名额释放，家庭看到真实可预约状态", () => {
  const { store, rb } = setup();
  const base = { siteId: "site-2", classType: "计时托", date: DATE, at: AT };
  const placed = placeBooking(store, rb, { ...base, bookingId: "b9", childId: "c9" });
  assert.equal(placed.event.data.rule_version, 1);
  let hourly = availability(store.of(SITE_SUBJECT("site-2")), DATE).find((a) => a.class_type === "计时托");
  assert.equal(hourly.bookable, false); // 唯一名额已占
  const subject = SITE_SUBJECT("site-2");
  store.append({ event_id: "cancel-b9", kind: KINDS.BOOKING_CANCELLED, occurred_at: "2026-09-22T11:00:00+08:00", subject_id: subject, version: store.nextVersion(subject), data: { booking_id: "b9" } });
  hourly = availability(store.of(subject), DATE).find((a) => a.class_type === "计时托");
  assert.equal(hourly.available, 1);
  assert.equal(hourly.bookable, true);
});
