// 系统门面：装配规则库、事件存储与各聚合，统一命令入口。
// dispatch 做三件事：
//   1) 取命令时刻适用规则版本并盖到每个产出事件（rule_version）；
//   2) 折叠主体当前状态，纯函数 decide 产出事件；
//   3) 以期望版本乐观追加，乱序/并发写入冲突上抛，由调用方重读决定。
// 另提供计时托结算等跨聚合工作流。

import { EventStore } from "./store.js";
import { RuleBook } from "./rulebook.js";
import * as site from "./domain/site.js";
import * as catalog from "./domain/catalog.js";
import * as agreement from "./domain/agreement.js";
import * as staff from "./domain/staff.js";
import * as inspection from "./domain/inspection.js";
import * as billing from "./domain/billing.js";
import * as activity from "./domain/activity.js";
import { fold } from "./domain/util.js";
import { validate } from "./contract.js";

const REGISTRY = {
  "site:": site,
  "catalog:": catalog,
  "child:": agreement,
  "staff:": staff,
  "inspection:": inspection,
  "billing:": billing,
  "activity:": activity,
};

export class OperationsSystem {
  constructor(ruleBook = new RuleBook()) {
    this.store = new EventStore();
    this.rules = ruleBook;
  }

  moduleFor(subjectId) {
    const key = Object.keys(REGISTRY).find((k) => subjectId.startsWith(k));
    if (!key) throw new Error(`未知主体 ${subjectId}`);
    return { module: REGISTRY[key], initial: REGISTRY[key].initial() };
  }

  // 状态按业务时间折叠：断网签到、监管回执等可能乱序追加，
  // 但同一事实集合无论追加顺序如何都收敛到同一状态（迟到旧事件不回滚新阶段）。
  state(subjectId) {
    const { module, initial } = this.moduleFor(subjectId);
    const events = [...this.store.load(subjectId)].sort((a, b) =>
      a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.version - b.version,
    );
    return fold(events, module.apply, initial);
  }

  // 单主体命令。返回已落库事件数组。
  // options.eventId：首事件幂等键（重试/离线补传用）。
  // options.expectedVersion：调用方缓存的流版本；并发调班等场景过期即抛 VERSION_CONFLICT。
  dispatch(subjectId, cmd, { eventId = null, expectedVersion = null } = {}) {
    const { module, initial } = this.moduleFor(subjectId);
    const events0 = [...this.store.load(subjectId)].sort((a, b) =>
      a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.version - b.version,
    );
    const state = fold(events0, module.apply, initial);
    let produced;
    try {
      produced = module.decide(state, cmd);
    } catch (err) {
      // 领域拒绝统一错误码；阶段守卫/版本冲突等已自带更具体的码则保留。
      if (!err.code) err.code = "DOMAIN_REJECTED";
      throw err;
    }
    const ruleVersion = this.rules.versionAt(cmd.at);
    const out = [];
    // 乐观并发：默认按到达顺序的当前流长度；调用方可显式携带缓存版本。
    let expected = expectedVersion ?? this.store.version(subjectId);
    for (const [i, ev] of produced.entries()) {
      const envelope = { kind: ev.kind, occurred_at: ev.occurred_at, payload: ev.payload ?? {}, rule_version: ruleVersion };
      const res = this.store.append(subjectId, eventId && i === 0 ? { ...envelope, event_id: eventId } : envelope, expected);
      if (res.status === "applied") {
        expected += 1;
        const problems = validate(res.event);
        if (problems.length) throw new Error(`落库事件未通过信封校验：${problems.join(",")}`);
        out.push(res.event);
      }
      // duplicate 理论上只会在带显式 eventId 重放时出现，跳过即可。
    }
    return out;
  }

  // 计时托结算工作流：以儿童流上某次实际考勤为依据，按当时规则开计时托账单。
  settleHourlySession(childId, { sessionId, chargeId, at }) {
    const child = this.state(`child:${childId}`);
    const att = child.attendance.find((x) => x.sessionId === sessionId);
    if (!att) throw new Error("未找到该计时会话的实际签到/签退记录");
    const rule = this.rules.at(at);
    const { hourlyCharge } = billing;
    const calc = hourlyCharge({ minutes: att.minutes, rule: rule.rules, crossMidnight: att.crossMidnight });
    this.dispatch(`billing:${childId}`, {
      type: "raiseCharge",
      at,
      chargeId,
      kind: "HOURLY",
      amount: calc.amount,
      sessionId,
      minutes: att.minutes,
      crossMidnight: att.crossMidnight,
      detail: `实际服务 ${att.minutes} 分钟${att.crossMidnight ? "（跨午夜）" : ""}，${calc.blocks} 个计费块${calc.overnightExtra ? "，含夜间附加" : ""}`,
    });
    return { ...calc, minutes: att.minutes, crossMidnight: att.crossMidnight };
  }
}
