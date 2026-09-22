// 版本化规则库（RuleBook）。
// 需求：中心负责人要能看出"某个名额、照护决定和整改结论基于哪一版规则"。
// 设计：规则一经发布即不可变；需要改规则就发新版本并带生效时间。
// 任何命令在做决定时必须通过 ruleBook.at(instant) 取当时有效的规则快照，
// 并把 rule_version 盖进事件，事件永不回填修改。

export class RuleBook {
  constructor() {
    // versions 按版本号升序保存不可变快照
    this.versions = [];
  }

  // 发布一版规则。effective_from 为本地日期（含当天）。
  publish({ version, effective_from, published_at, rules, note = "" }) {
    if (!Number.isInteger(version) || version < 1) throw new Error("版本号必须为正整数");
    if (this.versions.some((v) => v.version === version)) throw new Error(`规则版本 ${version} 已存在，规则不可变`);
    if (this.versions.some((v) => v.effective_from === effective_from)) {
      throw new Error(`生效日 ${effective_from} 已有规则版本`);
    }
    const snap = { version, effective_from, published_at, note, rules: Object.freeze({ ...rules }) };
    this.versions.push(snap);
    this.versions.sort((a, b) => a.version - b.version);
    return Object.freeze({ ...snap });
  }

  _byDate() {
    return [...this.versions].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  }

  // 某业务时刻适用的规则版本（生效日 <= 该时刻所在日期中的最新版）。
  at(instantIso) {
    const day = instantIso.slice(0, 10);
    const chosen = this._byDate().filter((v) => v.effective_from <= day).at(-1);
    if (!chosen) throw new Error(`${day} 尚无生效的规则版本`);
    return chosen;
  }

  // 某命令时刻直接取版本号，供事件盖章。
  versionAt(instantIso) {
    return this.at(instantIso).version;
  }

  get(version) {
    const v = this.versions.find((x) => x.version === version);
    if (!v) throw new Error(`规则版本 ${version} 不存在`);
    return v;
  }

  // 溯源：某决定事件基于的那一版规则内容。
  explain(version) {
    const v = this.get(version);
    return { version: v.version, effective_from: v.effective_from, note: v.note, rules: v.rules };
  }
}
