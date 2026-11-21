/**
 * 应用状态仓库：
 * - 评估快照只追加不覆盖（旧阈值结果保留），每条快照带序号与适用范围；
 * - 补判台账追加记录，区分 global / region / type / record 适用范围；
 * - 成本权衡基于当前台账实时重算，返回两套可比较策略 + 准确率对照。
 */
import {
  evaluateAt,
  thresholdSweep,
  chooseStrategies,
  buildAdjudication,
  isFlagged,
  SCOPE_GLOBAL,
  DECISION_FAULT,
} from './engine.js';
import { ValidationError } from './errors.js';

export class Store {
  constructor(seed) {
    if (!seed || !Array.isArray(seed.records) || !Array.isArray(seed.labelBase)) {
      throw new ValidationError('初始化数据不完整', 'INVALID_SEED');
    }
    this.config = { ...seed.config };
    this.records = seed.records.map((r) => ({ ...r }));
    this.labelBase = seed.labelBase.map((l) => ({ ...l }));
    this.adjudications = [];
    this.evaluations = []; // 评估快照，append-only
    this._seq = 0;
  }

  get originalThreshold() {
    return this.config.originalThreshold;
  }

  _evalContext(overrides = {}) {
    return {
      records: this.records,
      labelBase: this.labelBase,
      adjudications: this.adjudications,
      reviewMinutes: this.config.reviewMinutesPerRecord,
      ...overrides,
    };
  }

  /**
   * 运行一次评估并留存快照。原阈值评估固定为全局范围；
   * 补判后的重算可带范围，旧快照不会被修改或删除。
   */
  runEvaluation(options = {}) {
    const threshold = options.threshold ?? this.originalThreshold;
    const filter = options.filter || { scope: SCOPE_GLOBAL };
    const snapshot = evaluateAt({
      ...this._evalContext(),
      threshold,
      filter,
    });
    this._seq += 1;
    const stored = {
      seq: this._seq,
      kind: options.kind || (threshold === this.originalThreshold ? 'original' : 'custom'),
      request: {
        threshold,
        scope: filter.scope,
        scopeValue: filter.scopeValue ?? null,
      },
      ...snapshot,
    };
    this.evaluations.push(stored);
    return stored;
  }

  /**
   * 补判一条漏报：
   * - 必须是原阈值下「已查到、未标记、无既有标签」的记录才允许补判为故障；
   * - 补判写入台账并区分适用范围，随后在同一范围内重算并留存新快照；
   * - 历史评估快照原样保留。
   */
  adjudicate(input) {
    const built = buildAdjudication(input, this.records);
    const record = this.records.find((r) => r.id === built.recordId);

    if (this.labelBase.some((l) => l.recordId === built.recordId)) {
      throw new ValidationError(`记录 ${built.recordId} 已在人工复核台账中，不能重复补判`, 'DUPLICATE_LABEL');
    }
    if (this.adjudications.some((a) => a.recordId === built.recordId)) {
      throw new ValidationError(`记录 ${built.recordId} 已补判过，不能重复补判`, 'DUPLICATE_ADJUDICATION');
    }
    if (built.decision !== DECISION_FAULT) {
      throw new ValidationError('本入口用于补判漏报，decision 必须为 fault', 'NOT_A_MISS');
    }
    if (isFlagged(record, this.originalThreshold)) {
      throw new ValidationError(
        `记录 ${built.recordId} 在原阈值 ${this.originalThreshold} 下已被标记，属于复核队列而非漏报`,
        'NOT_A_MISS'
      );
    }

    const adjudication = {
      id: `ADJ-${String(this.adjudications.length + 1).padStart(3, '0')}`,
      createdAt: new Date().toISOString(),
      ...built,
    };
    this.adjudications.push(adjudication);

    const filter =
      adjudication.scope === SCOPE_GLOBAL
        ? { scope: SCOPE_GLOBAL }
        : { scope: adjudication.scope, scopeValue: adjudication.scopeValue };
    const reEvaluation = this.runEvaluation({
      threshold: this.originalThreshold,
      filter,
      kind: 'after-adjudication',
    });

    return {
      adjudication,
      reEvaluation,
      note:
        adjudication.scope === SCOPE_GLOBAL
          ? '全局补判：后续全局评估采信该判定。'
          : `局部补判（${adjudication.scope}=${adjudication.scopeValue}）：仅该范围内的评估采信，全局评估不采信。`,
    };
  }

  /**
   * 成本权衡：基于当前台账重算阈值网格，给出两套可比较结果。
   */
  getTradeoff(options = {}) {
    const filter = options.filter || { scope: SCOPE_GLOBAL };
    const sweepRows = thresholdSweep({
      ...this._evalContext(),
      filter,
      grid: this.config.grid,
    });
    const picked = chooseStrategies(sweepRows, this.originalThreshold, {
      maxExtraMisses: this.config.maxExtraMisses,
    });
    return {
      scope: filter.scope,
      scopeValue: filter.scopeValue ?? null,
      generatedAt: new Date().toISOString(),
      reviewMinutesPerRecord: this.config.reviewMinutesPerRecord,
      tolerance: picked.tolerance,
      sweepRows,
      strategies: picked.strategies,
    };
  }

  getState() {
    return {
      config: this.config,
      counts: {
        totalRecords: this.records.length,
        labelBaseCount: this.labelBase.length,
        adjudicationCount: this.adjudications.length,
        evaluationCount: this.evaluations.length,
      },
      records: this.records,
      labelBase: this.labelBase,
      adjudications: this.adjudications,
      evaluations: this.evaluations,
    };
  }

  getRecord(recordId) {
    const record = this.records.find((r) => r.id === recordId);
    if (!record) throw new ValidationError(`记录不存在: ${recordId}`, 'RECORD_NOT_FOUND');
    return {
      record,
      ledgerLabel: this.labelBase.find((l) => l.recordId === recordId) || null,
      adjudication: this.adjudications.find((a) => a.recordId === recordId) || null,
      flaggedAtOriginal: record.found !== false && isFlagged(record, this.originalThreshold),
    };
  }

  /** 可补判漏报候选：已查到、原阈值未标记、台账与补判中都没有标签。 */
  getMissCandidates() {
    return this.records
      .filter((r) => r.found !== false)
      .filter((r) => !isFlagged(r, this.originalThreshold))
      .filter((r) => !this.labelBase.some((l) => l.recordId === r.id))
      .filter((r) => !this.adjudications.some((a) => a.recordId === r.id))
      .map((r) => ({ ...r }));
  }

  reset(seed) {
    this.config = { ...seed.config };
    this.records = seed.records.map((r) => ({ ...r }));
    this.labelBase = seed.labelBase.map((l) => ({ ...l }));
    this.adjudications = [];
    this.evaluations = [];
    this._seq = 0;
  }
}
