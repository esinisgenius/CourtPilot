import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recommendCourts } from '../packages/agent/src/index.mjs';
import { getSnapshotAvailability } from '../packages/availability-snapshots/src/store.mjs';
import { getSusfAvailability } from '../packages/susf/src/index.mjs';

const rootDir = resolve(fileURLToPath(new URL('../apps/web', import.meta.url)));
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? '127.0.0.1';
const susfRefreshIntervalMs = Number(process.env.SUSF_REFRESH_INTERVAL_MS ?? 10 * 60 * 1000);

let susfRefreshStatus = {
  status: 'pending',
  checkedAt: null,
  candidateCount: 0,
  error: null,
};

async function refreshSusfSnapshot() {
  try {
    const availability = await getSusfAvailability({ days: 7, durationMinutes: 60, forceRefresh: true });
    susfRefreshStatus = {
      status: availability.discovery?.stale ? 'stale' : 'fresh',
      checkedAt: availability.discovery?.checkedAt ?? new Date().toISOString(),
      candidateCount: availability.length,
      error: availability.discovery?.refreshError ?? null,
    };
    console.log(`SUSF snapshot refreshed: ${availability.length} slots across ${availability.discovery?.courtCount ?? 0} courts.`);
  } catch (error) {
    susfRefreshStatus = {
      ...susfRefreshStatus,
      status: susfRefreshStatus.checkedAt ? 'stale' : 'failed',
      error: error.message,
    };
    console.warn(`SUSF snapshot refresh failed: ${error.message}`);
  }
}

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

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders(),
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function logWeatherDiagnostics(result) {
  const candidates = result?.candidates ?? [];
  const unavailable = candidates
    .filter((candidate) => candidate.weather?.forecastAvailable !== true)
    .map((candidate) => ({
      reason: candidate.weather?.unavailableReason ?? 'missing_weather_payload',
      venue: candidate.venue ?? null,
      court: candidate.court ?? null,
      startTime: candidate.startTime ?? null,
      source: candidate.weather?.source ?? null,
      fallbackLevel: candidate.weather?.fallbackLevel ?? null,
    }));
  if (unavailable.length === 0) return;

  const reasons = unavailable.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
  console.warn(JSON.stringify({
    event: 'weather_enrichment_unavailable',
    timestamp: new Date().toISOString(),
    recommendationStatus: result?.status ?? null,
    candidateCount: candidates.length,
    unavailableCount: unavailable.length,
    reasons,
    samples: unavailable.slice(0, 5),
  }));
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
    userProfile: body.userProfile,
    recentBehavior: body.recentBehavior,
    signal: controller.signal,
  });
  logWeatherDiagnostics(result);
  if (!response.writableEnded) sendJson(response, result.ok ? 200 : 502, result);
}

async function handleRevalidate(request, response) {
  const body = await readJsonRequest(request);
  if (body.provider !== 'susf' || !body.court || !body.localDate || !body.localTime) {
    sendJson(response, 400, { ok: false, error: { code: 'INVALID_REVALIDATION', message: 'A SUSF court, date, and time are required.' } });
    return;
  }
  const snapshotOnly = process.env.AVAILABILITY_SNAPSHOT_ONLY === '1';
  const availability = snapshotOnly
    ? await getSnapshotAvailability('susf', {
      date: body.localDate,
      days: 1,
      durationMinutes: Number(body.durationMinutes ?? 60),
    })
    : await getSusfAvailability({
      date: body.localDate,
      days: 1,
      durationMinutes: Number(body.durationMinutes ?? 60),
      forceRefresh: true,
    });
  const available = availability.some((slot) => (
    slot.court === body.court
    && slot.startTime?.slice(0, 10) === body.localDate
    && slot.startTime?.slice(11, 16) === body.localTime
  ));
  sendJson(response, 200, {
    ok: true,
    available,
    checkedAt: availability.snapshot?.collectedAt ?? availability.discovery?.checkedAt ?? new Date().toISOString(),
    stale: snapshotOnly
      ? Boolean(availability.snapshot?.stale)
      : Boolean(availability.discovery?.stale),
  });
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
      ...corsHeaders(),
    });
    createReadStream(fullPath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    if (request.method === 'POST' && new URL(request.url, `http://${host}:${port}`).pathname === '/api/recommend') {
      await handleRecommend(request, response);
      return;
    }


    if (request.method === 'POST' && new URL(request.url, `http://${host}:${port}`).pathname === '/api/revalidate') {
      await handleRevalidate(request, response);
      return;
    }

    if (request.method === 'GET' && new URL(request.url, `http://${host}:${port}`).pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        availabilityMode: process.env.AVAILABILITY_SNAPSHOT_ONLY === '1' ? 'snapshot' : 'direct',
        susf: process.env.AVAILABILITY_SNAPSHOT_ONLY === '1' ? null : susfRefreshStatus,
      });
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
  if (process.env.AVAILABILITY_SNAPSHOT_ONLY !== '1') refreshSusfSnapshot();
  if (process.env.AVAILABILITY_SNAPSHOT_ONLY !== '1' && Number.isFinite(susfRefreshIntervalMs) && susfRefreshIntervalMs > 0) {
    setInterval(refreshSusfSnapshot, susfRefreshIntervalMs).unref();
  }
});
