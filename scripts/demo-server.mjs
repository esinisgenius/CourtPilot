import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recommendCourts } from '../packages/agent/src/index.mjs';

const rootDir = resolve(fileURLToPath(new URL('../apps/web', import.meta.url)));
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? '127.0.0.1';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function handleRecommend(request, response) {
  const controller = new AbortController();
  const abort = () => {
    const error = new Error('HTTP client disconnected');
    error.code = 'CLIENT_ABORTED';
    controller.abort(error);
  };
  request.on('aborted', abort);
  response.on('close', () => {
    if (!response.writableEnded) abort();
  });

  let body;
  try {
    body = await readJsonRequest(request);
  } catch {
    sendJson(response, 400, {
      ok: false,
      status: 'INVALID_JSON',
      error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
    });
    return;
  }

  if (body.mode === 'fixture') {
    sendJson(response, 400, {
      ok: false,
      status: 'FIXTURE_MODE_NOT_ENABLED',
      error: {
        code: 'FIXTURE_MODE_NOT_ENABLED',
        message: 'Fixture data is available only as a checked-in test fixture, not as the default demo API path.',
      },
    });
    return;
  }

  const result = await recommendCourts({
    request: body.request,
    currentLocation: body.currentLocation,
    profileLocation: body.profileLocation ?? body.preferredLocation,
    maxIterations: body.maxIterations,
    minCandidates: body.minCandidates,
    totalBudgetMs: body.totalBudgetMs,
    providerTimeoutMs: body.providerTimeoutMs,
    susfProviderTimeoutMs: body.susfProviderTimeoutMs,
    signal: controller.signal,
  });
  if (!response.writableEnded) sendJson(response, result.ok ? 200 : 502, result);
}

function safeStaticPath(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, `http://${host}:${port}`).pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const fullPath = join(rootDir, normalized);
  return fullPath.startsWith(rootDir) ? fullPath : null;
}

async function handleStatic(request, response) {
  const fullPath = safeStaticPath(request.url);
  if (!fullPath) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const info = await stat(fullPath);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': contentTypes[extname(fullPath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(fullPath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'POST' && new URL(request.url, `http://${host}:${port}`).pathname === '/api/recommend') {
      await handleRecommend(request, response);
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await handleStatic(request, response);
      return;
    }

    response.writeHead(405, { allow: 'GET, HEAD, POST' });
    response.end('Method not allowed');
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      status: 'SERVER_ERROR',
      error: {
        code: error.code ?? error.name ?? 'SERVER_ERROR',
        message: error.message,
      },
    });
  }
});

server.listen(port, host, () => {
  console.log(`CourtPilot demo server listening at http://${host}:${port}/`);
});
