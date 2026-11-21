import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../lib/store.js';
import { createSeedData, ORIGINAL_THRESHOLD } from '../lib/data.js';
import { ValidationError } from '../lib/errors.js';

function newStore() {
  return new Store(createSeedData());
}

test('原阈值评估快照留存，重复运行只追加不覆盖', () => {
  const store = newStore();
  const first = store.runEvaluation({ threshold: ORIGINAL_THRESHOLD, kind: 'original' });
  const second = store.runEvaluation({ threshold: ORIGINAL_THRESHOLD, kind: 'original' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(store.getState().evaluations.length, 2);
  // 旧快照内容不被后续运行修改
  assert.deepEqual(first.metrics, { ...first.metrics });
  assert.equal(store.getState().evaluations[0].seq, 1);
});

test('补判一条漏报：写入台账、同范围重算、旧快照保留', () => {
  const store = newStore();
  const before = store.runEvaluation({ threshold: ORIGINAL_THRESHOLD, kind: 'original' });
  const beforeFn = before.metrics.fn;

  // R016：西区电缆、63 分（原阈值下标记，不能作为漏报补判）——先确认候选不含它
  const candidates = store.getMissCandidates();
  assert.ok(!candidates.some((r) => r.id === 'R016'));
  // R015：东区变压器、78 分但无标签且被标记 → 也不是候选
  assert.ok(!candidates.some((r) => r.id === 'R015'));
  // R017：南区开关柜、52 分、无标签、未标记 → 候选
  assert.ok(candidates.some((r) => r.id === 'R017'));

  const result = store.adjudicate({
    recordId: 'R017',
    decision: 'fault',
    scope: 'region',
    scopeValue: '南区',
    reason: '南区夜巡发现内部放电',
  });
  assert.equal(result.adjudication.id, 'ADJ-001');
  assert.equal(result.adjudication.scope, 'region');
  assert.equal(result.reEvaluation.scope, 'region');
  assert.equal(result.reEvaluation.scopeValue, '南区');

  // 旧快照原样保留
  const evals = store.getState().evaluations;
  assert.equal(evals.length, 2);
  assert.equal(evals[0].metrics.fn, beforeFn);
  assert.equal(evals[0].scope, 'global');

  // 南区评估采信补判：R017 在阈值 60 下未标记且标签为故障 → 新增一条 FN
  const r17 = result.reEvaluation.details.find((d) => d.recordId === 'R017');
  assert.equal(r17.label, 'fault');
  assert.equal(r17.outcome, 'fn');
  assert.equal(r17.labelSource, 'adjudication');

  // 全局评估不采信局部补判
  const globalSnap = store.runEvaluation({ threshold: ORIGINAL_THRESHOLD });
  assert.equal(globalSnap.details.find((d) => d.recordId === 'R017').outcome, 'unlabeled');
});

test('全局补判会改变全局评估的漏报数，且历史快照不动', () => {
  const store = newStore();
  const baseline = store.runEvaluation({ threshold: ORIGINAL_THRESHOLD, kind: 'original' });
  // R019：东区开关柜、33 分、无标签、未标记 → 全局补判故障后在全局评估中成为 FN
  const result = store.adjudicate({
    recordId: 'R019',
    decision: 'fault',
    scope: 'global',
    reason: '全局专项排查确认故障',
  });
  assert.equal(result.reEvaluation.scope, 'global');
  assert.equal(result.reEvaluation.metrics.fn, baseline.metrics.fn + 1);
  assert.equal(result.reEvaluation.metrics.labeledCount, baseline.metrics.labeledCount + 1);
  assert.equal(store.getState().evaluations[0].metrics.fn, baseline.metrics.fn);
});

test('补判异常路径（覆盖题中异常结果）', () => {
  const store = newStore();
  // 已在人工复核台账中的记录不能补判
  assert.throws(
    () => store.adjudicate({ recordId: 'R004', decision: 'fault', scope: 'global', reason: 'x' }),
    (e) => e instanceof ValidationError && e.code === 'DUPLICATE_LABEL'
  );
  // 原阈值已标记的无标签记录不属于漏报
  assert.throws(
    () => store.adjudicate({ recordId: 'R015', decision: 'fault', scope: 'global', reason: 'x' }),
    (e) => e.code === 'NOT_A_MISS'
  );
  // 未查到设备不能补判
  assert.throws(
    () => store.adjudicate({ recordId: 'R020', decision: 'fault', scope: 'global', reason: 'x' }),
    (e) => e.code === 'MISSING_DEVICE'
  );
  // 不存在的记录
  assert.throws(
    () => store.adjudicate({ recordId: 'R404', decision: 'fault', scope: 'global', reason: 'x' }),
    (e) => e.code === 'RECORD_NOT_FOUND'
  );
  // 正常补判一次后重复补判
  store.adjudicate({ recordId: 'R017', decision: 'fault', scope: 'global', reason: '首次补判' });
  assert.throws(
    () => store.adjudicate({ recordId: 'R017', decision: 'fault', scope: 'global', reason: '再次补判' }),
    (e) => e.code === 'DUPLICATE_ADJUDICATION'
  );
  // 缺依据
  assert.throws(
    () => store.adjudicate({ recordId: 'R018', decision: 'fault', scope: 'global' }),
    /reason/
  );
});

test('成本权衡基于当前台账实时重算，两套策略与网格行齐全', () => {
  const store = newStore();
  const t1 = store.getTradeoff();
  assert.equal(t1.sweepRows.length, store.config.grid.length);
  assert.ok(t1.strategies['reduce-miss']);
  assert.ok(t1.strategies['save-labor']);
  assert.ok(t1.strategies['accuracy-best']);
  assert.equal(t1.strategies['reduce-miss'].fn, 0);

  // 全局补判 R019（33 分）为故障后重算：
  // 阈值 <=30 时该记录仍被标记（TP+1），阈值 >=40 时未标记且标签为故障（FN+1）。
  store.adjudicate({ recordId: 'R019', decision: 'fault', scope: 'global', reason: '补判' });
  const t2 = store.getTradeoff();
  for (let i = 0; i < t1.sweepRows.length; i++) {
    const rowBefore = t1.sweepRows[i];
    const rowAfter = t2.sweepRows[i];
    if (rowBefore.threshold <= 33) {
      assert.equal(rowAfter.tp, rowBefore.tp + 1);
      assert.equal(rowAfter.fn, rowBefore.fn);
    } else {
      assert.equal(rowAfter.fn, rowBefore.fn + 1);
      assert.equal(rowAfter.tp, rowBefore.tp);
    }
    assert.equal(rowAfter.labeledCount, rowBefore.labeledCount + 1);
  }
  // 原阈值 60 > 33，因此原阈值行 FN 恰好 +1
  const baseAfter = t2.sweepRows.find((r) => r.threshold === ORIGINAL_THRESHOLD);
  const baseBefore = t1.sweepRows.find((r) => r.threshold === ORIGINAL_THRESHOLD);
  assert.equal(baseAfter.fn, baseBefore.fn + 1);
});

test('局部成本权衡只采信对应范围的补判', () => {
  const store = newStore();
  store.adjudicate({
    recordId: 'R017',
    decision: 'fault',
    scope: 'region',
    scopeValue: '南区',
    reason: '南区补判',
  });
  const south = store.getTradeoff({ filter: { scope: 'region', scopeValue: '南区' } });
  const globalT = store.getTradeoff();
  const southBaseline = south.sweepRows.find((r) => r.threshold === ORIGINAL_THRESHOLD);
  const globalBaseline = globalT.sweepRows.find((r) => r.threshold === ORIGINAL_THRESHOLD);
  assert.equal(southBaseline.fn, globalBaseline.fn + 1);

  assert.throws(
    () => store.getTradeoff({ filter: { scope: 'region' } }),
    /scopeValue/
  );
});

test('reset 恢复初始状态', () => {
  const store = newStore();
  store.runEvaluation({ kind: 'original' });
  store.adjudicate({ recordId: 'R017', decision: 'fault', scope: 'global', reason: 'x' });
  store.reset(createSeedData());
  const state = store.getState();
  assert.equal(state.evaluations.length, 0);
  assert.equal(state.adjudications.length, 0);
  assert.equal(state.records.length, 20);
});
