import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const port = 4184;
const baseUrl = `http://127.0.0.1:${port}`;

const cases = [
  { id: 'h5-01-explicit-burwood', request: 'Burwood 附近，明天晚上八点后', expect: (r) => resolved(r) && providers(r).length > 0 },
  { id: 'h5-02-explicit-usyd', request: 'USYD 附近，17点以后', expect: (r) => canonical(r)?.includes('University of Sydney') && providers(r).includes('susf') },
  { id: 'h5-03-fuzzy-central', request: 'near Central，今晚晚一点', expect: (r) => resolved(r) },
  { id: 'h5-04-cn-natural', request: '宝活附近明天晚上', expect: (r) => resolved(r) || status(r) === 'ASKING_USER' },
  { id: 'h5-05-current-location', request: '现在附近有没有能打的', currentLocation: { lat: -33.8791, lng: 151.0836, label: 'Current location near Strathfield' }, expect: (r) => source(r) === 'current_location' },
  { id: 'h5-06-profile-location', request: '明天晚上帮我找一个便宜的', profileLocation: 'Strathfield', expect: (r) => source(r) === 'profile_preferred_location' },
  { id: 'h5-07-sydney-fallback', request: '这几天找个便宜一点的场', expect: (r) => routingStatus(r) === 'sydney_fallback' && providers(r).length > 1 },
  { id: 'h5-08-unresolved', request: '在 totally-not-a-real-sydney-place-xyz 附近打', expect: (r) => routingStatus(r) === 'unresolved' || status(r) === 'ASKING_USER' },
  { id: 'h5-09-two-hours', request: '必须连续两小时', expect: (r) => noBadTwoHourRecommendation(r) },
  { id: 'h5-10-hard-date-day', request: '周六有事，周日晚上八点后', expect: (r) => status(r) !== 'PREFERENCE_PARSE_FAILED' },
  { id: 'h5-11-soft-weather', request: 'Strathfield 明晚，不要太热', expect: (r) => resolved(r) && !rejectedReasons(r).includes('weather:weather_unknown') },
  { id: 'h5-12-hard-rain', request: 'Strathfield，下雨就不打', expect: (r) => status(r) !== 'PREFERENCE_PARSE_FAILED' },
];

function status(payload) {
  return payload.status;
}

function scope(payload) {
  return payload.searchScope ?? {};
}

function source(payload) {
  return scope(payload).locationSource ?? null;
}

function canonical(payload) {
  return scope(payload).targetLocation?.canonicalName ?? null;
}

function resolved(payload) {
  const target = scope(payload).targetLocation;
  return Boolean(target?.canonicalName && Number.isFinite(target.lat) && Number.isFinite(target.lng));
}

function routingStatus(payload) {
  return payload.summary?.locationRouting?.status ?? scope(payload).locationRouting?.status ?? null;
}

function providers(payload) {
  return payload.summary?.locationRouting?.activeProviderIds
    ?? scope(payload).providerScope?.activeProviderIds
    ?? [];
}

function rejectedReasons(payload) {
  return Object.keys(payload.summary?.rejectedByReason ?? {});
}

function noBadTwoHourRecommendation(payload) {
  return (payload.candidates ?? []).every((candidate) => (
    candidate.durationMinutes >= 120 || candidate.availability?.nextHourAlsoAvailable === true
  ));
}

function trace(payload) {
  return {
    locationResolution: {
      rawLocation: payload.preferenceProfile?.searchScope?.location ?? null,
      canonicalLocation: canonical(payload),
      lat: scope(payload).targetLocation?.lat ?? null,
      lng: scope(payload).targetLocation?.lng ?? null,
      confidence: scope(payload).targetLocation?.confidence ?? null,
      source: source(payload),
      searchScope: scope(payload),
      providerRouting: payload.summary?.locationRouting ?? null,
    },
    activeProviders: providers(payload),
    realAvailabilityCount: payload.summary?.providerObservations?.reduce((total, item) => total + (item.candidateCount ?? 0), 0) ?? 0,
    providerObservations: payload.summary?.providerObservations ?? [],
    candidateRejects: payload.summary?.rejectedByReason ?? {},
    finalRecommendations: (payload.candidates ?? []).slice(0, 3).map((candidate) => ({
      venue: candidate.venue,
      court: candidate.court,
      startTime: candidate.startTime,
      price: candidate.price?.amount ?? null,
      weather: candidate.weather,
    })),
    agentStatus: payload.status,
    userStatus: payload.userStatus ?? null,
    uiFacingStatus: payload.userStatus?.message
      ?? (payload.ok ? 'Recommendation run completed.' : `${payload.status}: ${payload.error?.message ?? 'failed'}`),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer(child) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null) throw new Error(`demo server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for demo server');
}

const child = spawn(process.execPath, ['scripts/demo-server.mjs'], {
  cwd: resolve('.'),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await waitForServer(child);
  const results = [];
  for (const item of cases) {
    console.log(`Running ${item.id}...`);
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/recommend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request: item.request,
          currentLocation: item.currentLocation,
          profileLocation: item.profileLocation,
          maxIterations: 1,
          minCandidates: 1,
          totalBudgetMs: 25000,
          providerTimeoutMs: 12000,
        }),
      });
      const payload = await response.json();
      const pass = Boolean(item.expect(payload));
      results.push({
        id: item.id,
        request: item.request,
        httpStatus: response.status,
        pass,
        ...trace(payload),
        error: payload.error ?? null,
      });
    } catch (error) {
      results.push({
        id: item.id,
        request: item.request,
        httpStatus: null,
        pass: false,
        locationResolution: null,
        activeProviders: [],
        realAvailabilityCount: 0,
        providerObservations: [],
        candidateRejects: {},
        finalRecommendations: [],
        agentStatus: 'SMOKE_CASE_FAILED',
        uiFacingStatus: `SMOKE_CASE_FAILED: ${error.message}`,
        error: { code: error.name ?? 'SMOKE_CASE_FAILED', message: error.message },
      });
    }
  }

  const passCount = results.filter((item) => item.pass).length;
  const report = {
    summary: {
      generatedAt: new Date().toISOString(),
      total: results.length,
      passCount,
      failCount: results.length - passCount,
      passRate: passCount / results.length,
      productionGeocoderConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    },
    results,
  };
  const path = resolve('eval/real-h5-smoke-results.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Real H5 smoke: ${passCount}/${results.length} passed (${Math.round((passCount / results.length) * 100)}%).`);
  console.log(`Production geocoder configured: ${Boolean(process.env.GOOGLE_MAPS_API_KEY)}`);
  console.log(`JSON: ${path}`);
} finally {
  child.kill('SIGTERM');
}
