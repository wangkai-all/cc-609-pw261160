/* 巡检阈值评估协作台前端逻辑（无框架、无依赖） */
'use strict';

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $('#status-text'),
  configSummary: $('#config-summary'),
  countSummary: $('#count-summary'),
  btnOriginal: $('#btn-run-original'),
  adjForm: $('#adj-form'),
  adjRecord: $('#adj-record'),
  adjScope: $('#adj-scope'),
  adjScopeValue: $('#adj-scope-value'),
  adjReason: $('#adj-reason'),
  tradeScope: $('#trade-scope'),
  tradeScopeValue: $('#trade-scope-value'),
  btnTradeoff: $('#btn-tradeoff'),
  btnReset: $('#btn-reset'),
  latest: $('#latest-evaluation'),
  tradeoff: $('#tradeoff'),
  history: $('#evaluation-history'),
  ledger: $('#adjudication-ledger'),
  missing: $('#missing-devices'),
  details: $('#record-details'),
};

let currentState = null;
let latestEvaluation = null;
let currentTradeoff = null;
let missCandidates = [];

function setStatus(message, level = 'ok') {
  els.status.textContent = message;
  els.status.className = level;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    const err = new Error(payload.error?.message || `请求失败 (${res.status})`);
    err.code = payload.error?.code;
    throw err;
  }
  return payload.data;
}

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v) => (v === null || v === undefined ? '—' : String(v));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const OUTCOME_LABEL = {
  tp: '命中故障 TP',
  fp: '误报 FP',
  fn: '漏报 FN',
  tn: '正常排除 TN',
  unlabeled: '未复核',
};

function metricCards(m) {
  const items = [
    ['准确率（已复核子集）', pct(m.accuracy)],
    ['召回率', pct(m.recall)],
    ['漏报率', pct(m.missRate)],
    ['精确率', pct(m.precision)],
    ['误报率', pct(m.falseAlarmRate)],
    ['F1', num(m.f1)],
    ['TP / FN', `${m.tp} / ${m.fn}`],
    ['FP / TN', `${m.fp} / ${m.tn}`],
    ['标记复核数', `${m.flaggedCount} 条`],
    ['估算复核工时', `${m.estimatedReviewMinutes} 分钟`],
    ['已复核 / 未复核', `${m.labeledCount} / ${m.unlabeledCount}`],
    ['未查到设备', `${m.missingCount} 条`],
  ];
  return `<div class="metrics-grid">${items
    .map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('')}</div>`;
}

function caveatsBlock(caveats) {
  return `<div class="caveats"><strong>适用范围与覆盖说明：</strong><ul>${caveats
    .map((c) => `<li>${esc(c)}</li>`)
    .join('')}</ul></div>`;
}

function scopeBadge(scope, scopeValue) {
  const text = scope === 'global' ? '全局' : scope === 'region' ? `区域:${scopeValue}` : scope === 'type' ? `类型:${scopeValue}` : `记录:${scopeValue}`;
  return `<span class="badge scope-${esc(scope)}">${esc(text)}</span>`;
}

function renderEvaluation(snapshot, title = '') {
  if (!snapshot) return '<p class="empty">暂无评估结果。</p>';
  return `
    <div>
      <strong>${esc(title)}</strong>
      ${scopeBadge(snapshot.scope, snapshot.scopeValue)}
      <span class="hint mono">阈值 ${snapshot.threshold} · 快照 #${snapshot.seq ?? '-'} · ${esc(snapshot.evaluatedAt)}</span>
    </div>
    ${metricCards(snapshot.metrics)}
    ${caveatsBlock(snapshot.caveats)}`;
}

function renderLatest() {
  els.latest.innerHTML = renderEvaluation(latestEvaluation, '最新一次评估快照');
}

function renderHistory() {
  const evals = currentState.evaluations || [];
  if (evals.length === 0) {
    els.history.innerHTML = '<p class="empty">暂无评估快照。</p>';
    return;
  }
  const rows = evals
    .slice()
    .reverse()
    .map(
      (e) => `
      <tr>
        <td class="num">#${e.seq}</td>
        <td>${esc(e.kind)}</td>
        <td class="num">${e.threshold}</td>
        <td>${scopeBadge(e.scope, e.scopeValue)}</td>
        <td class="num">${e.metrics.tp}</td>
        <td class="num">${e.metrics.fp}</td>
        <td class="num">${e.metrics.fn}</td>
        <td class="num">${e.metrics.tn}</td>
        <td class="num">${pct(e.metrics.recall)}</td>
        <td class="num">${pct(e.metrics.missRate)}</td>
        <td class="num">${e.metrics.estimatedReviewMinutes}</td>
        <td class="num">${e.metrics.labeledCount}/${e.metrics.unlabeledCount}/${e.metrics.missingCount}</td>
        <td class="mono">${esc(e.evaluatedAt)}</td>
      </tr>`
    )
    .join('');
  els.history.innerHTML = `
    <table>
      <thead><tr>
        <th class="num">#</th><th>类型</th><th class="num">阈值</th><th>范围</th>
        <th class="num">TP</th><th class="num">FP</th><th class="num">FN</th><th class="num">TN</th>
        <th class="num">召回</th><th class="num">漏报率</th><th class="num">工时(分)</th>
        <th class="num">已复核/未复核/未查到</th><th>时间</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderLedger() {
  const baseRows = currentState.labelBase.map((l) => ({
    id: '台账',
    recordId: l.recordId,
    decision: l.decision,
    scope: 'global',
    scopeValue: null,
    reason: l.basis,
    createdAt: '初始数据',
    source: 'review_ledger',
  }));
  const adjRows = currentState.adjudications.map((a) => ({ ...a, source: 'adjudication' }));
  const all = [...baseRows, ...adjRows];
  els.ledger.innerHTML = `
    <table>
      <thead><tr><th>来源</th><th>记录</th><th>判定</th><th>适用范围</th><th>依据</th><th>时间</th></tr></thead>
      <tbody>${all
        .map(
          (r) => `
        <tr>
          <td>${r.source === 'review_ledger' ? '人工复核' : '补判 ' + esc(r.id)}</td>
          <td class="mono">${esc(r.recordId)}</td>
          <td><span class="badge ${r.decision === 'fault' ? 'fn' : 'tn'}">${r.decision === 'fault' ? '故障' : '正常'}</span></td>
          <td>${scopeBadge(r.scope, r.scopeValue)}</td>
          <td>${esc(r.reason)}</td>
          <td class="mono">${esc(r.createdAt)}</td>
        </tr>`
        )
        .join('')}</tbody>
    </table>
    <p class="hint">共 ${baseRows.length} 条人工复核 + ${adjRows.length} 条补判；被复核记录不代表全部设备。</p>`;
}

function renderMissing() {
  const latestMissing = latestEvaluation?.missing ?? currentState.records.filter((r) => r.found === false);
  if (!latestMissing || latestMissing.length === 0) {
    els.missing.innerHTML = '<p class="empty">无未查到设备。</p>';
    return;
  }
  els.missing.innerHTML = `
    <table>
      <thead><tr><th>记录</th><th>设备</th><th>区域</th><th>类型</th><th class="num">规则分数</th><th>说明</th></tr></thead>
      <tbody>${latestMissing
        .map(
          (r) => `
        <tr>
          <td class="mono">${esc(r.recordId)}</td><td class="mono">${esc(r.deviceId)}</td>
          <td>${esc(r.region)}</td><td>${esc(r.type)}</td><td class="num">${r.score}</td>
          <td>${esc(r.reason || '设备未查到，无法人工复核')}</td>
        </tr>`
        )
        .join('')}</tbody>
    </table>`;
}

function renderDetails() {
  const detailMap = new Map((latestEvaluation?.details ?? []).map((d) => [d.recordId, d]));
  const rows = currentState.records.map((r) => {
    const d = detailMap.get(r.id);
    if (r.found === false) {
      return `<tr>
        <td class="mono">${esc(r.id)}</td><td class="mono">${esc(r.deviceId)}</td>
        <td>${esc(r.region)}</td><td>${esc(r.type)}</td><td class="num">${r.score}</td>
        <td><span class="badge missing">未查到</span></td><td>—</td><td>—</td><td>${esc('留存，不参与指标')}</td>
      </tr>`;
    }
    const flagged = d ? d.flagged : r.score >= currentState.config.originalThreshold;
    const outcome = d ? d.outcome : 'unlabeled';
    return `<tr>
      <td class="mono">${esc(r.id)}</td><td class="mono">${esc(r.deviceId)}</td>
      <td>${esc(r.region)}</td><td>${esc(r.type)}</td><td class="num">${r.score}</td>
      <td>${flagged ? '标记复核' : '未标记'}</td>
      <td><span class="badge ${esc(outcome)}">${OUTCOME_LABEL[outcome] || outcome}</span></td>
      <td>${d?.label ? (d.label === 'fault' ? '故障' : '正常') : '—'}</td>
      <td>${esc(d?.labelSource === 'adjudication' ? '补判' : d?.labelSource === 'review_ledger' ? '人工复核' : '尚无标签')}</td>
    </tr>`;
  });
  els.details.innerHTML = `
    <table>
      <thead><tr>
        <th>记录</th><th>设备</th><th>区域</th><th>类型</th><th class="num">规则分数</th>
        <th>原阈值标记</th><th>最新评估归类</th><th>事实标签</th><th>标签来源</th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

function deltaCell(v, unit = '', goodWhenNegative = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return '<span class="delta-zero">—</span>';
  if (v === 0) return `<span class="delta-zero">±0${unit}</span>`;
  const sign = v > 0 ? '+' : '';
  const good = goodWhenNegative ? v < 0 : v > 0;
  return `<span class="${good ? 'delta-neg' : 'delta-pos'}">${sign}${v}${unit}</span>`;
}

function renderTradeoff() {
  if (!currentTradeoff) {
    els.tradeoff.innerHTML = '<p class="empty">尚未查看成本权衡。</p>';
    return;
  }
  const t = currentTradeoff;
  const sweepTable = `
    <h3>阈值网格全量结果（不挑拣，全部可比较）</h3>
    <table>
      <thead><tr>
        <th class="num">阈值</th><th class="num">TP</th><th class="num">FN(漏报)</th><th class="num">FP</th><th class="num">TN</th>
        <th class="num">召回率</th><th class="num">漏报率</th><th class="num">准确率</th>
        <th class="num">标记数</th><th class="num">工时(分)</th>
      </tr></thead>
      <tbody>${t.sweepRows
        .map(
          (r) => `<tr${r.threshold === currentState.config.originalThreshold ? ' style="background:#f5f8ff;font-weight:600"' : ''}>
            <td class="num">${r.threshold}</td><td class="num">${r.tp}</td><td class="num">${r.fn}</td>
            <td class="num">${r.fp}</td><td class="num">${r.tn}</td>
            <td class="num">${pct(r.recall)}</td><td class="num">${pct(r.missRate)}</td>
            <td class="num">${pct(r.accuracy)}</td><td class="num">${r.flaggedCount}</td>
            <td class="num">${r.estimatedReviewMinutes}</td></tr>`
        )
        .join('')}</tbody>
    </table>`;

  const strategyCard = (key, title, cls) => {
    const s = t.strategies[key];
    return `
      <div class="strategy ${cls}">
        <h3>${title}：阈值 ${s.threshold}（原阈值 ${currentState.config.originalThreshold}）</h3>
        <p class="hint">${esc(s.rationale)}</p>
        <table>
          <tbody>
            <tr><th>漏报数 FN</th><td class="num">${s.fn}</td><td>相对原阈值 ${deltaCell(s.vsBaseline.fnDelta, ' 条', true)}</td></tr>
            <tr><th>标记复核数</th><td class="num">${s.flaggedCount} 条</td><td>相对原阈值 ${deltaCell(s.vsBaseline.flaggedDelta, ' 条', true)}</td></tr>
            <tr><th>复核工时</th><td class="num">${s.estimatedReviewMinutes} 分钟</td><td>相对原阈值 ${deltaCell(s.vsBaseline.reviewMinutesDelta, ' 分', true)}</td></tr>
            <tr><th>召回率 / 准确率</th><td class="num">${pct(s.recall)} / ${pct(s.accuracy)}</td><td>召回 ${deltaCell(s.vsBaseline.recallDelta)} · 准确率 ${deltaCell(s.vsBaseline.accuracyDelta)}</td></tr>
          </tbody>
        </table>
      </div>`;
  };

  els.tradeoff.innerHTML = `
    <div>${scopeBadge(t.scope, t.scopeValue)}
      <span class="hint mono">生成于 ${esc(t.generatedAt)} · 单条复核 ${t.reviewMinutesPerRecord} 分钟 · 工时约束：漏报数 ≤ ${t.tolerance.maxToleratedFn}（原阈值 + 容忍 ${t.tolerance.maxExtraMisses}）</span>
    </div>
    ${strategyCard('reduce-miss', '策略 A · 优先减少漏报', 'recommend')}
    ${strategyCard('save-labor', '策略 B · 节约复核工时（漏报受限）', 'recommend')}
    ${strategyCard('accuracy-best', '对照 · 仅准确率最高（不作为推荐）', 'compare-only')}
    ${sweepTable}
    ${caveatsBlock(t.sweepRows.find((r) => r.threshold === currentState.config.originalThreshold).caveats)}`;
}

function renderSummary() {
  const c = currentState.config;
  els.configSummary.innerHTML = `<span class="hint">原阈值 <strong>${c.originalThreshold}</strong> · 单条复核工时 <strong>${c.reviewMinutesPerRecord}</strong> 分钟 · 候选阈值网格 ${c.grid.join(' / ')} · 漏报容忍 +${c.maxExtraMisses} 条</span>`;
  els.countSummary.innerHTML = `<span class="hint">记录 ${currentState.counts.totalRecords} 条 · 人工复核台账 ${currentState.counts.labelBaseCount} 条 · 补判 ${currentState.counts.adjudicationCount} 条 · 评估快照 ${currentState.counts.evaluationCount} 份（旧结果保留）</span>`;
}

async function refreshCandidates() {
  missCandidates = await api('/api/miss-candidates');
  els.adjRecord.innerHTML = missCandidates
    .map((r) => `<option value="${esc(r.id)}">${esc(r.id)}｜${esc(r.region)}｜${esc(r.type)}｜分数 ${r.score}</option>`)
    .join('');
  if (missCandidates.length === 0) {
    els.adjRecord.innerHTML = '<option value="">（无可补判漏报候选）</option>';
  }
  syncScopeValue();
}

function syncScopeValue() {
  const id = els.adjRecord.value;
  const record = missCandidates.find((r) => r.id === id);
  const scope = els.adjScope.value;
  if (scope === 'global') {
    els.adjScopeValue.value = '';
    els.adjScopeValue.placeholder = '全局范围无需填写';
  } else if (record) {
    els.adjScopeValue.value = scope === 'region' ? record.region : scope === 'type' ? record.type : record.id;
  } else {
    els.adjScopeValue.value = '';
  }
}

async function refreshAll(keepTradeoff = true) {
  currentState = await api('/api/state');
  const evals = currentState.evaluations || [];
  latestEvaluation = evals.length ? evals[evals.length - 1] : null;
  renderSummary();
  renderLatest();
  renderHistory();
  renderLedger();
  renderMissing();
  renderDetails();
  if (!keepTradeoff) currentTradeoff = null;
  renderTradeoff();
  await refreshCandidates();
}

els.btnOriginal.addEventListener('click', async () => {
  try {
    setStatus('正在运行原阈值评估…');
    els.btnOriginal.disabled = true;
    const snapshot = await api('/api/evaluations/original', { method: 'POST' });
    latestEvaluation = snapshot;
    await refreshAll();
    setStatus(`原阈值评估完成：快照 #${snapshot.seq}，FN=${snapshot.metrics.fn}，工时 ${snapshot.metrics.estimatedReviewMinutes} 分钟。`);
  } catch (err) {
    setStatus(`原阈值评估失败：${err.message}`, 'error');
  } finally {
    els.btnOriginal.disabled = false;
  }
});

els.adjScope.addEventListener('change', syncScopeValue);
els.adjRecord.addEventListener('change', syncScopeValue);

els.adjForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const recordId = els.adjRecord.value;
    if (!recordId) throw new Error('没有可补判的漏报候选');
    const scope = els.adjScope.value;
    const body = {
      recordId,
      decision: 'fault',
      scope,
      reason: els.adjReason.value.trim(),
    };
    if (scope !== 'global') body.scopeValue = els.adjScopeValue.value.trim();
    setStatus(`正在补判记录 ${recordId}…`);
    const result = await api('/api/adjudications', { method: 'POST', body: JSON.stringify(body) });
    latestEvaluation = result.reEvaluation;
    await refreshAll();
    setStatus(`补判完成：${result.adjudication.id}（${result.adjudication.scope}），已按该范围重算并保留旧快照。${result.note}`);
    els.adjReason.value = '';
  } catch (err) {
    setStatus(`补判失败：${err.message}`, 'error');
  }
});

els.btnTradeoff.addEventListener('click', async () => {
  try {
    const scope = els.tradeScope.value;
    const qs = new URLSearchParams();
    if (scope !== 'global') {
      const sv = els.tradeScopeValue.value.trim();
      if (!sv) throw new Error('局部范围查询必须填写范围取值');
      qs.set('scope', scope);
      qs.set('scopeValue', sv);
    }
    setStatus('正在计算成本权衡…');
    currentTradeoff = await api(`/api/tradeoff?${qs.toString()}`, { method: 'GET' });
    renderTradeoff();
    const a = currentTradeoff.strategies['reduce-miss'];
    const b = currentTradeoff.strategies['save-labor'];
    setStatus(`成本权衡已更新：减漏报方案阈值 ${a.threshold}（FN=${a.fn}）；省工时方案阈值 ${b.threshold}（工时 ${b.estimatedReviewMinutes} 分钟）。`);
  } catch (err) {
    setStatus(`成本权衡查询失败：${err.message}`, 'error');
  }
});

els.btnReset.addEventListener('click', async () => {
  try {
    await api('/api/reset', { method: 'POST' });
    currentTradeoff = null;
    latestEvaluation = null;
    await refreshAll(false);
    setStatus('本地数据已重置为初始状态。');
  } catch (err) {
    setStatus(`重置失败：${err.message}`, 'error');
  }
});

(async function init() {
  try {
    await refreshAll(false);
    setStatus('数据已加载，可以运行原阈值评估。');
  } catch (err) {
    setStatus(`初始化失败：${err.message}`, 'error');
  }
})();
