// 读模型：全部由事件折叠得到，乱序到达后重新折叠即收敛到同一真相。
// 提供四类视图：
//   familyAvailability  家庭端真实可预约状态（点位运营 + 容量 + 保育配备）
//   cityNetwork          市级 1+N 网络（含竣工延期爆炸半径隔离的直观呈现）
//   ruleProvenance       名额/照护决定/整改结论基于哪一版规则
//   consentLedger        授权与健康资料共享/撤回/更正台账

import { occupancyOn } from "./domain/catalog.js";
import { coverageOn } from "./domain/staff.js";
import { balance } from "./domain/billing.js";

export class ReadModels {
  constructor(sys) {
    this.sys = sys;
  }

  // 家庭端：某点位某日各班型的真实可约数。
  familyAvailability(siteId, date) {
    const siteState = this.sys.state(`site:${siteId}`);
    const catalog = this.sys.state(`catalog:${siteId}`);
    const roster = this.sys.state(`staff:${siteId}`);
    const rule = this.sys.rules.at(`${date}T09:00:00+08:00`).rules;
    const siteOpen = siteState?.status === "OPERATING";
    const rows = [];
    for (const o of catalog.offerings.values()) {
      if (!o.active) continue;
      const sessions = o.type === "HALF" ? ["AM", "PM"] : [null];
      for (const session of sessions) {
        const occ = occupancyOn(catalog, o.offeringId, date, session);
        const cov = coverageOn(roster, date, session);
        const need = o.type === "HALF" ? rule.min_caregivers_per_session ?? 1 : rule.min_caregivers_per_session ?? 1;
        const staffed = cov.validCredential >= need;
        const available = siteOpen && staffed ? Math.max(occ.available, 0) : 0;
        rows.push({
          offeringId: o.offeringId,
          type: o.type,
          name: o.name,
          session: session ?? "ALL_DAY",
          capacity: occ.capacity,
          held: occ.held,
          available,
          bookable: available > 0,
          reasons: [
            ...(siteOpen ? [] : ["点位未运营"]),
            ...(staffed ? [] : [`持证保育人员不足（需 ${need}，实到 ${cov.validCredential}）`]),
            ...(occ.available <= 0 ? ["容量约满"] : []),
          ],
        });
      }
    }
    return { siteId, date, siteStatus: siteState?.status ?? "UNKNOWN", ruleVersion: this.sys.rules.versionAt(`${date}T09:00:00+08:00`), rows };
  }

  // 市级 1+N 网络。延期事件只出现在具体点位，其他点位状态不受影响。
  cityNetwork(city) {
    const sites = [];
    for (const [subjectId] of this.sys.store.streams) {
      if (!subjectId.startsWith("site:")) continue;
      const s = this.sys.state(subjectId);
      if (s?.city !== city) continue;
      sites.push({
        siteId: s.id,
        name: s.name,
        kind: s.kind,
        roleInNetwork: s.kind === "CENTER" ? "1-中心" : "N-网点",
        status: s.status,
        plannedCompletion: s.plannedCompletion,
        completionAt: s.completionAt,
        operateBy: s.operateBy,
        openedAt: s.openedAt,
        overdue: s.overdue,
        postponements: s.postponements.length,
        servingChildren: s.status === "OPERATING",
      });
    }
    const center = sites.filter((s) => s.kind === "CENTER");
    const nodes = sites.filter((s) => s.kind !== "CENTER");
    const operatingNodes = nodes.filter((s) => s.servingChildren).length;
    return {
      city,
      shape: `1+${nodes.length}`,
      centers: center.length,
      nodes: nodes.length,
      operatingNodes,
      // 关键断言：延期中的中心不影响社区/单位点位运营。
      networkServing: operatingNodes + center.filter((s) => s.servingChildren).length,
      sites: sites.sort((a, b) => (a.kind === "CENTER" ? -1 : 1)),
    };
  }

  // 规则溯源：把某主体流内"做过结论"的事件连同规则版本内容列出。
  ruleProvenance(subjectId) {
    const events = this.sys.store.load(subjectId);
    const interesting = new Set(["SEAT_RESERVED", "SEAT_CONFIRMED", "BOOKING_RESCHEDULED", "CARE_DECISION_MADE", "RECTIFICATION_RECEIPTED", "CHARGE_RAISED", "OPERATIONS_OPENED"]);
    return events
      .filter((e) => interesting.has(e.kind))
      .map((e) => ({
        event_id: e.event_id,
        kind: e.kind,
        occurred_at: e.occurred_at,
        streamVersion: e.version,
        rule_version: e.rule_version,
        rule: e.rule_version ? this.sys.rules.explain(e.rule_version) : null,
      }));
  }

  // 授权台账：每个授权、共享记录的现状，以及撤回后的两种处理结果。
  consentLedger(childId) {
    const s = this.sys.state(`child:${childId}`);
    if (!s) return null;
    const records = [...s.healthRecords.values()].map((r) => {
      const grant = s.consents.get(r.grantId);
      return {
        recordId: r.recordId,
        title: r.title,
        orgId: r.orgId,
        grantId: r.grantId,
        accessStatus: r.accessStatus, // OPEN / CLOSED
        usedForCare: r.usedForCare,
        usedAt: r.usedAt,
        closedAt: r.closedAt ?? null,
        corrections: r.corrections.length,
        // 撤回后：未用于照护 -> 停止共享(CLOSED)；已用于照护 -> 原记录留存，仅可追加更正。
        disposition: r.usedForCare ? "已形成照护记录：保留，仅允许追加更正" : r.accessStatus === "CLOSED" ? "撤回时未用于照护：已停止共享" : "共享中",
        grantStatus: grant?.status ?? "UNKNOWN",
      };
    });
    return {
      childId,
      siteId: s.siteId,
      providerOrgId: s.providerOrgId,
      consents: [...s.consents.values()].map((g) => ({ grantId: g.grantId, orgId: g.orgId, scopes: g.scopes, status: g.status, grantedAt: g.grantedAt, withdrawnAt: g.withdrawnAt })),
      records,
      attendance: s.attendance,
      decisions: s.decisions.map((d) => ({ decisionId: d.decisionId, title: d.title, ruleVersion: d.ruleVersion, basedOnRecords: d.basedOnRecords, at: d.at })),
      referrals: s.referrals,
    };
  }

  // 账单与减免概览。
  billingView(childId) {
    const b = this.sys.state(`billing:${childId}`);
    if (!b || !b.childId) return null;
    return {
      childId,
      charges: [...b.charges.values()],
      adjustments: b.adjustments,
      payments: b.payments,
      balance: balance(b),
    };
  }
}
