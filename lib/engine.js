/**
 * 阈值评估领域引擎（纯函数，不依赖 I/O，便于 node --test 直接验证）。
 *
 * 业务语义：
 * - 模型只产出规则分数 score（0~100），不做任何模型化判定；
 *   score >= threshold 的记录被「标记」，进入人工复核队列。
 * - 人工复核只覆盖了部分记录（labelBase / 补判台账），所以指标只能
 *   在「已复核子集」上计算，子集不代表全部设备，评估结果带覆盖说明。
 * - 未查到的设备（found=false）无法人工复核，单独留存为 missing，
 *   不参与准确率/召回率等指标计算。
 */
import { ValidationError } from './errors.js';

export const DECISION_FAULT = 'fault';
export const DECISION_NORMAL = 'normal';

export const SCOPE_GLOBAL = 'global';
export const SCOPE_REGION = 'region';
export const SCOPE_TYPE = 'type';
export const SCOPE_RECORD = 'record';
export const SCOPES = [SCOPE_GLOBAL, SCOPE_REGION, SCOPE_TYPE, SCOPE_RECORD];

/** 阈值搜索使用的候选阈值网格（固定、可复现，不依赖随机数据）。 */
export const THRESHOLD_GRID = [30, 40, 50, 60, 70, 80, 90];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 规则判定：分数达到阈值即标记为需要人工复核。
 */
export function isFlagged(record, threshold) {
  if (!Number.isFinite(threshold)) {
    throw new ValidationError('阈值必须是有限数值', 'INVALID_THRESHOLD');
  }
  if (!record || !Number.isFinite(record.score)) {
    throw new ValidationError('记录缺少有效的规则分数 score', 'INVALID_RECORD');
  }
  return record.score >= threshold;
}

/**
 * 判定一条补判记录的适用范围是否覆盖给定巡检记录。
 * global 覆盖全部；其余范围按对应字段精确匹配。
 */
export function scopeApplies(adjudication, record) {
  if (adjudication.scope === SCOPE_GLOBAL) return true;
  if (adjudication.scope === SCOPE_RECORD) return adjudication.recordId === record.id;
  if (adjudication.scope === SCOPE_REGION) return adjudication.scopeValue === record.region;
  if (adjudication.scope === SCOPE_TYPE) return adjudication.scopeValue === record.type;
  return false;
}

/**
 * 在给定适用范围内构建「事实标签」视图：
 * 初始台账 labelBase 先入表，补判记录按顺序叠加（后写覆盖先写），
 * 只保留范围覆盖当前筛选条件的补判。
 *
 * @returns {{grounded: Map, missing: Array, unlabeled: Array, basis: object}}
 */
export function buildGroundTruth(records, labelBase, adjudications, filter = {}) {
  const grounded = new Map();
  for (const label of labelBase) {
    if (!isNonEmptyString(label.recordId) || ![DECISION_FAULT, DECISION_NORMAL].includes(label.decision)) {
      throw new ValidationError('人工复核台账存在非法条目', 'INVALID_LEDGER');
    }
    grounded.set(label.recordId, {
      decision: label.decision,
      source: 'review_ledger',
      basis: label.basis || '人工复核台账',
    });
  }

  const scope = filter.scope || SCOPE_GLOBAL;
  const scopeValue = filter.scopeValue;
  if (!SCOPES.includes(scope)) {
    throw new ValidationError(`未知适用范围: ${scope}`, 'INVALID_SCOPE');
  }
  if (scope !== SCOPE_GLOBAL && !isNonEmptyString(scopeValue)) {
    throw new ValidationError('非全局范围必须提供 scopeValue', 'INVALID_SCOPE');
  }

  let applied = 0;
  for (const adj of adjudications) {
    if (!SCOPES.includes(adj.scope)) {
      throw new ValidationError(`补判记录的适用范围非法: ${adj.scope}`, 'INVALID_SCOPE');
    }
    // 范围过滤：补判只在其声明的适用范围内被采信。
    // 全局补判在任何范围评估中都生效；局部补判（区域/类型/单记录）
    // 只在同范围同值的评估中生效，全局评估不采信局部判定。
    let inScope;
    if (adj.scope === SCOPE_GLOBAL) {
      inScope = true;
    } else if (scope === SCOPE_GLOBAL) {
      inScope = false;
    } else if (adj.scope === scope && adj.scopeValue === scopeValue) {
      inScope = true;
    } else {
      inScope = false;
    }
    if (!inScope) continue;

    const target = records.find((r) => r.id === adj.recordId);
    if (!target) continue;
    // 补判自身的适用范围还必须覆盖目标记录（防御性校验，正常数据恒成立）。
    if (!scopeApplies(adj, target)) continue;

    grounded.set(adj.recordId, {
      decision: adj.decision,
      source: 'adjudication',
      basis: adj.reason,
      adjudicationId: adj.id,
    });
    applied += 1;
  }

  const missing = [];
  const unlabeled = [];
  for (const record of records) {
    if (record.found === false) {
      missing.push({
        recordId: record.id,
        deviceId: record.deviceId,
        region: record.region,
        type: record.type,
        score: record.score,
        reason: '设备未查到，无法人工复核，不参与指标计算',
      });
      continue;
    }
    if (!grounded.has(record.id)) unlabeled.push(record.id);
  }

  return {
    grounded,
    missing,
    unlabeled,
    basis: { scope, scopeValue: scope === SCOPE_GLOBAL ? null : scopeValue, adjudicationsApplied: applied },
  };
}

function safeRate(numerator, denominator) {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

/**
 * 在指定阈值、指定适用范围上评估一次。
 *
 * @returns {object} 评估快照（含指标、明细、未查到设备、覆盖说明）
 */
export function evaluateAt({ records, labelBase, adjudications, threshold, filter = {}, reviewMinutes = 15 }) {
  if (!Array.isArray(records)) throw new ValidationError('records 必须是数组', 'INVALID_RECORDS');
  if (!Number.isFinite(threshold)) throw new ValidationError('阈值必须是有限数值', 'INVALID_THRESHOLD');
  if (!Number.isFinite(reviewMinutes) || reviewMinutes <= 0) {
    throw new ValidationError('单条复核工时必须是正数', 'INVALID_REVIEW_MINUTES');
  }

  const { grounded, missing, unlabeled, basis } = buildGroundTruth(records, labelBase, adjudications, filter);

  const details = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let flaggedCount = 0;

  for (const record of records) {
    if (record.found === false) continue; // 未查到设备单独留存，不参与混淆矩阵
    const flagged = isFlagged(record, threshold);
    if (flagged) flaggedCount += 1;
    const truth = grounded.get(record.id);
    const row = {
      recordId: record.id,
      deviceId: record.deviceId,
      region: record.region,
      type: record.type,
      score: record.score,
      found: record.found !== false,
      flagged,
      label: truth ? truth.decision : null,
      labelSource: truth ? truth.source : null,
    };
    if (!truth) {
      row.outcome = 'unlabeled';
      details.push(row);
      continue;
    }
    if (flagged && truth.decision === DECISION_FAULT) {
      tp += 1;
      row.outcome = 'tp';
    } else if (flagged && truth.decision === DECISION_NORMAL) {
      fp += 1;
      row.outcome = 'fp';
    } else if (!flagged && truth.decision === DECISION_FAULT) {
      fn += 1;
      row.outcome = 'fn';
    } else {
      tn += 1;
      row.outcome = 'tn';
    }
    details.push(row);
  }

  const labeledCount = tp + fp + fn + tn;
  const faultCount = tp + fn;
  const normalCount = fp + tn;
  const metrics = {
    tp,
    fp,
    fn,
    tn,
    labeledCount,
    unlabeledCount: unlabeled.length,
    missingCount: missing.length,
    totalRecords: records.length,
    // 指标只在已复核子集上成立
    accuracy: safeRate(tp + tn, labeledCount),
    precision: safeRate(tp, tp + fp),
    recall: safeRate(tp, tp + fn),
    missRate: safeRate(fn, tp + fn), // 漏报率（已复核故障视角）
    falseAlarmRate: safeRate(fp, fp + tn), // 误报率（已复核正常视角）
    f1:
      tp + fp === 0 || tp + fn === 0
        ? null
        : Number(((2 * tp) / (2 * tp + fp + fn)).toFixed(4)),
    // 工时按全量标记记录估算（含尚未复核的），未查到设备若被标记同样需要现场处理
    flaggedCount,
    reviewMinutesPerRecord: reviewMinutes,
    estimatedReviewMinutes: flaggedCount * reviewMinutes,
  };

  const caveats = [];
  caveats.push(
    `指标仅基于 ${labeledCount} 条已复核记录计算，另有 ${unlabeled.length} 条已查到但未复核、` +
      `${missing.length} 条设备未查到；复核子集不代表全部设备。`
  );
  if (faultCount === 0) caveats.push('已复核子集中没有故障样本，漏报率/召回率无法计算。');
  if (normalCount === 0) caveats.push('已复核子集中没有正常样本，误报率无法计算。');

  return {
    threshold,
    scope: basis.scope,
    scopeValue: basis.scopeValue,
    adjudicationsApplied: basis.adjudicationsApplied,
    metrics,
    details,
    missing,
    unlabeledRecordIds: unlabeled,
    caveats,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * 阈值搜索：对候选网格逐个评估，返回可比较的完整行集合。
 */
export function thresholdSweep(options) {
  const grid = options.grid || THRESHOLD_GRID;
  if (!Array.isArray(grid) || grid.length === 0) {
    throw new ValidationError('阈值网格不能为空', 'INVALID_GRID');
  }
  const rows = grid.map((threshold) =>
    evaluateAt({ ...options, threshold })
  );
  return rows.map((snapshot) => ({
    threshold: snapshot.threshold,
    ...snapshot.metrics,
    caveats: snapshot.caveats,
  }));
}

/**
 * 两套可比较策略 —— 不允许只挑准确率高的：
 * 1. reduce-miss：优先减少漏报（漏报最少 → 标记最少 → 阈值最高）。
 * 2. save-labor：在漏报不超过原阈值的约束下节约复核工时
 *    （工时最少 → 漏报最少 → 阈值最高）；无可行解时回退原阈值。
 * 另附 accuracy-best 仅作对照展示，不作为推荐。
 */
export function chooseStrategies(sweepRows, originalThreshold, options = {}) {
  const baseline = sweepRows.find((r) => r.threshold === originalThreshold);
  if (!baseline) {
    throw new ValidationError('阈值搜索结果中缺少原阈值行', 'MISSING_BASELINE');
  }
  const maxExtraMisses = Number.isFinite(options.maxExtraMisses) ? options.maxExtraMisses : 1;
  const toleranceFn = Number.isFinite(baseline.fn) ? baseline.fn + maxExtraMisses : Infinity;

  const reduceMiss = [...sweepRows].sort((a, b) => {
    if (a.fn !== b.fn) return a.fn - b.fn;
    if (a.flaggedCount !== b.flaggedCount) return a.flaggedCount - b.flaggedCount;
    return b.threshold - a.threshold;
  })[0];

  const eligible = sweepRows.filter((r) => r.fn <= toleranceFn);
  const saveLaborPool = eligible.length > 0 ? eligible : [baseline];
  const saveLabor = [...saveLaborPool].sort((a, b) => {
    if (a.estimatedReviewMinutes !== b.estimatedReviewMinutes) {
      return a.estimatedReviewMinutes - b.estimatedReviewMinutes;
    }
    if (a.fn !== b.fn) return a.fn - b.fn;
    return b.threshold - a.threshold;
  })[0];

  const accuracyBest = [...sweepRows]
    .filter((r) => r.accuracy !== null)
    .sort((a, b) => {
      if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
      return b.threshold - a.threshold;
    })[0];

  return {
    baseline,
    tolerance: { maxExtraMisses, maxToleratedFn: toleranceFn },
    strategies: {
      'reduce-miss': {
        ...reduceMiss,
        feasible: true,
        rationale: '以减少漏报为首要目标：漏报数最少，其次尽量少标记、节约工时。',
        vsBaseline: diff(baseline, reduceMiss),
      },
      'save-labor': {
        ...saveLabor,
        feasible: eligible.length > 0,
        rationale: `在漏报数不超过 ${toleranceFn}（原阈值 ${baseline.fn} + 容忍 ${maxExtraMisses}）的前提下，复核工时最少。`,
        vsBaseline: diff(baseline, saveLabor),
      },
      'accuracy-best': {
        ...(accuracyBest || baseline),
        feasible: Boolean(accuracyBest),
        rationale: '仅按准确率选出的对照项，不代表漏报/工时最优，不作为推荐。',
        vsBaseline: diff(baseline, accuracyBest || baseline),
      },
    },
  };
}

function diff(baseline, row) {
  return {
    thresholdDelta: row.threshold - baseline.threshold,
    fnDelta: row.fn - baseline.fn,
    flaggedDelta: row.flaggedCount - baseline.flaggedCount,
    reviewMinutesDelta: row.estimatedReviewMinutes - baseline.estimatedReviewMinutes,
    accuracyDelta:
      row.accuracy === null || baseline.accuracy === null
        ? null
        : Number((row.accuracy - baseline.accuracy).toFixed(4)),
    recallDelta:
      row.recall === null || baseline.recall === null
        ? null
        : Number((row.recall - baseline.recall).toFixed(4)),
  };
}

/**
 * 校验并构造一条补判记录（纯函数；是否属于漏报由 store 结合原阈值判定）。
 */
export function buildAdjudication(input, records) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('补判请求体必须是对象', 'INVALID_BODY');
  }
  const recordId = String(input.recordId || '').trim();
  if (!recordId) throw new ValidationError('recordId 不能为空', 'MISSING_RECORD_ID');

  const record = records.find((r) => r.id === recordId);
  if (!record) throw new ValidationError(`记录不存在: ${recordId}`, 'RECORD_NOT_FOUND');
  if (record.found === false) {
    throw new ValidationError('设备未查到的记录不能补判（无法形成事实标签）', 'MISSING_DEVICE');
  }

  const decision = input.decision;
  if (![DECISION_FAULT, DECISION_NORMAL].includes(decision)) {
    throw new ValidationError('decision 只能是 fault 或 normal', 'INVALID_DECISION');
  }

  const scope = input.scope || SCOPE_GLOBAL;
  if (!SCOPES.includes(scope)) {
    throw new ValidationError(`scope 只能是 ${SCOPES.join('/')}`, 'INVALID_SCOPE');
  }

  let scopeValue = null;
  if (scope === SCOPE_REGION) {
    scopeValue = String(input.scopeValue || '').trim();
    if (!scopeValue) throw new ValidationError('区域范围补判必须提供 scopeValue', 'MISSING_SCOPE_VALUE');
    if (record.region !== scopeValue) {
      throw new ValidationError(
        `补判范围与记录不符：记录 ${recordId} 属于区域 ${record.region}，不是 ${scopeValue}`,
        'SCOPE_MISMATCH'
      );
    }
  } else if (scope === SCOPE_TYPE) {
    scopeValue = String(input.scopeValue || '').trim();
    if (!scopeValue) throw new ValidationError('设备类型范围补判必须提供 scopeValue', 'MISSING_SCOPE_VALUE');
    if (record.type !== scopeValue) {
      throw new ValidationError(
        `补判范围与记录不符：记录 ${recordId} 类型为 ${record.type}，不是 ${scopeValue}`,
        'SCOPE_MISMATCH'
      );
    }
  } else if (scope === SCOPE_RECORD) {
    scopeValue = recordId;
  }

  const reason = String(input.reason || '').trim();
  if (!reason) throw new ValidationError('补判必须填写判定依据 reason', 'MISSING_REASON');

  return {
    recordId,
    decision,
    scope,
    scopeValue,
    reason,
  };
}
