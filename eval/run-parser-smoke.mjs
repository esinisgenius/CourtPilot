import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { interpretPreferences } from '../packages/preferences/src/index.mjs';

const cases = [
  {
    id: 'parser-01-sunday-after-8',
    input: '周六有事，周日晚上八点后',
    expect: (profile) => hasHard(profile, 'start_time', (rule) => rule.after === '20:00')
      && (hasHard(profile, 'date') || hasDateScope(profile)),
  },
  {
    id: 'parser-02-next-few-days-not-saturday',
    input: '这几天都行，但周六不行',
    expect: (profile) => profile.searchScope?.dateRange?.type === 'next_few_days'
      && (hasHard(profile, 'date') || hasUnresolved(profile, '周六')),
  },
  {
    id: 'parser-03-after-17-soft-afternoon-fallback',
    input: '最好17点后，实在不行下午也可以',
    expect: (profile) => hasSoft(profile, 'start_time')
      && !hasHard(profile, 'start_time'),
  },
  {
    id: 'parser-04-must-two-hours',
    input: '必须连续两小时',
    expect: (profile) => hasHard(profile, 'consecutive_availability', (rule) => rule.minMinutes >= 120 || rule.preferredMinutes >= 120),
  },
  {
    id: 'parser-05-cheap-around-25',
    input: '便宜一点，25刀左右',
    expect: (profile) => hasSoft(profile, 'price') || profile.objectives?.some((item) => item.feature === 'price'),
  },
  {
    id: 'parser-06-not-too-hot',
    input: '不要太热',
    expect: (profile) => hasSoft(profile, 'weather', (rule) => rule.condition === 'not_too_hot')
      && !hasHard(profile, 'weather'),
  },
  {
    id: 'parser-07-no-rain-hard',
    input: '下雨就不打',
    expect: (profile) => hasHard(profile, 'weather', (rule) => rule.condition === 'no_rain' || rule.condition === 'no_precipitation'),
  },
  {
    id: 'parser-08-farther-ok',
    input: '稍微远一点也可以',
    expect: (profile) => hasSoft(profile, 'travel_time')
      || profile.transportPreference
      || hasUnresolved(profile, '远'),
  },
];

function hasHard(profile, feature, ruleCheck = () => true) {
  return (profile.hardConstraints ?? []).some((item) => item.feature === feature && ruleCheck(item.rule ?? {}));
}

function hasSoft(profile, feature, ruleCheck = () => true) {
  return (profile.preferences ?? []).some((item) => item.feature === feature && item.type !== 'hard' && ruleCheck(item.rule ?? {}));
}

function hasDateScope(profile) {
  return Boolean(profile.searchScope?.dateRange);
}

function hasUnresolved(profile, text) {
  return (profile.unresolvedPreferences ?? []).some((item) => JSON.stringify(item).includes(text));
}

function compact(profile) {
  return {
    hardConstraints: profile.hardConstraints ?? [],
    softPreferences: profile.preferences ?? [],
    objectives: profile.objectives ?? [],
    dateTimeSemantics: {
      searchScope: profile.searchScope ?? {},
      dateHard: (profile.hardConstraints ?? []).filter((item) => item.feature === 'date'),
      timeHard: (profile.hardConstraints ?? []).filter((item) => item.feature === 'start_time'),
    },
    unresolvedPreferences: profile.unresolvedPreferences ?? [],
  };
}

const results = [];
for (const item of cases) {
  try {
    const profile = await interpretPreferences(item.input, { now: new Date('2026-09-14T10:00:00+10:00') });
    const pass = Boolean(item.expect(profile));
    results.push({
      id: item.id,
      input: item.input,
      ...compact(profile),
      expected: item.id,
      actual: compact(profile),
      pass,
      failureRootCause: pass ? null : 'Parser did not structure this natural-language constraint with the expected hard/soft/date-time semantics.',
    });
  } catch (error) {
    results.push({
      id: item.id,
      input: item.input,
      pass: false,
      error: { code: error.code ?? error.name, message: error.message },
      failureRootCause: 'Parser call failed before schema comparison.',
    });
  }
}

const passCount = results.filter((item) => item.pass).length;
const payload = {
  summary: {
    generatedAt: new Date().toISOString(),
    total: results.length,
    passCount,
    failCount: results.length - passCount,
    passRate: passCount / results.length,
  },
  results,
};
const path = resolve('eval/parser-smoke-results.json');
await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Parser smoke eval: ${passCount}/${results.length} passed (${Math.round((passCount / results.length) * 100)}%).`);
console.log(`JSON: ${path}`);
