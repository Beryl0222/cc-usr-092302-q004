// 场地、班型与名额聚合（subject: catalog:{siteId}）。
// 班型：FULL 全日托 / HALF 半日托 / HOURLY 计时托。
// - 容量按"日期 + 班型（半日托再分上下午时段）"核算，
//   RESERVED 与 CONFIRMED 都占位，CANCELLED/RELEASED 即时释放，
//   家庭端读到的永远是折叠后的真实可预约数，超售在 decide 阶段拒绝。
// - 计时托预约携带计划时段；改期不抹掉原预约，而是追加改期事件，
//   最终结算以 agreement 流上的实际签到/签退时段为准（跨午夜也按实际）。
// - 是否可约还取决于点位 OPERATING 与保育人员配备（由系统门面联查），
//   聚合自身只管容量真相。

import { requireState } from "./util.js";
import { toInstant } from "../clock.js";

export function initial() {
  return { siteId: null, offerings: new Map(), bookings: new Map() };
}

function cloneCatalog(s) {
  return {
    siteId: s.siteId,
    // 事件折叠用 Map；对外快照时再转普通对象。
    offerings: new Map(s.offerings),
    bookings: new Map(s.bookings),
  };
}

export function apply(state, e) {
  const p = e.payload;
  switch (e.kind) {
    case "CATALOG_OPENED":
      return { ...state, siteId: p.siteId };
    case "OFFERING_DEFINED": {
      const s = cloneCatalog(state);
      s.offerings.set(p.offeringId, {
        offeringId: p.offeringId,
        type: p.type,
        name: p.name,
        dailyCapacity: p.dailyCapacity,
        sessions: p.sessions ?? null, // 半日托：["AM","PM"]；计时托：开放时段
        active: true,
      });
      return s;
    }
    case "OFFERING_CAPACITY_CHANGED": {
      const s = cloneCatalog(state);
      const o = s.offerings.get(p.offeringId);
      if (!o) return state;
      s.offerings.set(p.offeringId, { ...o, dailyCapacity: p.dailyCapacity });
      return s;
    }
    case "SEAT_RESERVED": {
      const s = cloneCatalog(state);
      s.bookings.set(p.bookingId, {
        bookingId: p.bookingId,
        childId: p.childId,
        offeringId: p.offeringId,
        type: p.type,
        date: p.date,
        session: p.session ?? null,
        plannedStart: p.plannedStart ?? null,
        plannedEnd: p.plannedEnd ?? null,
        status: "RESERVED",
        history: [{ to: "RESERVED", at: e.occurred_at }],
      });
      return s;
    }
    case "SEAT_CONFIRMED": {
      const s = cloneCatalog(state);
      const b = s.bookings.get(p.bookingId);
      if (!b) return state;
      s.bookings.set(p.bookingId, { ...b, status: "CONFIRMED", history: [...b.history, { to: "CONFIRMED", at: e.occurred_at }] });
      return s;
    }
    case "BOOKING_RESCHEDULED": {
      const s = cloneCatalog(state);
      const b = s.bookings.get(p.bookingId);
      if (!b) return state;
      s.bookings.set(p.bookingId, {
        ...b,
        date: p.date ?? b.date,
        session: p.session ?? b.session,
        plannedStart: p.plannedStart ?? b.plannedStart,
        plannedEnd: p.plannedEnd ?? b.plannedEnd,
        history: [...b.history, { to: "RESCHEDULED", at: e.occurred_at, detail: p.reason ?? "" }],
      });
      return s;
    }
    case "SEAT_RELEASED": {
      const s = cloneCatalog(state);
      const b = s.bookings.get(p.bookingId);
      if (!b) return state;
      s.bookings.set(p.bookingId, { ...b, status: p.reason === "CANCELLED" ? "CANCELLED" : "RELEASED", history: [...b.history, { to: p.reason ?? "RELEASED", at: e.occurred_at }] });
      return s;
    }
    default:
      return state;
  }
}

// 某日某时段的占用与剩余。
export function occupancyOn(state, offeringId, date, session = null) {
  const offering = state.offerings.get(offeringId);
  if (!offering) return null;
  let held = 0;
  for (const b of state.bookings.values()) {
    if (b.offeringId !== offeringId || b.date !== date) continue;
    if (session && b.session !== session) continue;
    if (b.status === "RESERVED" || b.status === "CONFIRMED") held += 1;
  }
  return { capacity: offering.dailyCapacity, held, available: offering.dailyCapacity - held };
}

export function decide(state, cmd) {
  const now = cmd.at;
  switch (cmd.type) {
    case "openCatalog":
      requireState(state, (s) => s.siteId === null, "班型目录已开立");
      return [{ kind: "CATALOG_OPENED", occurred_at: now, payload: { siteId: cmd.siteId } }];

    case "defineOffering": {
      if (!["FULL", "HALF", "HOURLY"].includes(cmd.offeringType)) throw new Error("班型必须为 FULL/HALF/HOURLY");
      if (!Number.isInteger(cmd.dailyCapacity) || cmd.dailyCapacity < 1) throw new Error("容量必须为正整数");
      if (state.offerings.has(cmd.offeringId)) throw new Error("班型已存在，变更容量请走容量调整");
      return [{
        kind: "OFFERING_DEFINED",
        occurred_at: now,
        payload: { offeringId: cmd.offeringId, type: cmd.offeringType, name: cmd.name, dailyCapacity: cmd.dailyCapacity, sessions: cmd.sessions ?? null },
      }];
    }

    case "changeCapacity": {
      const o = state.offerings.get(cmd.offeringId);
      requireState(state, () => o, "班型不存在");
      const dates = new Set([...state.bookings.values()].filter((b) => b.offeringId === cmd.offeringId && ["RESERVED", "CONFIRMED"].includes(b.status)).map((b) => b.date));
      for (const d of dates) {
        const occ = occupancyOn(state, cmd.offeringId, d);
        if (occ.held > cmd.dailyCapacity) throw new Error(`容量下调会使 ${d} 超员（已占 ${occ.held}）`);
      }
      return [{ kind: "OFFERING_CAPACITY_CHANGED", occurred_at: now, payload: { offeringId: cmd.offeringId, dailyCapacity: cmd.dailyCapacity } }];
    }

    case "reserveSeat": {
      const o = state.offerings.get(cmd.offeringId);
      requireState(state, () => o, "班型不存在");
      if (o.type !== cmd.offeringType) throw new Error("预约班型与定义不符");
      if (cmd.offeringType === "HALF" && !["AM", "PM"].includes(cmd.session)) throw new Error("半日托须指定 AM/PM 时段");
      if (cmd.offeringType === "HOURLY") {
        if (!cmd.plannedStart || !cmd.plannedEnd || toInstant(cmd.plannedEnd) <= toInstant(cmd.plannedStart)) {
          throw new Error("计时托须给出合法的计划起止时段");
        }
      }
      if (state.bookings.has(cmd.bookingId)) throw new Error("预约号已存在");
      const occ = occupancyOn(state, cmd.offeringId, cmd.date, cmd.session ?? null);
      if (occ.available <= 0) throw new Error(`${cmd.date} 该班型已满，不能超售`);
      return [{
        kind: "SEAT_RESERVED",
        occurred_at: now,
        payload: {
          bookingId: cmd.bookingId, childId: cmd.childId, offeringId: cmd.offeringId, type: cmd.offeringType,
          date: cmd.date, session: cmd.session ?? null, plannedStart: cmd.plannedStart ?? null, plannedEnd: cmd.plannedEnd ?? null,
        },
      }];
    }

    case "confirmSeat": {
      const b = state.bookings.get(cmd.bookingId);
      requireState(state, () => b, "预约不存在");
      if (b.status !== "RESERVED") throw new Error(`预约处于 ${b.status}，不能确认`);
      return [{ kind: "SEAT_CONFIRMED", occurred_at: now, payload: { bookingId: cmd.bookingId } }];
    }

    case "rescheduleBooking": {
      // 计时托改期：检查新时段容量（同 offering/date/session 占位相抵），保留原记录。
      const b = state.bookings.get(cmd.bookingId);
      requireState(state, () => b, "预约不存在");
      if (!["RESERVED", "CONFIRMED"].includes(b.status)) throw new Error("仅有效预约可改期");
      const newDate = cmd.date ?? b.date;
      const newSession = cmd.session ?? b.session;
      const occ = occupancyOn(state, b.offeringId, newDate, newSession);
      const self = b.date === newDate && (b.session ?? null) === (newSession ?? null) ? 1 : 0;
      if (occ.held - self >= occ.capacity) throw new Error("改期目标时段已满");
      if (cmd.plannedStart && cmd.plannedEnd && toInstant(cmd.plannedEnd) <= toInstant(cmd.plannedStart)) throw new Error("改期时段不合法");
      return [{
        kind: "BOOKING_RESCHEDULED",
        occurred_at: now,
        payload: { bookingId: cmd.bookingId, date: cmd.date ?? null, session: cmd.session ?? null, plannedStart: cmd.plannedStart ?? null, plannedEnd: cmd.plannedEnd ?? null, reason: cmd.reason ?? "" },
      }];
    }

    case "releaseSeat": {
      const b = state.bookings.get(cmd.bookingId);
      requireState(state, () => b, "预约不存在");
      if (!["RESERVED", "CONFIRMED"].includes(b.status)) throw new Error("预约已释放");
      return [{ kind: "SEAT_RELEASED", occurred_at: now, payload: { bookingId: cmd.bookingId, reason: cmd.reason ?? "CANCELLED" } }];
    }

    default:
      throw new Error(`catalog 聚合不认识命令 ${cmd.type}`);
  }
}
