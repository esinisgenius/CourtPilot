import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const port = 4185;
const baseUrl = `http://127.0.0.1:${port}`;
const cachePath = resolve('.cache/susf-metadata.json');

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

async function runCase(label) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request: 'USYD 附近，17点以后',
      maxIterations: 1,
      minCandidates: 1,
      totalBudgetMs: 90000,
      providerTimeoutMs: 60000,
    }),
  });
  const payload = await response.json();
  return {
    label,
    httpStatus: response.status,
    ok: payload.ok,
    internalStatus: payload.status,
    userStatus: payload.userStatus,
    latencyMs: Date.now() - started,
    candidates: payload.candidates?.length ?? 0,
    providerObservations: payload.summary?.providerObservations ?? [],
    activeProviders: payload.summary?.locationRouting?.activeProviderIds ?? [],
  };
}

await rm(cachePath, { force: true }).catch(() => {});

const child = spawn(process.execPath, ['scripts/demo-server.mjs'], {
  cwd: resolve('.'),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PROVIDER_TIMEOUT_MS: '60000',
    RECOMMEND_TOTAL_BUDGET_MS: '90000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await waitForServer(child);
  const cold = await runCase('cold');
  const warm = await runCase('warm');
  const output = {
    generatedAt: new Date().toISOString(),
    cachePath,
    results: [cold, warm],
  };
  const outputPath = resolve('eval/usyd-susf-smoke-results.json');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`USYD SUSF smoke: cold ${cold.latencyMs}ms, warm ${warm.latencyMs}ms.`);
  console.log(`JSON: ${outputPath}`);
} finally {
  child.kill('SIGTERM');
}
