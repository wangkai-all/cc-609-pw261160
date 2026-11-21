/**
 * HTTP 服务：仅使用 Node.js 内置模块。
 * 启动：node server.js（端口读 process.env.PORT，默认 3000，绑定 127.0.0.1）。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore } from './store-factory.js';
import { createSeedData } from './lib/data.js';
import { ValidationError } from './lib/errors.js';
import { SCOPES, SCOPE_GLOBAL } from './lib/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = '127.0.0.1';

const store = createStore();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new ValidationError('请求体超过 1MB 限制', 'BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError('请求体不是合法 JSON', 'INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function scopeFromObject(obj = {}) {
  const scope = obj.scope || SCOPE_GLOBAL;
  if (!SCOPES.includes(scope)) {
    throw new ValidationError(`scope 只能是 ${SCOPES.join('/')}`, 'INVALID_SCOPE');
  }
  if (scope === SCOPE_GLOBAL) return { scope };
  const scopeValue = String(obj.scopeValue || '').trim();
  if (!scopeValue) {
    throw new ValidationError('非全局范围必须提供 scopeValue', 'MISSING_SCOPE_VALUE');
  }
  return { scope, scopeValue };
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, { ok: true, data: store.getState() });
  }

  if (method === 'GET' && pathname === '/api/miss-candidates') {
    return sendJson(res, 200, { ok: true, data: store.getMissCandidates() });
  }

  const recordMatch = pathname.match(/^\/api\/records\/([^/]+)$/);
  if (method === 'GET' && recordMatch) {
    return sendJson(res, 200, { ok: true, data: store.getRecord(decodeURIComponent(recordMatch[1])) });
  }

  if (method === 'POST' && pathname === '/api/evaluations/original') {
    const snapshot = store.runEvaluation({
      threshold: store.originalThreshold,
      filter: { scope: SCOPE_GLOBAL },
      kind: 'original',
    });
    return sendJson(res, 201, { ok: true, data: snapshot });
  }

  if (method === 'POST' && pathname === '/api/evaluations') {
    const body = await readBody(req);
    const filter = scopeFromObject(body);
    const snapshot = store.runEvaluation({
      threshold: body.threshold ?? store.originalThreshold,
      filter,
      kind: body.kind || 'custom',
    });
    return sendJson(res, 201, { ok: true, data: snapshot });
  }

  if (method === 'POST' && pathname === '/api/adjudications') {
    const body = await readBody(req);
    const result = store.adjudicate(body);
    return sendJson(res, 201, { ok: true, data: result });
  }

  if (method === 'GET' && pathname === '/api/tradeoff') {
    const rawScope = url.searchParams.get('scope');
    const filter = scopeFromObject({
      scope: rawScope === null ? undefined : rawScope,
      scopeValue: url.searchParams.get('scopeValue') || undefined,
    });
    return sendJson(res, 200, { ok: true, data: store.getTradeoff({ filter }) });
  }

  if (method === 'POST' && pathname === '/api/reset') {
    store.reset(createSeedData());
    return sendJson(res, 200, { ok: true, data: store.getState() });
  }

  return sendJson(res, 404, {
    ok: false,
    error: { code: 'NOT_FOUND', message: `无此接口: ${method} ${pathname}` },
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    return await serveStatic(res, url.pathname);
  } catch (err) {
    if (err instanceof ValidationError) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'INTERNAL', message: err.message || '服务器内部错误' },
    });
  }
});

export { store };

const port = Number(process.env.PORT) || 3000;
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`PORT 非法: ${process.env.PORT}`);
}

server.listen(port, HOST, () => {
  console.log(`巡检阈值评估服务已启动: http://${HOST}:${port}`);
});
