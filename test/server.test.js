import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 4317;
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let started;

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('服务已启动')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`服务提前退出 code=${code}`)));
  });
  await started;
});

after(() => {
  child.kill('SIGTERM');
});

async function get(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json() };
}

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('静态页面可访问且包含证据属性 data-evidence-result', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-evidence-result="business-results"'));
  assert.ok(html.includes('id="btn-run-original"'));
  assert.ok(html.includes('id="adj-form"'));
  assert.ok(html.includes('id="btn-tradeoff"'));
});

test('GET /api/state 返回初始造数与配置', async () => {
  const { status, body } = await get('/api/state');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.config.originalThreshold, 60);
  assert.equal(body.data.records.length, 20);
  assert.equal(body.data.labelBase.length, 14);
  assert.equal(body.data.counts.adjudicationCount, 0);
});

test('POST /api/evaluations/original：运行原阈值评估并留存快照', async () => {
  const { status, body } = await post('/api/evaluations/original');
  assert.equal(status, 201);
  assert.equal(body.data.kind, 'original');
  assert.equal(body.data.threshold, 60);
  assert.equal(body.data.metrics.tp, 4);
  assert.equal(body.data.metrics.fn, 3);
  assert.equal(body.data.metrics.missingCount, 1);
  assert.equal(body.data.metrics.estimatedReviewMinutes, 135);
  const state = await get('/api/state');
  assert.ok(state.body.data.evaluations.length >= 1);
});

test('GET /api/tradeoff：两套策略 + 准确率对照同时返回', async () => {
  const { status, body } = await get('/api/tradeoff');
  assert.equal(status, 200);
  const s = body.data.strategies;
  assert.ok(s['reduce-miss'] && s['save-labor'] && s['accuracy-best']);
  assert.equal(s['reduce-miss'].fn, 0);
  assert.equal(body.data.sweepRows.length, 7);
  // 局部范围查询
  const scoped = await get('/api/tradeoff?scope=region&scopeValue=' + encodeURIComponent('南区'));
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.data.scopeValue, '南区');
});

test('POST /api/adjudications：补判漏报后状态与明细联动变化', async () => {
  const before = await get('/api/state');
  const beforeCount = before.body.data.counts.adjudicationCount;
  const { status, body } = await post('/api/adjudications', {
    recordId: 'R017',
    decision: 'fault',
    scope: 'region',
    scopeValue: '南区',
    reason: 'HTTP 流程补判：南区夜巡放电',
  });
  assert.equal(status, 201);
  assert.equal(body.data.adjudication.id, 'ADJ-001');
  assert.equal(body.data.reEvaluation.scopeValue, '南区');
  const after = await get('/api/state');
  assert.equal(after.body.data.counts.adjudicationCount, beforeCount + 1);
  assert.equal(after.body.data.counts.evaluationCount, before.body.data.counts.evaluationCount + 1);

  // 明细接口可见补判标签
  const detail = await get('/api/records/R017');
  assert.equal(detail.body.data.adjudication.decision, 'fault');
  assert.equal(detail.body.data.flaggedAtOriginal, false);
});

test('补判异常：重复补判、非漏报、坏 JSON 均返回 400', async () => {
  const dup = await post('/api/adjudications', {
    recordId: 'R017',
    decision: 'fault',
    scope: 'global',
    reason: '重复补判',
  });
  assert.equal(dup.status, 400);
  assert.equal(dup.body.error.code, 'DUPLICATE_ADJUDICATION');

  const notMiss = await post('/api/adjudications', {
    recordId: 'R015',
    decision: 'fault',
    scope: 'global',
    reason: '已标记记录',
  });
  assert.equal(notMiss.status, 400);
  assert.equal(notMiss.body.error.code, 'NOT_A_MISS');

  const missing = await post('/api/adjudications', {
    recordId: 'R020',
    decision: 'fault',
    scope: 'global',
    reason: '未查到设备',
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'MISSING_DEVICE');

  const badJson = await fetch(BASE + '/api/adjudications', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(badJson.status, 400);
  const badBody = await badJson.json();
  assert.equal(badBody.error.code, 'INVALID_JSON');

  const notFound = await get('/api/records/R404');
  assert.equal(notFound.status, 400);
  assert.equal(notFound.body.error.code, 'RECORD_NOT_FOUND');
});

test('未知接口与局部范围缺参返回错误状态', async () => {
  const nf = await get('/api/nope');
  assert.equal(nf.status, 404);
  const badScope = await get('/api/tradeoff?scope=region');
  assert.equal(badScope.status, 400);
  assert.equal(badScope.body.error.code, 'MISSING_SCOPE_VALUE');
  const blankScope = await get('/api/tradeoff?scope=%20');
  assert.equal(blankScope.status, 400);
  assert.equal(blankScope.body.error.code, 'INVALID_SCOPE');
});

test('POST /api/reset：恢复初始数据', async () => {
  const { status, body } = await post('/api/reset');
  assert.equal(status, 200);
  assert.equal(body.data.adjudications.length, 0);
  assert.equal(body.data.evaluations.length, 0);
});
