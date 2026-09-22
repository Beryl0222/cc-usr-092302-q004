// 保育人员：资质、培训、排班与调班（subject: staff:{siteId}）。
// - 资质与培训记录只追加；过期资质会在读模型里标红。
// - 调班是带版本的命令：两人对调/改班若基于过期排班，乐观并发拒绝，
//   乱序到达的"旧调班"不会覆盖"新调班"。
// - 某班型时段是否"配足保育人员"由 coverageOn 给出，供真实可预约判定。

import { requireState } from "./util.js";

export function initial() {
  return { siteId: null, people: new Map(), assignments: [] }; // assignments: {staffId, date, session, role}
}

function clone(s) {
  return { siteId: s.siteId, people: new Map(Array.from(s.people, ([k, v]) => [k, { ...v, credentials: [...v.credentials], trainings: [...v.trainings] }])), assignments: [...s.assignments] };
}

export function apply(state, e) {
  const p = e.payload;
  switch (e.kind) {
    case "STAFF_ROSTER_OPENED":
      return { ...state, siteId: p.siteId };
    case "STAFF_ADDED": {
      const s = clone(state);
      s.people.set(p.staffId, { staffId: p.staffId, name: p.name, role: p.role, hiredAt: p.at, active: true, credentials: [], trainings: [] });
      return s;
    }
    case "CREDENTIAL_RECORDED": {
      const s = clone(state);
      s.people.get(p.staffId)?.credentials.push({ type: p.credType, no: p.no, validFrom: p.validFrom, validTo: p.validTo });
      return s;
    }
    case "TRAINING_RECORDED": {
      const s = clone(state);
      s.people.get(p.staffId)?.trainings.push({ course: p.course, completedAt: p.completedAt, hours: p.hours });
      return s;
    }
    case "STAFF_ASSIGNED": {
      const s = clone(state);
      s.assignments.push({ staffId: p.staffId, date: p.date, session: p.session, role: p.role });
      return s;
    }
    case "STAFF_REASSIGNED": {
      // 调班：移除旧的一条当班，写入新当班；旧记录以事件形式保留在日志。
      const s = clone(state);
      const idx = s.assignments.findIndex((a) => a.staffId === p.staffId && a.date === p.date && a.session === p.session);
      if (idx >= 0) s.assignments.splice(idx, 1);
      s.assignments.push({ staffId: p.toStaffId ?? p.staffId, date: p.newDate ?? p.date, session: p.newSession ?? p.session, role: p.newRole ?? "CAREGIVER" });
      return s;
    }
    case "STAFF_REMOVED": {
      const s = clone(state);
      const person = s.people.get(p.staffId);
      if (person) person.active = false;
      return s;
    }
    default:
      return state;
  }
}

export function coverageOn(state, date, session = null) {
  let caregivers = 0;
  let validCredential = 0;
  for (const a of state.assignments) {
    if (a.date !== date) continue;
    if (session && a.session !== session) continue;
    const person = state.people.get(a.staffId);
    if (!person || !person.active) continue;
    if (a.role === "CAREGIVER" || !a.role) {
      caregivers += 1;
      const ok = person.credentials.some((c) => c.validFrom <= date && (c.validTo === null || c.validTo >= date));
      if (ok) validCredential += 1;
    }
  }
  return { caregivers, validCredential };
}

export function decide(state, cmd) {
  const now = cmd.at;
  switch (cmd.type) {
    case "openRoster":
      requireState(state, (s) => s.siteId === null, "花名册已开立");
      return [{ kind: "STAFF_ROSTER_OPENED", occurred_at: now, payload: { siteId: cmd.siteId } }];
    case "addStaff": {
      if (state.people.has(cmd.staffId)) throw new Error("人员已存在");
      return [{ kind: "STAFF_ADDED", occurred_at: now, payload: { staffId: cmd.staffId, name: cmd.name, role: cmd.role ?? "CAREGIVER", at: now } }];
    }
    case "recordCredential": {
      requireState(state, () => state.people.has(cmd.staffId), "人员不存在");
      if (!cmd.credType || !cmd.validFrom) throw new Error("资质类型与起始日必填");
      return [{ kind: "CREDENTIAL_RECORDED", occurred_at: now, payload: { staffId: cmd.staffId, credType: cmd.credType, no: cmd.no ?? "", validFrom: cmd.validFrom, validTo: cmd.validTo ?? null } }];
    }
    case "recordTraining": {
      requireState(state, () => state.people.has(cmd.staffId), "人员不存在");
      return [{ kind: "TRAINING_RECORDED", occurred_at: now, payload: { staffId: cmd.staffId, course: cmd.course, completedAt: cmd.completedAt, hours: cmd.hours } }];
    }
    case "assignStaff": {
      requireState(state, () => state.people.has(cmd.staffId), "人员不存在");
      return [{ kind: "STAFF_ASSIGNED", occurred_at: now, payload: { staffId: cmd.staffId, date: cmd.date, session: cmd.session, role: cmd.role ?? "CAREGIVER" } }];
    }
    case "reassignStaff": {
      const exists = state.assignments.some((a) => a.staffId === cmd.staffId && a.date === cmd.date && a.session === cmd.session);
      requireState(state, () => exists, "找不到原当班，无法调班");
      return [{
        kind: "STAFF_REASSIGNED",
        occurred_at: now,
        payload: { staffId: cmd.staffId, date: cmd.date, session: cmd.session, toStaffId: cmd.toStaffId ?? null, newDate: cmd.newDate ?? null, newSession: cmd.newSession ?? null, newRole: cmd.newRole ?? null },
      }];
    }
    case "removeStaff": {
      requireState(state, () => state.people.has(cmd.staffId), "人员不存在");
      return [{ kind: "STAFF_REMOVED", occurred_at: now, payload: { staffId: cmd.staffId } }];
    }
    default:
      throw new Error(`staff 聚合不认识命令 ${cmd.type}`);
  }
}
