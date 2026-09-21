import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { recommendCourts } from '../packages/agent/src/recommendation-service.mjs';
import { createOpenAiReplannerProvider } from '../packages/agent/src/llm-replanner.mjs';
import { loadEnvFile } from '../packages/preferences/src/index.mjs';

const cases = [
  ['case-01', '明早我想打球，十点后'],
  ['case-02', '下周一早上想在悉大附近打两个小时'],
  ['case-03', '我住 Zetland，最近几天想找便宜点的球场'],
  ['case-04', 'Sydney CBD 附近，3km 左右，晚上八点以后'],
  ['case-05', '这几天在 Burwood 打球，25刀左右，不要太晒'],
  ['case-06', 'Central 附近，17:00 后，最好连续两小时'],
  ['case-07', 'Chatswood 周末下午，价格便宜一点，远一点没关系'],
  ['case-08', 'Mascot 明天晚上打两个小时，不想去太远'],
  ['case-09', 'Strathfield 最近几天，13:00 前或者17:00后都行'],
  ['case-10', 'USYD 附近，Court 3/6 尽量不要，天气舒服一点'],
  ['stress-11', '我周二或周四六点半以后都行，住在 Rhodes，坐车二十多分钟可以，最好别超过 30 刀而且不要太热'],
  ['stress-12', '这周末上午十点前或者傍晚五点后，Burwood 或 Strathfield 都可以，想连续打两小时，远一点也没事'],
  ['stress-13', 'near Central or Town Hall, tomorrow after 7pm，预算大概 $25，下雨就算了但阴天没关系'],
  ['stress-14', 'Mascot 附近这两天，下午三点到五点不行，其他时间想找便宜又不晒的，最好 Court 4/5，Court 6 尽量别排'],
  ['stress-15', '下周一早上八点前或晚上七点后，USYD、Zetland 都能去，最好连续两小时，Court 3 不太想要但真没别的也行'],
];

const outputPath = resolve(process.env.REPLANNING_TRACE_OUTPUT ?? 'output/real-replanning-e2e.json');
const startedAt = new Date().toISOString();
const results = [];
const caseDelayMs = Number(process.env.REPLANNING_CASE_DELAY_MS ?? 1500);

await mkdir(dirname(outputPath), { recursive: true });
await loadEnvFile();
const replannerProvider = createOpenAiReplannerProvider({
  maxRetries: Number(process.env.REPLANNING_EVAL_MAX_RETRIES ?? 2),
  retryBaseDelayMs: Number(process.env.REPLANNING_EVAL_RETRY_BASE_MS ?? 1000),
});

for (const [id, request] of cases) {
  console.log(`[${id}] ${request}`);
  const caseStartedAt = Date.now();
  let payload;
  try {
    payload = await recommendCourts({
      request,
      replannerProvider,
      now: new Date(),
      maxIterations: 3,
      minCandidates: 1,
      totalBudgetMs: Number(process.env.REPLANNING_CASE_BUDGET_MS ?? 120000),
      providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS ?? 20000),
      susfProviderTimeoutMs: Number(process.env.SUSF_PROVIDER_TIMEOUT_MS ?? 60000),
    });
  } catch (error) {
    payload = {
      ok: false,
      status: 'EVAL_RUNNER_FAILURE',
      error: { code: error.code ?? error.name, message: error.message },
    };
  }
  results.push({
    id,
    request,
    elapsedMs: Date.now() - caseStartedAt,
    payload,
  });
  await writeFile(outputPath, `${JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`[${id}] ${payload.status} in ${results.at(-1).elapsedMs}ms`);
  if (caseDelayMs > 0 && id !== cases.at(-1)[0]) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, caseDelayMs));
  }
}

console.log(`Wrote ${results.length} real E2E traces to ${outputPath}`);
