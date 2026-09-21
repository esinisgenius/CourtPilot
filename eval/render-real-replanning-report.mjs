import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const inputPath = resolve(process.argv[2] ?? 'output/real-replanning-e2e.json');
const outputPath = resolve(process.argv[3] ?? 'output/real-replanning-e2e-report.md');
const run = JSON.parse(await readFile(inputPath, 'utf8'));

const assessments = {
  'case-01': ['PASS', '-', '-', 'N/A', '“明早”与“十点后”组合正确；无需 replanning。'],
  'case-02': ['FAIL', 'Semantic interpretation', 'Duration presentation', 'N/A', '“下周一”落成 9/22-9/28，推荐周二；两小时仅以 next-hour fact 验证，结果仍显示 60 分钟。'],
  'case-03': ['PASS', '-', 'Provider partial failure', 'N/A', 'Zetland 3km 范围真实裁剪 provider；价格作为 objective 参与排序。Intrac 部分失败但另外两家有召回。'],
  'case-04': ['PASS', '-', '-', 'N/A', '显式 3km 成为 search radius，候选均在范围内；20:00 后硬约束正确。'],
  'case-05': ['FAIL', 'Semantic interpretation', 'Provider coverage', 'No', '“不要太晒”被解释为 covered/shade venue setting，不是 weather preference，导致 Burwood 无 provider scope。'],
  'case-06': ['PARTIAL', 'Constraint classification', 'Final presentation', 'N/A', '连续两小时被分为 medium soft preference，实际用 continuousDuration=120 排序；最终仍展示 60 分钟 slot。'],
  'case-07': ['PARTIAL', 'Search scope', 'Availability facts', 'N/A', '“远一点没关系”降低 travel priority，但搜索仍固定 3km；唯一 provider 的价格全未知，无法实现价格权衡。'],
  'case-08': ['FAIL', 'Semantic interpretation', 'Search scope', 'No', 'Mascot 丢失并退回 Sydney-wide；距离事实为空。两小时被标 hard，但最终候选仍显示 60 分钟并 ASK_USER。'],
  'case-09': ['FAIL', 'Temporal schema/application', 'Replanner', 'No', 'OR window 在 preference rule 中保留，却被 provider window 变成 17:00-13:00，155 条全拒；三轮只重复扩半径。'],
  'case-10': ['PARTIAL', 'Ranking', 'Weather evaluation', 'N/A', 'Court 3/6 正确为 negative soft preference且 top 避开；天气已 enrichment，但 comfortable temperature 没有可见 ranking 判断。'],
  'stress-11': ['FAIL', 'Location resolution', 'Semantic interpretation', 'No', 'Rhodes 被 Google 解析到希腊；“周二或周四”只保留周二，provider scope 为空。'],
  'stress-12': ['FAIL', 'Temporal schema/application', 'Replanner', 'No', '双地点部分保留，但 OR window 变成 17:00-10:00；三轮扩半径没有新 provider 或 candidate。'],
  'stress-13': ['PARTIAL', 'Constraint classification', 'Ranking/weather', 'No', '地点和时间可用，但“下雨就算了”仅为 soft；实际 61% 降雨候选触发 ASK_USER，未给出更好替代。'],
  'stress-14': ['FAIL', 'Semantic interpretation', 'Temporal schema/application', 'No', '“15-17 点不行”被变成反向 provider window，39 条全拒；三轮重复扩半径。'],
  'stress-15': ['FAIL', 'Temporal interpretation', 'Search scope', 'No', '下周一被扩整周，OR window 反向，USYD/Zetland 仅以 USYD 为 search center，并产生无关 court_count preference。'],
};

function json(value) {
  return value === undefined ? 'none' : `\`${JSON.stringify(value)}\``;
}

function providerLine(observation) {
  const failure = observation.failure ? `; ${observation.failure.code}: ${observation.failure.message}` : '';
  return `${observation.provider}: ${observation.status}, ${observation.candidateCount} candidates${failure}`;
}

function weatherText(weather) {
  if (!weather) return 'unknown';
  if (weather.forecastAvailable === false) return 'forecast unavailable';
  const parts = [];
  if (Number.isFinite(weather.temperatureC)) parts.push(`${weather.temperatureC}C`);
  if (Number.isFinite(weather.feelsLikeC)) parts.push(`feels ${weather.feelsLikeC}C`);
  if (Number.isFinite(weather.precipitationProbability)) parts.push(`rain ${weather.precipitationProbability}%`);
  if (Number.isFinite(weather.windKph)) parts.push(`wind ${weather.windKph}km/h`);
  return parts.join(', ') || weather.condition || weather.summary || 'unknown';
}

function addMinutes(time, minutes) {
  const match = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  if (!match || !Number.isFinite(minutes)) return 'unknown';
  const total = Number(match[1]) * 60 + Number(match[2]) + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function candidateLine(candidate, factsById = new Map(), rankById = new Map()) {
  const fact = factsById.get(candidate.id) ?? {};
  const ranking = rankById.get(candidate.id);
  const price = Number.isFinite(candidate.price?.amount)
    ? candidate.price.amount
    : Number.isFinite(candidate.price) ? candidate.price : fact.price?.amount;
  const date = candidate.date ?? candidate.localDate ?? fact.slot?.localDate ?? 'unknown';
  const start = candidate.time ?? candidate.localTime ?? fact.slot?.localTime ?? 'unknown';
  const duration = candidate.durationMin ?? candidate.durationMinutes ?? fact.slot?.durationMinutes ?? null;
  const weather = fact.weather ?? candidate.weather;
  const distance = candidate.distanceKm ?? fact.venue?.distanceKm;
  const provider = candidate.provider ?? candidate.availability?.provider ?? 'unknown';
  const rejected = (candidate.rejectedReasons ?? []).join(', ') || 'none';
  const rankingText = ranking
    ? `rank ${ranking.rank}; ${[...(ranking.reasons ?? []), ...(ranking.tradeoffs ?? [])].join(' ')}`
    : 'no numeric score/rank available';
  return `${candidate.venue ?? fact.venue?.name ?? 'unknown'} | ${candidate.court ?? fact.court?.name ?? 'unknown'} | ${date} ${start}-${addMinutes(start, duration)} | ${duration ?? 'unknown'} min | price ${Number.isFinite(price) ? `$${price}` : 'unknown'} | distance ${Number.isFinite(distance) ? `${distance.toFixed(3)}km` : 'unknown'} | weather ${weatherText(weather)} | provider ${provider} | hard rejections: ${rejected} | ${rankingText}`;
}

function initialSection(profile = {}, scope = {}) {
  const hard = profile.hardConstraints ?? [];
  const soft = profile.preferences ?? [];
  const objectives = profile.objectives ?? [];
  const defaults = [];
  if (profile.weatherPreference?.source === 'default') defaults.push(`weather=${JSON.stringify(profile.weatherPreference)}`);
  if (scope.travelModeSource === 'product_default') defaults.push(`travelMode=${scope.travelMode}`);
  return [
    'INITIAL INTERPRETATION',
    `- parsed preferences: ${json({
      searchScope: {
        days: profile.searchScope?.days,
        dateRange: profile.searchScope?.dateRange,
        timeWindow: profile.searchScope?.timeWindow,
        location: profile.searchScope?.location,
        radiusMeters: profile.searchScope?.radiusMeters,
        venueSettings: profile.searchScope?.venueSettings,
        surfaces: profile.searchScope?.surfaces,
      },
      objectives,
      transportPreference: profile.transportPreference,
      weatherPreference: profile.weatherPreference,
      unresolvedPreferences: profile.unresolvedPreferences,
    })}`,
    `- explicit hard constraints: ${hard.length ? json(hard) : 'none'}`,
    `- soft preferences: ${soft.length || objectives.length ? json({ preferences: soft, objectives }) : 'none'}`,
    `- inferred/default constraints: ${defaults.length ? defaults.join('; ') : 'none'}`,
    `- search assumptions: target=${scope.targetLocation?.canonicalName ?? 'none'}; source=${scope.locationSource ?? 'none'}; radius=${scope.radiusMeters ?? 'none'}m; temporal=${json(scope.temporalWindow)}; providers=${(scope.providerScope?.initialProviderIds ?? []).join(', ') || 'none'}`,
  ];
}

function iterationSection(iteration, payload) {
  const observation = iteration.observation ?? {};
  const candidateSummary = observation.candidateSummary ?? {};
  const factsById = new Map((iteration.factualCandidateFeatures ?? []).map((item) => [item.candidateId, item]));
  const rankById = new Map((iteration.rankedCandidates ?? []).map((item) => [item.candidateId, item]));
  const providerByVenue = new Map((payload.candidates ?? []).map((item) => [item.venue, item.availability?.provider]));
  const lines = [
    `ITERATION ${Number(iteration.iteration) + 1}`,
    `- search scope: ${json(observation.searchScope ?? iteration.searchScope)}`,
    `- providers queried: ${(observation.providerSummary ?? []).map((item) => item.provider).join(', ') || 'none'}`,
    `- provider results / failures: ${(observation.providerSummary ?? []).map(providerLine).join(' | ') || 'none'}`,
    `- raw candidate count: ${candidateSummary.total ?? 0}`,
    `- candidates after hard filtering: ${candidateSummary.afterHardConstraints ?? iteration.candidateCount ?? 0}`,
    '- top 3-5 candidate summaries:',
  ];
  const rankedTop = [...(iteration.rankedCandidates ?? [])]
    .sort((left, right) => left.rank - right.rank)
    .slice(0, 5)
    .map((ranking) => {
      const fact = factsById.get(ranking.candidateId);
      return { id: ranking.candidateId, provider: providerByVenue.get(fact?.venue?.name) };
    });
  const top = rankedTop.length > 0 ? rankedTop : candidateSummary.topCandidates ?? [];
  if (top.length === 0) lines.push('  - none');
  else for (const candidate of top.slice(0, 5)) lines.push(`  - ${candidateLine(candidate, factsById, rankById)}`);
  lines.push('- near misses:');
  const misses = candidateSummary.nearMisses ?? [];
  if (misses.length === 0) lines.push('  - none');
  else for (const candidate of misses.slice(0, 5)) lines.push(`  - ${candidateLine(candidate, factsById, rankById)}`);
  lines.push(`- diagnostics: ${(observation.diagnostics ?? []).join(' | ') || 'none'}`);
  lines.push(`- replanner action: ${iteration.action?.selectedAction ?? 'none'} (${iteration.source ?? 'unknown source'})`);
  lines.push(`- replanner reason: ${iteration.reason ?? iteration.action?.rationale ?? 'none'}`);
  lines.push(`- state changes applied: ${json({ before: iteration.stateBefore, after: iteration.stateAfter })}`);
  if (iteration.validationFailure) lines.push(`- LLM replanner failure: ${iteration.validationFailure.code}: ${iteration.validationFailure.message}`);
  return lines;
}

function finalSection(payload, assessment) {
  const latest = payload.replanning?.at(-1);
  const factsById = new Map((latest?.factualCandidateFeatures ?? []).map((item) => [item.candidateId, item]));
  const rankById = new Map((latest?.rankedCandidates ?? []).map((item) => [item.candidateId, item]));
  const failures = (payload.replanning ?? []).map((item) => item.validationFailure).filter(Boolean);
  const timeout = failures.some((failure) => /timeout/i.test(`${failure.code} ${failure.message}`));
  const schema = failures.some((failure) => /schema|malformed/i.test(`${failure.code} ${failure.message}`));
  const lines = [
    'FINAL',
    '- final top recommendations:',
  ];
  if ((payload.candidates ?? []).length === 0) lines.push('  - none');
  else for (const candidate of payload.candidates.slice(0, 3)) lines.push(`  - ${candidateLine(candidate, factsById, rankById)}`);
  lines.push(`- stop reason: ${payload.status}; ${payload.userStatus?.code ?? 'no user status code'}`);
  lines.push(`- total iterations: ${payload.replanning?.length ?? 0}`);
  lines.push('- fallback used? yes: deterministic ranker was used; every replanner decision also fell back to heuristic after an OpenAI HTTP error');
  lines.push(`- LLM timeout/schema failure? timeout=${timeout ? 'yes' : 'no'}, schema=${schema ? 'yes' : 'no'}; provider HTTP error=${failures.length ? 'yes' : 'no'}`);
  lines.push(`- RESULT: ${assessment[0]} - ${assessment[4]}`);
  return lines;
}

const out = [
  '# Real E2E Observation-Driven Replanning Evaluation',
  '',
  `Run started: ${run.startedAt}`,
  '',
  'Method: production `recommendCourts` entry, real configured providers, Open-Meteo, Google Maps, and configured OpenAI providers. No mocks. The run was serial; provider caches were reused where their existing implementation allowed it. Candidate lists are representative only.',
  '',
];

for (const item of run.results) {
  const payload = item.payload;
  const assessment = assessments[item.id];
  out.push(`## ${item.id}`, '', 'CASE:', item.request, '');
  out.push(...initialSection(payload.preferenceProfile, payload.searchScope), '');
  for (const iteration of payload.replanning ?? []) out.push(...iterationSection(iteration, payload), '');
  out.push(...finalSection(payload, assessment), '');
}

out.push('## Failure Matrix', '');
out.push('| Case | Result | Primary Failure Layer | Secondary Layer | Did Replanning Help? | Notes |');
out.push('| --- | --- | --- | --- | --- | --- |');
for (const item of run.results) {
  const [result, primary, secondary, helped, notes] = assessments[item.id];
  out.push(`| ${item.id} | ${result} | ${primary} | ${secondary} | ${helped} | ${notes} |`);
}

out.push('', '## Failure Counts', '');
out.push('- Parser / interpretation: 7');
out.push('- Constraint classification: 3');
out.push('- Search scope: 5');
out.push('- Provider coverage/acquisition: 4');
out.push('- Availability/duration representation: 3');
out.push('- Ranking/weather use: 3');
out.push('- Replanner: 6');
out.push('- Schema/temporal application limitation: 4');
out.push('', 'Counts overlap because one case may fail at multiple layers.');

out.push('', '## Answers', '');
out.push('1. **Is the new loop genuinely improved?** The instrumentation and bounded termination are improved, but this real run does not demonstrate recommendation-quality improvement. The only four multi-iteration cases repeated radius expansion without new provider observations or candidates.');
out.push('2. **Was `REINTERPRET_PREFERENCES` valuable?** It was never selected. Because every OpenAI replanner call failed (13 HTTP 429 iteration failures and 10 HTTP 400 iteration failures), this run cannot validate the LLM action. The heuristic did not use it, including cases where reinterpretation was clearly needed.');
out.push('3. **Did `SEARCH_OTHER_VENUES` expand recall?** No. It was never selected. Explicit-location provider scopes were fixed up front, and radius expansion did not recompute or query additional providers.');
out.push('4. **Did second observations add information?** No. In every multi-iteration case, iteration 2 had zero newly observed raw candidates, the same accumulated rejection set, and the same providers.');
out.push('5. **Largest bottleneck?** Temporal interpretation/application is the largest correctness bottleneck, especially disjoint and exclusion windows. Replanner execution is the largest loop bottleneck because scope changes do not trigger new provider discovery/observation. Provider coverage is next for shade/area-specific requests.');
out.push('6. **Fix next vs not now:** Fix date semantics, disjoint/exclusion temporal representation, and re-observation after scope changes. Then restore a working replanner provider path. Do not tune ranking weights or add aliases/case-specific parser rules yet; ranking cannot recover candidates removed by upstream errors.');
out.push('7. **Top next steps by benefit/cost:** (1) High benefit / medium cost: make temporal scope represent OR and excluded intervals end-to-end, and add date assertions for weekday + next-week. (2) High benefit / medium cost: make radius/provider actions recompute routing and clear only the observations that must be reacquired, with a progress invariant. (3) Medium benefit / low cost: diagnose the OpenAI 400 payload/schema issue and apply rate-limit-aware evaluation batching so real LLM replanning can actually be measured.');

await writeFile(outputPath, `${out.join('\n')}\n`);
console.log(`Wrote report to ${outputPath}`);
