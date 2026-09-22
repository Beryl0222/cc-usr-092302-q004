// 规则版本簿：名额、费率、期限等规则按版本发布，各自带生效时间。
// 任何决策在发生时解析当时生效的版本并记入事件，
// 事后复查可以还原“当时依据的是哪一版”。
export class RuleBook {
  #sets = new Map(); // name -> [{ version, effective_from, rules }]

  publish(name, version, effectiveFrom, rules) {
    const list = this.#sets.get(name) ?? [];
    if (list.some((entry) => entry.version === version)) {
      throw new Error(`规则 ${name} 的版本 ${version} 已发布过`);
    }
    list.push({ version, effective_from: effectiveFrom, rules });
    list.sort(
      (a, b) => a.effective_from.localeCompare(b.effective_from) || a.version - b.version,
    );
    this.#sets.set(name, list);
    return this;
  }

  // at 时点生效的版本；早于所有版本则视为无规则可依。
  // 时间按时刻比较：ISO 字符串带不同时区偏移时字典序不等于先后。
  resolve(name, at) {
    const list = this.#sets.get(name) ?? [];
    const atMs = Date.parse(at);
    let current = null;
    for (const entry of list) {
      if (Date.parse(entry.effective_from) <= atMs) current = entry;
    }
    if (!current) {
      throw new Error(`规则 ${name} 在 ${at} 尚无生效版本`);
    }
    return current;
  }
}
