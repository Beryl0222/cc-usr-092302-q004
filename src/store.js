import { validate } from "./contract.js";

// 只追加事件存储：
// - event_id 去重，断网补传、重复上报不会产生第二条事实；
// - 每个 subject 内部按 version 排序，乱序到达（离线签到、监管回执、调班）
//   在投影前被还原成同一顺序；
// - 不提供修改和删除，已形成的记录只能追加更正。
export class EventStore {
  #byId = new Map();
  #bySubject = new Map();

  // 返回 true 表示新写入，false 表示重复事件被忽略
  append(event) {
    const missing = validate(event);
    if (missing.length > 0) {
      throw new Error(`事件缺少必填字段: ${missing.join(", ")}`);
    }
    if (this.#byId.has(event.event_id)) return false;
    this.#byId.set(event.event_id, event);
    const list = this.#bySubject.get(event.subject_id) ?? [];
    list.push(event);
    list.sort(
      (a, b) => a.version - b.version || a.occurred_at.localeCompare(b.occurred_at),
    );
    this.#bySubject.set(event.subject_id, list);
    return true;
  }

  // 某 subject 的完整有序事件流，供各域投影使用
  of(subjectId) {
    return [...(this.#bySubject.get(subjectId) ?? [])];
  }

  subjects() {
    return [...this.#bySubject.keys()];
  }

  // 该 subject 下一个可用序号
  nextVersion(subjectId) {
    const list = this.#bySubject.get(subjectId);
    return list && list.length > 0 ? list[list.length - 1].version + 1 : 1;
  }
}

// 中心负责人视角：把某 subject 的事件流整理成可核对的时间线，
// 每条决策类事件带出它依据的规则版本（data.rule_version），
// 名额、照护决定、整改结论都能回答“基于哪一版规则”。
export function explain(events) {
  return events.map((e) => ({
    version: e.version,
    kind: e.kind,
    occurred_at: e.occurred_at,
    rule_version: e.data?.rule_version ?? null,
    data: e.data ?? {},
  }));
}
