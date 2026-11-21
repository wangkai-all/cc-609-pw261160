/**
 * 本地构造的巡检数据（确定性数据，不使用随机生成），用于把流程跑通。
 *
 * 组成：
 * - 20 条巡检记录，模型只产出规则分数 score（0~100）；
 * - 14 条已人工复核台账（7 故障 / 7 正常）；
 * - 5 条已查到但尚未复核（unlabeled，可补判）；
 * - 1 条设备未查到（found=false，留存但不参与指标）。
 */

export const ORIGINAL_THRESHOLD = 60;
export const REVIEW_MINUTES_PER_RECORD = 15;
export const MAX_EXTRA_MISSES = 1;

export const records = [
  { id: 'R001', deviceId: 'DEV-001', region: '北区', type: '变压器', score: 95, found: true },
  { id: 'R002', deviceId: 'DEV-002', region: '南区', type: '开关柜', score: 72, found: true },
  { id: 'R003', deviceId: 'DEV-003', region: '东区', type: '电缆', score: 61, found: true },
  { id: 'R004', deviceId: 'DEV-004', region: '北区', type: '变压器', score: 55, found: true },
  { id: 'R005', deviceId: 'DEV-005', region: '南区', type: '电缆', score: 45, found: true },
  { id: 'R006', deviceId: 'DEV-006', region: '西区', type: '开关柜', score: 35, found: true },
  { id: 'R007', deviceId: 'DEV-007', region: '东区', type: '变压器', score: 82, found: true },
  { id: 'R008', deviceId: 'DEV-008', region: '北区', type: '开关柜', score: 78, found: true },
  { id: 'R009', deviceId: 'DEV-009', region: '南区', type: '变压器', score: 66, found: true },
  { id: 'R010', deviceId: 'DEV-010', region: '西区', type: '电缆', score: 60, found: true },
  { id: 'R011', deviceId: 'DEV-011', region: '北区', type: '电缆', score: 58, found: true },
  { id: 'R012', deviceId: 'DEV-012', region: '东区', type: '开关柜', score: 50, found: true },
  { id: 'R013', deviceId: 'DEV-013', region: '南区', type: '变压器', score: 42, found: true },
  { id: 'R014', deviceId: 'DEV-014', region: '西区', type: '电缆', score: 28, found: true },
  { id: 'R015', deviceId: 'DEV-015', region: '东区', type: '变压器', score: 78, found: true },
  { id: 'R016', deviceId: 'DEV-016', region: '西区', type: '电缆', score: 63, found: true },
  { id: 'R017', deviceId: 'DEV-017', region: '南区', type: '开关柜', score: 52, found: true },
  { id: 'R018', deviceId: 'DEV-018', region: '北区', type: '电缆', score: 40, found: true },
  { id: 'R019', deviceId: 'DEV-019', region: '东区', type: '开关柜', score: 33, found: true },
  { id: 'R020', deviceId: 'DEV-020', region: '西区', type: '变压器', score: 65, found: false },
];

export const labelBase = [
  { recordId: 'R001', decision: 'fault', basis: '人工复核：油温异常伴放电痕迹' },
  { recordId: 'R002', decision: 'fault', basis: '人工复核：触头烧蚀' },
  { recordId: 'R003', decision: 'fault', basis: '人工复核：局放超标' },
  { recordId: 'R004', decision: 'fault', basis: '人工复核：复检确认绝缘老化' },
  { recordId: 'R005', decision: 'fault', basis: '人工复核：电缆接头过热' },
  { recordId: 'R006', decision: 'fault', basis: '人工复核：停电检查确认机械卡涩' },
  { recordId: 'R007', decision: 'fault', basis: '人工复核：瓦斯继电器动作' },
  { recordId: 'R008', decision: 'normal', basis: '人工复核：告警为负荷波动，设备正常' },
  { recordId: 'R009', decision: 'normal', basis: '人工复核：测温正常' },
  { recordId: 'R010', decision: 'normal', basis: '人工复核：现场无异常' },
  { recordId: 'R011', decision: 'normal', basis: '人工复核：例行检查正常' },
  { recordId: 'R012', decision: 'normal', basis: '人工复核：局放测试正常' },
  { recordId: 'R013', decision: 'normal', basis: '人工复核：油色谱正常' },
  { recordId: 'R014', decision: 'normal', basis: '人工复核：外观与试验均正常' },
];

export function createSeedData() {
  return {
    config: {
      originalThreshold: ORIGINAL_THRESHOLD,
      reviewMinutesPerRecord: REVIEW_MINUTES_PER_RECORD,
      maxExtraMisses: MAX_EXTRA_MISSES,
      grid: [30, 40, 50, 60, 70, 80, 90],
    },
    records: records.map((r) => ({ ...r })),
    labelBase: labelBase.map((l) => ({ ...l })),
  };
}
