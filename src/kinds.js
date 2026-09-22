// 事件种类登记表：覆盖市级统筹要求的全部业务域。
// 各域共用同一事件信封（见 contracts/event.schema.json），
// 深度逻辑由对应模块实现，此处仅登记种类，避免各模块各自拼写字符串。
export const KINDS = {
  // 项目节点与场地（src/sites.js）
  MILESTONE_REACHED: "MILESTONE_REACHED", // 项目节点达成，data.milestone 如 "竣工"
  OPENING_DELAYED: "OPENING_DELAYED", // 竣工后未能按期运营
  SITE_OPENED: "SITE_OPENED", // 点位开始运营

  // 班型与名额（src/slots.js）
  CAPACITY_SET: "CAPACITY_SET", // 某日期某班型名额上限
  BOOKING_PLACED: "BOOKING_PLACED", // 预约成功，携带 rule_version
  BOOKING_CANCELLED: "BOOKING_CANCELLED",

  // 计时托签到与结算（src/settlement.js）
  SESSION_SCHEDULED: "SESSION_SCHEDULED", // 计时托预约时段
  SESSION_RESCHEDULED: "SESSION_RESCHEDULED", // 改期，只改计划时段
  CHECK_IN: "CHECK_IN", // 签到，可能断网补传、乱序到达
  CHECK_OUT: "CHECK_OUT",
  WAIVER_GRANTED: "WAIVER_GRANTED", // 收费减免
  CHARGE_ISSUED: "CHARGE_ISSUED", // 按实际服务时段出具的扣费

  // 婴幼儿签约服务包（src/operations.js）
  PACKAGE_SIGNED: "PACKAGE_SIGNED",

  // 家长授权与儿童健康资料（src/consent.js）
  CONSENT_GRANTED: "CONSENT_GRANTED",
  CONSENT_REVOKED: "CONSENT_REVOKED",
  DATA_ACCESSED: "DATA_ACCESSED", // 机构调阅健康资料的留痕
  RECORD_FORMED: "RECORD_FORMED", // 已形成的安全/医疗记录
  RECORD_CORRECTED: "RECORD_CORRECTED", // 追加更正，永不抹去原记录

  // 保育人员（src/staff.js）
  STAFF_TRAINED: "STAFF_TRAINED", // 培训与资质
  SHIFT_ASSIGNED: "SHIFT_ASSIGNED", // 调班，可能乱序到达

  // 检查与监督整改（src/rectification.js）
  INSPECTION_RECORDED: "INSPECTION_RECORDED", // 消防/食品/伤害预防检查
  RECTIFICATION_REQUIRED: "RECTIFICATION_REQUIRED",
  RECTIFICATION_CONCLUDED: "RECTIFICATION_CONCLUDED", // 整改结论，携带 rule_version
  SUPERVISION_RECEIPT: "SUPERVISION_RECEIPT", // 监管回执，可能乱序到达

  // 社区活动与转介（src/operations.js）
  ACTIVITY_HELD: "ACTIVITY_HELD",
  REFERRAL_MADE: "REFERRAL_MADE",
};
