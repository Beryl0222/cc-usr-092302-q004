// 领域聚合公共工具：事件折叠（fold）与阶段守卫。
// 所有聚合都是纯函数：apply(state, event) 折叠出新状态，
// decide(command, state, ctx) 校验并产出事件；不允许就地改状态。

export function fold(events, apply, initial) {
  return events.reduce((s, e) => apply(s, e), initial);
}

export function requireState(state, predicate, message) {
  if (!predicate(state)) {
    const err = new Error(message);
    err.code = "DOMAIN_REJECTED";
    throw err;
  }
}

// 监管/医疗记录类结论只允许沿生命周期前进，迟到的旧阶段事件不能回滚新阶段。
export function monotonicStage(current, allowedFrom, next, label) {
  if (!allowedFrom.includes(current)) {
    const err = new Error(`${label}：当前阶段 ${current} 不能推进到 ${next}`);
    err.code = "STAGE_GUARD";
    throw err;
  }
}
