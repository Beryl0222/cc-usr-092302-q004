// 事件存储：按主体（subject_id）隔离的事件流。
// 事件信封遵循 contracts/event.schema.json：
//   event_id / kind / occurred_at / subject_id / version(=流内版本号)
//   另附 rule_version（本事件基于哪一版规则）与 payload。
// - 事件一经追加不可变（append-only），监管/医疗记录只能追加更正事件，不提供删除。
// - event_id 全局幂等：断网重发、重复扣费重试不会产生两笔。
// - 每个主体流内有单调 version，命令带期望版本做乐观并发，
//   人员调班、监管回执乱序到达时靠它拒绝过期写入，决定权交给调用方。

let counter = 0;
function newEventId(prefix = "evt") {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export class EventStore {
  constructor() {
    this.streams = new Map(); // subject_id -> event[]
    this.index = new Map(); // event_id -> { subject_id, pos }
  }

  _stream(subjectId) {
    if (!this.streams.has(subjectId)) this.streams.set(subjectId, []);
    return this.streams.get(subjectId);
  }

  // 幂等追加。返回 { status: "applied"|"duplicate", event }。
  append(subjectId, { event_id = newEventId(), kind, occurred_at, payload = {}, rule_version = null }, expectedVersion = null) {
    if (!kind || !occurred_at) throw new Error("事件缺少 kind/occurred_at");
    const dup = this.index.get(event_id);
    if (dup) {
      const existing = this.streams.get(dup.subject_id)[dup.pos];
      if (existing.kind !== kind || existing.subject_id !== subjectId) {
        throw new Error(`event_id ${event_id} 曾用于不同事件，拒绝复用`);
      }
      return { status: "duplicate", event: existing };
    }
    const stream = this._stream(subjectId);
    const currentVersion = stream.length;
    if (expectedVersion !== null && expectedVersion !== currentVersion) {
      const err = new Error(`主体 ${subjectId} 版本冲突：期望 ${expectedVersion}，实际 ${currentVersion}`);
      err.code = "VERSION_CONFLICT";
      err.expected = expectedVersion;
      err.actual = currentVersion;
      throw err;
    }
    const event = Object.freeze({
      event_id,
      kind,
      subject_id: subjectId,
      occurred_at,
      rule_version,
      version: currentVersion + 1,
      payload: Object.freeze(payload),
    });
    stream.push(event);
    this.index.set(event_id, { subject_id: subjectId, pos: stream.length - 1 });
    return { status: "applied", event };
  }

  load(subjectId) {
    return [...(this.streams.get(subjectId) ?? [])];
  }

  // 主体流当前版本（= 事件数量），用于乐观并发与去重判断。
  version(subjectId) {
    return (this.streams.get(subjectId) ?? []).length;
  }

  exists(eventId) {
    return this.index.has(eventId);
  }

  // 全库按 (occurred_at, version) 重排，供读模型处理乱序到达的事件。
  allChronological() {
    const all = [];
    for (const [sid, stream] of this.streams) {
      for (const ev of stream) {
        if (ev.subject_id !== sid) throw new Error("流归属不一致");
        all.push(ev);
      }
    }
    return all.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.version - b.version));
  }
}
