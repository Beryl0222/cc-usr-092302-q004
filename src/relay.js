// 断网中继：设备离线时先把动作写进本地待发队列（outbox），
// 每条带客户端幂等 ID（device_local_id）与单调 client_seq。
// 重新联网后按任意顺序回放都安全：
//   - 重复投递靠 event_id 幂等吞掉（断网签到补发、重复扣费重试）；
//   - 乱序投递不影响读模型，因为状态全部由事件按 occurred_at 折叠得出；
//   - 同一主体的并发写冲突上抛 VERSION_CONFLICT，由领域层决定重读再追加。

export class OfflineRelay {
  constructor(store) {
    this.store = store;
    this.queue = []; // 待发记录
    this.lastClientSeq = new Map(); // deviceId -> 已接纳的最大 client_seq
  }

  // 设备端记录一个动作（离线可用）。
  enqueue({ device_id, client_seq, subject_id, kind, occurred_at, payload = {}, rule_version = null }) {
    if (!client_seq || client_seq < 1) throw new Error("client_seq 必须为正整数");
    const record = {
      event_id: `${device_id}-${client_seq}`, // 天然幂等键
      device_id,
      client_seq,
      subject_id,
      kind,
      occurred_at,
      payload,
      rule_version,
      enqueued: true,
    };
    this.queue.push(record);
    return record.event_id;
  }

  pending() {
    return this.queue.filter((r) => r.status === undefined).length;
  }

  // 模拟"乱序到达"：允许传入自定义排序/洗牌。
  flush(order = (r) => r.client_seq, { expectedVersionFor = () => null } = {}) {
    const results = [];
    const ready = this.queue.filter((r) => r.status === undefined).sort((a, b) => {
      const va = order(a);
      const vb = order(b);
      return va < vb ? -1 : va > vb ? 1 : 0;
    });
    for (const r of ready) {
      try {
        const out = this.store.append(
          r.subject_id,
          { event_id: r.event_id, kind: r.kind, occurred_at: r.occurred_at, payload: r.payload, rule_version: r.rule_version },
          expectedVersionFor(r),
        );
        r.status = out.status; // applied | duplicate
        if (out.status === "applied") {
          const prev = this.lastClientSeq.get(r.device_id) ?? 0;
          this.lastClientSeq.set(r.device_id, Math.max(prev, r.client_seq));
        }
        results.push({ event_id: r.event_id, status: r.status });
      } catch (err) {
        if (err.code === "VERSION_CONFLICT") {
          r.status = "conflict";
          results.push({ event_id: r.event_id, status: "conflict", error: err.message });
        } else {
          throw err;
        }
      }
    }
    return results;
  }
}
