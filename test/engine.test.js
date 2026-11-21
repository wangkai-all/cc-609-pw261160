import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateAt,
  thresholdSweep,
  chooseStrategies,
  buildAdjudication,
  isFlagged,
  scopeApplies,
  THRESHOLD_GRID,
  SCOPE_GLOBAL,
  SCOPE_REGION,
  SCOPE_TYPE,
  SCOPE_RECORD,
} from '../lib/engine.js';
import { createSeedData, ORIGINAL_THRESHOLD } from '../lib/data.js';
import { ValidationError } from '../lib/errors.js';

const seed = createSeedData();
const baseCtx = (overrides = {}) => ({
  records: seed.records,
  labelBase: seed.labelBase,
  adjudications: [],
  threshold: ORIGINAL_THRESHOLD,
  reviewMinutes: seed.config.reviewMinutesPerRecord,
  ...overrides,
});

test('规则分数判定：score>=阈值即标记，且只依赖规则分数', () => {
  const r = seed.records[0];
  assert.equal(isFlagged(r, 60), r.score >= 60);
  assert.equal(isFlagged({ score: 59.99 }, 60), false);
  assert.equal(isFlagged({ score: 60 }, 60), true);
  assert.throws(() => isFlagged({ score: NaN }, 60), ValidationError);
  assert.throws(() => isFlagged({ score: 50 }, Number.NaN), ValidationError);
});

test('原阈值评估：混淆矩阵、指标与工时按预期计算（正常结果）', () => {
  const snap = evaluateAt(baseCtx());
  const m = snap.metrics;
  // 造数在阈值 60 下：TP=4, FP=3, FN=3, TN=4（14 条已复核）
  assert.deepEqual([m.tp, m.fp, m.fn, m.tn], [4, 3, 3, 4]);
  assert.equal(m.labeledCount, 14);
  assert.equal(m.unlabeledCount, 5);
  assert.equal(m.accuracy, Number(((4 + 4) / 14).toFixed(4)));
  assert.equal(m.recall, Number((4 / 7).toFixed(4)));
  assert.equal(m.missRate, Number((3 / 7).toFixed(4)));
  // 已查到 19 条中 9 条被标记 → 9*15=135 分钟
  assert.equal(m.flaggedCount, 9);
  assert.equal(m.estimatedReviewMinutes, 135);
  assert.equal(snap.scope, SCOPE_GLOBAL);
  assert.ok(snap.caveats.some((c) => c.includes('不代表全部设备')));
});

test('未查到设备：留存到 missing，不参与混淆矩阵与工时', () => {
  const snap = evaluateAt(baseCtx());
  assert.equal(snap.missing.length, 1);
  assert.equal(snap.missing[0].recordId, 'R020');
  assert.equal(snap.metrics.missingCount, 1);
  assert.ok(!snap.details.some((d) => d.recordId === 'R020'));
  // 明细行只含已查到设备
  assert.equal(snap.details.length, 19);
});

test('未复核记录：标记为 unlabeled，不进入任何指标分母', () => {
  const snap = evaluateAt(baseCtx());
  const unlabeledRows = snap.details.filter((d) => d.outcome === 'unlabeled');
  assert.equal(unlabeledRows.length, 5);
  assert.deepEqual(unlabeledRows.map((d) => d.recordId).sort(), ['R015', 'R016', 'R017', 'R018', 'R019']);
  assert.equal(snap.metrics.tp + snap.metrics.fp + snap.metrics.fn + snap.metrics.tn, 14);
});

test('阈值搜索：覆盖整个候选网格且每行指标自洽', () => {
  const rows = thresholdSweep(baseCtx({ grid: THRESHOLD_GRID }));
  assert.deepEqual(rows.map((r) => r.threshold), THRESHOLD_GRID);
  for (const r of rows) {
    assert.equal(r.tp + r.fp + r.fn + r.tn, 14);
    assert.equal(r.estimatedReviewMinutes, r.flaggedCount * 15);
    assert.ok(Array.isArray(r.caveats) && r.caveats.length >= 1);
  }
  // 阈值升高，标记数单调不增
  const flagged = rows.map((r) => r.flaggedCount);
  for (let i = 1; i < flagged.length; i++) assert.ok(flagged[i] <= flagged[i - 1]);
});

test('两套策略可比较：减漏报与省工时给出不同方案，且不只挑准确率', () => {
  const rows = thresholdSweep(baseCtx({ grid: THRESHOLD_GRID }));
  const picked = chooseStrategies(rows, ORIGINAL_THRESHOLD, { maxExtraMisses: 1 });
  const a = picked.strategies['reduce-miss'];
  const b = picked.strategies['save-labor'];
  const c = picked.strategies['accuracy-best'];

  // 减漏报：阈值 30 时 FN=0
  assert.equal(a.threshold, 30);
  assert.equal(a.fn, 0);
  assert.equal(a.vsBaseline.fnDelta, -3);
  // 省工时：约束 fn <= 4，阈值 70 工时 75 分钟（80 阈值 FN=5 超约束）
  assert.equal(b.threshold, 70);
  assert.ok(b.fn <= picked.tolerance.maxToleratedFn);
  assert.equal(b.estimatedReviewMinutes, 75);
  assert.equal(b.vsBaseline.reviewMinutesDelta, -60);
  // 准确率对照项是另一阈值（80），证明没有只挑准确率高的
  assert.equal(c.threshold, 80);
  assert.notEqual(a.threshold, c.threshold);
  assert.notEqual(b.threshold, c.threshold);
  // 两个推荐策略必须都带与原阈值的差值
  assert.equal(a.vsBaseline.thresholdDelta, 30 - ORIGINAL_THRESHOLD);
});

test('省工时无可行解时回退原阈值并标记 feasible=false', () => {
  const rows = thresholdSweep(baseCtx({ grid: THRESHOLD_GRID }));
  // 容忍 -1 条额外漏报（即要求 fn <= baseline.fn-1），高阈值不可行，只有更严格的低阈值可行
  const picked = chooseStrategies(rows, ORIGINAL_THRESHOLD, { maxExtraMisses: -1 });
  const b = picked.strategies['save-labor'];
  assert.ok(b.feasible);
  assert.ok(b.fn < picked.baseline.fn);
  // 极端：要求 fn <= -1（不可能），候选为空 → 回退原阈值
  const impossible = chooseStrategies(rows, ORIGINAL_THRESHOLD, { maxExtraMisses: -99 });
  assert.equal(impossible.strategies['save-labor'].feasible, false);
  assert.equal(impossible.strategies['save-labor'].threshold, ORIGINAL_THRESHOLD);
});

test('补判构造：正常输入与字段校验（异常结果）', () => {
  const adj = buildAdjudication(
    { recordId: 'R015', decision: 'fault', scope: SCOPE_GLOBAL, reason: '现场复检确认故障' },
    seed.records
  );
  assert.deepEqual(adj, {
    recordId: 'R015',
    decision: 'fault',
    scope: SCOPE_GLOBAL,
    scopeValue: null,
    reason: '现场复检确认故障',
  });

  assert.throws(() => buildAdjudication({}, seed.records), /recordId/);
  assert.throws(() => buildAdjudication({ recordId: 'R015' }, seed.records), /decision/);
  assert.throws(() => buildAdjudication({ recordId: 'R015', decision: 'fault' }, seed.records), /reason/);
  assert.throws(() => buildAdjudication({ recordId: 'NOPE', decision: 'fault', reason: 'x' }, seed.records), /不存在/);
  assert.throws(
    () => buildAdjudication({ recordId: 'R020', decision: 'fault', reason: 'x' }, seed.records),
    /未查到/
  );
  assert.throws(
    () => buildAdjudication({ recordId: 'R015', decision: 'fault', reason: 'x', scope: 'region' }, seed.records),
    /scopeValue/
  );
  assert.throws(
    () => buildAdjudication({ recordId: 'R015', decision: 'fault', reason: 'x', scope: 'region', scopeValue: '西区' }, seed.records),
    /范围与记录不符/
  );
});

test('补判范围采信：局部判定只在对应范围内生效，全局评估不采信', () => {
  // R015 是东区变压器、分数 78（原阈值会被标记），这里改用低阈值评估观察标签采信
  const adjudications = [
    {
      id: 'ADJ-001',
      recordId: 'R015',
      decision: 'fault',
      scope: SCOPE_REGION,
      scopeValue: '东区',
      reason: '东区专项复检确认',
    },
  ];
  const inRegion = evaluateAt(
    baseCtx({ adjudications, filter: { scope: SCOPE_REGION, scopeValue: '东区' }, threshold: 30 })
  );
  const rowInRegion = inRegion.details.find((d) => d.recordId === 'R015');
  assert.equal(rowInRegion.label, 'fault');
  assert.equal(rowInRegion.labelSource, 'adjudication');
  assert.equal(inRegion.adjudicationsApplied, 1);

  const globalEval = evaluateAt(baseCtx({ adjudications, threshold: 30 }));
  const rowGlobal = globalEval.details.find((d) => d.recordId === 'R015');
  assert.equal(rowGlobal.label, null);
  assert.equal(rowGlobal.outcome, 'unlabeled');
  assert.equal(globalEval.adjudicationsApplied, 0);

  // 别的区域评估也不采信
  const otherRegion = evaluateAt(
    baseCtx({ adjudications, filter: { scope: SCOPE_REGION, scopeValue: '西区' }, threshold: 30 })
  );
  assert.equal(otherRegion.details.find((d) => d.recordId === 'R015').outcome, 'unlabeled');
});

test('全局补判在局部评估中同样生效；record 范围仅覆盖单条记录', () => {
  const globalAdj = [
    { id: 'ADJ-001', recordId: 'R016', decision: 'normal', scope: SCOPE_GLOBAL, scopeValue: null, reason: '全局抽检正常' },
  ];
  const regionEval = evaluateAt(
    baseCtx({ adjudications: globalAdj, filter: { scope: SCOPE_REGION, scopeValue: '西区' }, threshold: 30 })
  );
  assert.equal(regionEval.details.find((d) => d.recordId === 'R016').label, 'normal');

  const recordAdj = [
    { id: 'ADJ-002', recordId: 'R017', decision: 'fault', scope: SCOPE_RECORD, scopeValue: 'R017', reason: '单记录复判' },
  ];
  const recordEval = evaluateAt(
    baseCtx({ adjudications: recordAdj, filter: { scope: SCOPE_RECORD, scopeValue: 'R017' }, threshold: 30 })
  );
  assert.equal(recordEval.details.find((d) => d.recordId === 'R017').label, 'fault');
  const globalEval = evaluateAt(baseCtx({ adjudications: recordAdj, threshold: 30 }));
  assert.equal(globalEval.details.find((d) => d.recordId === 'R017').outcome, 'unlabeled');
});

test('scopeApplies 范围匹配规则', () => {
  const r = seed.records.find((x) => x.id === 'R001'); // 北区变压器
  assert.equal(scopeApplies({ scope: SCOPE_GLOBAL }, r), true);
  assert.equal(scopeApplies({ scope: SCOPE_REGION, scopeValue: '北区' }, r), true);
  assert.equal(scopeApplies({ scope: SCOPE_REGION, scopeValue: '南区' }, r), false);
  assert.equal(scopeApplies({ scope: SCOPE_TYPE, scopeValue: '变压器' }, r), true);
  assert.equal(scopeApplies({ scope: SCOPE_RECORD, recordId: 'R001' }, r), true);
  assert.equal(scopeApplies({ scope: SCOPE_RECORD, recordId: 'R002' }, r), false);
});

test('评估异常：空标签子集指标返回 null 并给出提示', () => {
  const emptyLabelSnap = evaluateAt({
    records: seed.records.filter((r) => r.found !== false),
    labelBase: [],
    adjudications: [],
    threshold: ORIGINAL_THRESHOLD,
  });
  assert.equal(emptyLabelSnap.metrics.labeledCount, 0);
  assert.equal(emptyLabelSnap.metrics.accuracy, null);
  assert.equal(emptyLabelSnap.metrics.recall, null);
  assert.ok(emptyLabelSnap.caveats.some((c) => c.includes('没有故障样本')));
  assert.throws(() => evaluateAt(baseCtx({ reviewMinutes: 0 })), /复核工时/);
  assert.throws(() => evaluateAt(baseCtx({ threshold: 'x' })), /阈值/);
});
