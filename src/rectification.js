import { KINDS } from "./kinds.js";

export const CASE_SUBJECT = (caseId) => `case:${caseId}`;

// 检查与整改投影。监管回执可能乱序到达，
// 按 version 排序后依次落位；结论事件携带 rule_version，
// 整改结论依据哪一版检查标准可以随时复查。
export function caseProjection(events) {
  const state = {
    inspection: null, // 消防/食品/伤害预防检查记录
    requirement: null, // 整改要求与期限
    conclusion: null, // 整改结论（含 rule_version）
    receipts: [], // 监管回执
  };
  for (const e of events) {
    switch (e.kind) {
      case KINDS.INSPECTION_RECORDED:
        state.inspection = { ...e.data, at: e.occurred_at };
        break;
      case KINDS.RECTIFICATION_REQUIRED:
        state.requirement = { ...e.data, at: e.occurred_at };
        break;
      case KINDS.RECTIFICATION_CONCLUDED:
        state.conclusion = {
          ...e.data,
          at: e.occurred_at,
          rule_version: e.data.rule_version ?? null,
        };
        break;
      case KINDS.SUPERVISION_RECEIPT:
        state.receipts.push({ ...e.data, at: e.occurred_at });
        break;
    }
  }
  return state;
}
