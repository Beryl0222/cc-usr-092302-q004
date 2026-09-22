import { KINDS } from "./kinds.js";
import { SITE_SUBJECT } from "./sites.js";

export const CLASS_TYPES = ["全日托", "半日托", "计时托"];

const keyOf = (date, classType) => `${date}|${classType}`;

// 名额投影：容量与预约都来自事件流，取消只是新事件，
// 乱序到达时按 version 排序后结论一致。
export function slotProjection(events) {
  const capacity = new Map(); // `${date}|${class_type}` -> 上限
  const bookings = new Map(); // booking_id -> 预约（含是否有效）
  for (const e of events) {
    switch (e.kind) {
      case KINDS.CAPACITY_SET:
        capacity.set(keyOf(e.data.date, e.data.class_type), e.data.capacity);
        break;
      case KINDS.BOOKING_PLACED:
        bookings.set(e.data.booking_id, {
          ...e.data,
          active: true,
          rule_version: e.data.rule_version ?? null,
        });
        break;
      case KINDS.BOOKING_CANCELLED: {
        const booking = bookings.get(e.data.booking_id);
        if (booking) booking.active = false;
        break;
      }
    }
  }
  return { capacity, bookings };
}

// 向家庭展示的真实可预约状态：直接由事件流算出，
// 不存在另一份可能失真的“展示用库存”。
export function availability(events, date) {
  const { capacity, bookings } = slotProjection(events);
  const active = [...bookings.values()].filter((b) => b.active && b.date === date);
  return CLASS_TYPES.map((classType) => {
    const cap = capacity.get(keyOf(date, classType)) ?? 0;
    const booked = active.filter((b) => b.class_type === classType).length;
    const left = Math.max(0, cap - booked);
    return {
      class_type: classType,
      capacity: cap,
      booked,
      available: left,
      bookable: left > 0,
    };
  });
}

// 预约指令：约满拒绝、同一 booking_id 重复提交幂等拒绝，
// 成功时把当时生效的预约规则版本写进事件。
export function placeBooking(store, rulebook, { siteId, bookingId, childId, classType, date, at }) {
  const subject = SITE_SUBJECT(siteId);
  const events = store.of(subject);
  const existing = slotProjection(events).bookings.get(bookingId);
  if (existing?.active) return { ok: false, reason: "重复预约", event: null };
  const day = availability(events, date).find((a) => a.class_type === classType);
  if (!day || !day.bookable) return { ok: false, reason: "约满", event: null };
  const rule = rulebook.resolve("booking", at);
  const event = {
    event_id: `booking:${bookingId}`, // 幂等键：重试不会产生第二条
    kind: KINDS.BOOKING_PLACED,
    occurred_at: at,
    subject_id: subject,
    version: store.nextVersion(subject),
    data: {
      booking_id: bookingId,
      child_id: childId,
      class_type: classType,
      date,
      rule_version: rule.version,
    },
  };
  store.append(event);
  return { ok: true, reason: null, event };
}
