import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PREFERENCE_VERSION,
  PreferenceInterpreterError,
  clearBehaviorHistory,
  clearProfile,
  assertOpenAiStrictObjectSchema,
  buildInterpreterMessages,
  collectObjectSchemas,
  interpretPreferences,
  loadBehaviorHistory,
  loadProfile,
  loadPreferenceProfile,
  loadUserProfileFields,
  mergeProfiles,
  normalizePreferenceProfile,
  openAiPreferenceProfileJsonSchema,
  profileFromPersistentFields,
  recordBookingClick,
  recordSearch,
  saveProfile,
  saveUserProfileFields,
  summarizeBehavior,
  updateProfile,
  validatePreferenceProfile,
} from '../packages/preferences/src/index.mjs';

function mockProvider(profile) {
  return {
    async interpret() {
      return profile;
    },
  };
}

function baseProfile(overrides = {}) {
  return {
    version: 2,
    searchWindowDays: 7,
    searchScope: {
      days: 7,
      sourceText: '',
    },
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
    sourceText: '',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const evalCases = JSON.parse(await readFile(new URL('../eval/test_case.json', import.meta.url), 'utf8'));
const evalCaseIds = new Set(evalCases.map((testCase) => testCase.id));

function caseInput(id) {
  const testCase = evalCases.find((item) => item.id === id);
  if (!testCase) throw new Error(`Missing eval case ${id}`);
  return testCase.input;
}

async function interpretCase(id, rawProfile) {
  return interpretPreferences(caseInput(id), {
    provider: mockProvider(rawProfile),
    now: new Date('2026-09-03T00:00:00.000Z'),
  });
}

function findItem(items, feature) {
  return items.find((item) => item.feature === feature);
}

function findStructuredItem(profile, feature) {
  return [...profile.preferences, ...profile.hardConstraints].find((item) => item.feature === feature);
}

function fakeLocalStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}

function assertNoEquivalentPreferenceForObjective(profile, feature) {
  const objective = findItem(profile.objectives, feature);
  assert.ok(objective, `${feature} objective expected`);
  assert.equal(profile.preferences.some((preference) => preference.feature === feature), false);
}

function startTimeHardConstraints(profile) {
  return profile.hardConstraints.filter((constraint) => constraint.feature === 'start_time');
}

test('Preference Profile version is v2', () => {
  assert.equal(PREFERENCE_VERSION, 2);
});

test('想便宜一点 maps to price lower', async () => {
  const profile = await interpretPreferences('想便宜一点', {
    provider: mockProvider(baseProfile({
      preferences: [
        { feature: 'price', type: 'soft', direction: 'lower', importance: 'medium' },
      ],
    })),
    now: new Date('2026-09-01T00:00:00.000Z'),
  });

  assert.equal(profile.version, 2);
  assert.equal(profile.preferences[0].feature, 'price');
  assert.equal(profile.preferences[0].direction, 'lower');
  assert.equal(profile.preferences[0].priority, 'medium');
  assert.equal(profile.preferences[0].relaxable, true);
});

test('后一小时最好没人 maps to consecutive availability preference', async () => {
  const profile = await interpretPreferences('后一小时最好没人', {
    provider: mockProvider(baseProfile({
      preferences: [
        {
          feature: 'consecutive_availability',
          type: 'soft',
          rule: { preferredMinutes: 120 },
          importance: 'medium',
        },
      ],
    })),
  });

  assert.equal(profile.preferences[0].feature, 'consecutive_availability');
  assert.equal(profile.preferences[0].rule.preferredMinutes, 120);
});

test('13点前或17点后 maps to OR time window', async () => {
  const profile = await interpretPreferences('13点前或17点后', {
    provider: mockProvider(baseProfile({
      preferences: [
        {
          feature: 'start_time',
          type: 'soft',
          rule: { before: '13:00', after: '17:00' },
          importance: 'medium',
        },
      ],
    })),
  });

  assert.deepEqual(profile.preferences[0].rule, { before: '13:00', after: '17:00' });
});

test('malformed LLM output is rejected by schema', async () => {
  await assert.rejects(
    () => interpretPreferences('想便宜一点', {
      provider: mockProvider(baseProfile({
        preferences: [{ feature: 'unknown_feature', type: 'soft', importance: 'high' }],
      })),
    }),
    (error) => error instanceof PreferenceInterpreterError
      && error.code === 'PREFERENCE_SCHEMA_REJECTED',
  );
});

test('price rule does not allow before or after', () => {
  assert.throws(
    () => validatePreferenceProfile(baseProfile({
      hardConstraints: [
        {
          feature: 'price',
          type: 'hard',
          importance: 'high',
          priority: 'high',
          relaxable: false,
          rule: { before: '13:00' },
        },
      ],
    })),
    (error) => error.issues?.includes('hardConstraints[0].rule.before is not allowed'),
  );
});

test('start_time rule allows before and after', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    hardConstraints: [
      {
        feature: 'start_time',
        type: 'hard',
        importance: 'high',
        rule: { before: '13:00', after: '17:00' },
      },
    ],
  })));

  assert.deepEqual(profile.hardConstraints[0].rule, { before: '13:00', after: '17:00' });
});

test('duration exactMinutes validates', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    hardConstraints: [
      {
        feature: 'duration',
        type: 'hard',
        importance: 'high',
        rule: { exactMinutes: 60 },
      },
    ],
  })));

  assert.equal(profile.hardConstraints[0].rule.exactMinutes, 60);
});

test('consecutive availability minMinutes validates', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    hardConstraints: [
      {
        feature: 'consecutive_availability',
        type: 'hard',
        importance: 'high',
        rule: { minMinutes: 120 },
      },
    ],
  })));

  assert.equal(profile.hardConstraints[0].rule.minMinutes, 120);
});

test('court_count exact validates', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    hardConstraints: [
      {
        feature: 'court_count',
        type: 'hard',
        importance: 'high',
        rule: { exact: 3 },
      },
    ],
  })));

  assert.equal(profile.hardConstraints[0].rule.exact, 3);
});

test('adjacency required validates', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    hardConstraints: [
      {
        feature: 'adjacency',
        type: 'hard',
        importance: 'high',
        rule: { required: true },
      },
    ],
  })));

  assert.equal(profile.hardConstraints[0].rule.required, true);
});

test('travel_time rule validates user-facing travel burden', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    transportPreference: {
      maxTransitMinutes: 30,
      maxWalkMinutes: 15,
      preferredTransportModes: ['TRANSIT', 'WALK'],
    },
    preferences: [
      {
        feature: 'travel_time',
        type: 'soft',
        importance: 'medium',
        rule: {
          preferredMaxMinutes: 20,
          maxTransitMinutes: 30,
          maxWalkMinutes: 15,
          preferredTransportModes: ['TRANSIT', 'WALK'],
        },
      },
    ],
  })));

  assert.equal(profile.preferences[0].feature, 'travel_time');
  assert.equal(profile.preferences[0].rule.preferredMaxMinutes, 20);
  assert.equal(profile.preferences[0].rule.maxTransitMinutes, 30);
  assert.deepEqual(profile.transportPreference.preferredTransportModes, ['TRANSIT', 'WALK']);
  assert.equal(profile.preferences[0].relaxationDirection, 'longer_travel_time');
});

test('interpreter extracts soft maxTransitMinutes with relaxable farther-is-ok semantics', async () => {
  const profile = await interpretPreferences('公交最好30分钟以内，远一点也行', {
    provider: mockProvider(baseProfile({
      transportPreference: {
        maxTransitMinutes: 30,
      },
      preferences: [{
        feature: 'travel_time',
        type: 'soft',
        importance: 'high',
        rule: { maxTransitMinutes: 30 },
        sourceText: '公交最好30分钟以内，远一点也行',
      }],
    })),
  });

  assert.equal(profile.transportPreference.maxTransitMinutes, 30);
  assert.equal(profile.preferences[0].feature, 'travel_time');
  assert.equal(profile.preferences[0].type, 'soft');
  assert.equal(profile.preferences[0].relaxable, true);
  assert.equal(profile.preferences[0].relaxationDirection, 'longer_travel_time');
});

test('interpreter extracts hard maxTransitMinutes when user says cannot exceed', async () => {
  const profile = await interpretPreferences('公交不能超过30分钟', {
    provider: mockProvider(baseProfile({
      transportPreference: {
        maxTransitMinutes: 30,
      },
      hardConstraints: [{
        feature: 'travel_time',
        type: 'hard',
        importance: 'high',
        priority: 'high',
        relaxable: false,
        rule: { maxTransitMinutes: 30 },
        sourceText: '公交不能超过30分钟',
      }],
    })),
  });

  assert.equal(profile.transportPreference.maxTransitMinutes, 30);
  assert.equal(profile.hardConstraints[0].feature, 'travel_time');
  assert.equal(profile.hardConstraints[0].relaxable, false);
  assert.equal(profile.preferences.length, 0);
});

test('interpreter extracts maxWalkMinutes and preferred transport modes', async () => {
  const profile = await interpretPreferences('走路15分钟以内最好，更愿意坐公交，开车也可以', {
    provider: mockProvider(baseProfile({
      transportPreference: {
        maxWalkMinutes: 15,
        preferredTransportModes: ['TRANSIT', 'DRIVE'],
      },
      preferences: [{
        feature: 'travel_time',
        type: 'soft',
        importance: 'medium',
        rule: {
          maxWalkMinutes: 15,
          preferredTransportModes: ['TRANSIT', 'DRIVE'],
        },
        sourceText: '走路15分钟以内最好，更愿意坐公交，开车也可以',
      }],
    })),
  });

  assert.equal(profile.transportPreference.maxWalkMinutes, 15);
  assert.deepEqual(profile.transportPreference.preferredTransportModes, ['TRANSIT', 'DRIVE']);
  assert.deepEqual(profile.preferences[0].rule.preferredTransportModes, ['TRANSIT', 'DRIVE']);
});

test('transport schema rejects unsupported transfer count and modes', () => {
  assert.throws(
    () => validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
      transportPreference: {
        maxTransitMinutes: 30,
        maxTransfers: 1,
      },
    }))),
    (error) => error.issues?.includes('transportPreference.maxTransfers is not allowed'),
  );

  assert.throws(
    () => validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
      transportPreference: {
        preferredTransportModes: ['BIKE'],
      },
    }))),
    (error) => error.issues?.includes('transportPreference.preferredTransportModes must contain only TRANSIT, WALK, DRIVE'),
  );
});

test('distance is not a user Preference feature', () => {
  assert.throws(
    () => validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
      preferences: [
        {
          feature: 'distance',
          type: 'soft',
          importance: 'medium',
          rule: { preferredMaxKm: 3 },
        },
      ],
    }))),
    (error) => error.issues?.some((issue) => issue.includes('feature must be one of')),
  );
});

test('hard and soft relaxable invariants are normalized and validated', () => {
  const normalized = normalizePreferenceProfile(baseProfile({
    preferences: [
      {
        feature: 'next_hour_free',
        type: 'soft',
        importance: 'high',
        relaxable: false,
        target: true,
        sourceText: '最好后一小时没人',
      },
    ],
    hardConstraints: [
      {
        feature: 'price',
        type: 'hard',
        importance: 'high',
        relaxable: true,
        rule: { max: 35 },
      },
    ],
  }));

  assert.equal(normalized.preferences[0].relaxable, true);
  assert.equal(normalized.hardConstraints[0].relaxable, false);
  assert.throws(
    () => validatePreferenceProfile({
      ...normalized,
      hardConstraints: [{ ...normalized.hardConstraints[0], relaxable: true }],
    }),
    (error) => error.issues?.includes('hardConstraints[0].relaxable must be false for hard constraints'),
  );
  assert.throws(
    () => validatePreferenceProfile({
      ...normalized,
      preferences: [{ ...normalized.preferences[0], relaxable: false }],
    }),
    (error) => error.issues?.includes('preferences[0].relaxable must be true for soft preferences'),
  );
});

test('importance and priority aliases are canonicalized before validation', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    preferences: [{
      feature: 'weather',
      type: 'soft',
      importance: 'medium',
      priority: 'high',
      rule: { condition: 'comfortable' },
      sourceText: '不要太晒',
    }],
  })));

  const weather = findItem(profile.preferences, 'weather');
  assert.equal(weather.importance, 'medium');
  assert.equal(weather.priority, 'medium');
});

test('v1 profile normalization compatibility preserves runtime fields', () => {
  const profile = normalizePreferenceProfile({
    version: 1,
    searchWindowDays: 7,
    preferences: [
      { feature: 'price', type: 'soft', direction: 'lower', importance: 'high' },
    ],
    hardConstraints: [],
    unresolvedPreferences: [],
    sourceText: 'synthetic',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-01T00:00:00.000Z',
  });

  assert.equal(profile.version, 2);
  assert.equal(profile.searchWindowDays, 7);
  assert.equal(profile.searchScope.days, 7);
  assert.equal(profile.preferences[0].priority, 'high');
  assert.deepEqual(profile.objectives, []);
});

test('v2 profile validation accepts objectives', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    objectives: [
      {
        feature: 'price',
        direction: 'minimize',
        priority: 'high',
        sourceText: '最便宜',
      },
      {
        feature: 'travel_time',
        direction: 'minimize',
        priority: 'medium',
        sourceText: '通勤时间短一点',
      },
    ],
  })));

  assert.equal(profile.objectives[0].feature, 'price');
  assert.equal(profile.objectives[0].direction, 'minimize');
  assert.equal(profile.objectives[1].feature, 'travel_time');
});

test('explicit no-preference remains omitted', async () => {
  const profile = await interpretPreferences('价格无所谓，Court几都行', {
    provider: mockProvider(baseProfile()),
  });

  assert.equal(profile.preferences.some((preference) => preference.feature === 'price'), false);
  assert.equal(profile.preferences.some((preference) => preference.feature === 'court'), false);
  assert.equal(profile.hardConstraints.length, 0);
  assert.equal(profile.unresolvedPreferences.length, 0);
});

test('unresolved cannot duplicate structured requirement', () => {
  assert.throws(
    () => validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
      preferences: [
        {
          feature: 'weather',
          type: 'soft',
          importance: 'medium',
          sourceText: '天气舒服一点',
          rule: { condition: 'comfortable' },
        },
      ],
      unresolvedPreferences: [
        { text: '天气舒服一点', reason: 'duplicate', sourceText: '天气舒服一点' },
      ],
    }))),
    (error) => error.issues?.includes('unresolvedPreferences duplicates structured requirement: 天气舒服一点'),
  );
});

test('searchScope validates relative date range and semantic period', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    searchScope: {
      days: 7,
      dateRange: {
        type: 'weekend',
        value: 'weekend',
        sourceText: '周末',
      },
      timeWindow: {
        period: 'evening',
      },
      sourceText: '周末晚上',
    },
  })));

  assert.equal(profile.searchScope.dateRange.type, 'weekend');
  assert.equal(profile.searchScope.timeWindow.period, 'evening');
});

test('vague semantic period support avoids fake exact time', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    preferences: [
      {
        feature: 'start_time',
        type: 'soft',
        importance: 'medium',
        rule: { period: 'not_too_early' },
      },
    ],
  })));

  assert.deepEqual(profile.preferences[0].rule, { period: 'not_too_early' });
});

test('OpenAI schema object nodes satisfy strict required coverage', () => {
  assert.equal(assertOpenAiStrictObjectSchema(openAiPreferenceProfileJsonSchema), true);
});

test('OpenAI schema object nodes all set additionalProperties false', () => {
  for (const { path, schema } of collectObjectSchemas(openAiPreferenceProfileJsonSchema)) {
    assert.equal(schema.additionalProperties, false, `${path} must set additionalProperties=false`);
  }
});

test('OpenAI schema separates feature-specific rules', () => {
  const priceVariant = openAiPreferenceProfileJsonSchema
    .properties
    .preferences
    .items
    .anyOf
    .find((schema) => schema.properties.feature.enum[0] === 'price');
  const startTimeVariant = openAiPreferenceProfileJsonSchema
    .properties
    .preferences
    .items
    .anyOf
    .find((schema) => schema.properties.feature.enum[0] === 'start_time');

  assert.equal(priceVariant.properties.rule.properties.before, undefined);
  assert.ok(startTimeVariant.properties.rule.properties.before);
});

test('prompt contract includes semantic hard-soft policy and no-preference omission', () => {
  const messages = buildInterpreterMessages('价格无所谓，17点以后都可以');
  const system = messages[0].content;

  assert.match(system, /semantic acceptability/);
  assert.match(system, /Explicit no-preference/);
  assert.match(system, /Do not invent exact numeric thresholds/);
  assert.match(system, /travel_time/);
  assert.match(system, /deterministic default searchScope\.days=7/);
  assert.match(system, /Do not also create an equivalent soft preference/);
  assert.doesNotMatch(system, /unless the user uses absolute language/);
});

test('case_001 regression: hard OR time boundary and no price double count', async () => {
  assert.equal(evalCaseIds.has('case_001'), true);
  const profile = await interpretCase('case_001', baseProfile({
    searchWindowDays: 30,
    searchScope: { days: 30, sourceText: '13点前或者17点以后都行', timeWindow: { before: '13:00', after: '17:00' } },
    preferences: [
      { feature: 'price', type: 'soft', importance: 'high', direction: 'lower', sourceText: '我主要想便宜' },
      { feature: 'next_hour_free', type: 'soft', importance: 'high', target: true, sourceText: '最好后一小时也没人' },
    ],
    hardConstraints: [
      {
        feature: 'start_time',
        type: 'hard',
        importance: 'high',
        rule: {
          before: '13:00',
          after: '00:00',
          exclude: [{ start: '13:00', end: '17:00' }],
        },
      },
    ],
    objectives: [{ feature: 'price', direction: 'minimize', priority: 'high', sourceText: '我主要想便宜' }],
  }));

  assert.equal(profile.searchWindowDays, 7);
  assert.deepEqual(findItem(profile.hardConstraints, 'start_time').rule, { before: '13:00', after: '17:00' });
  assertNoEquivalentPreferenceForObjective(profile, 'price');
});

test('case_002 regression: hard consecutive 120, hard time, soft court avoid, objective price', async () => {
  const profile = await interpretCase('case_002', baseProfile({
    searchScope: { days: 14, dateRange: { type: 'next_few_days', sourceText: '最近几天' }, timeWindow: { before: '13:00', after: '17:00' } },
    preferences: [
      { feature: 'consecutive_availability', type: 'soft', importance: 'high', rule: { minMinutes: 120, preferredMinutes: 120 }, sourceText: '连续两小时没人的' },
      {
        feature: 'court',
        type: 'soft',
        importance: 'medium',
        direction: 'avoid',
        rule: { exclude: ['Court 3', 'Court 6'] },
        sourceText: '尽量不要在边上的Court 3和Court 6',
      },
      { feature: 'price', type: 'soft', importance: 'high', direction: 'lower', sourceText: '最便宜' },
    ],
    hardConstraints: [],
    objectives: [{ feature: 'price', direction: 'minimize', priority: 'high', sourceText: '最便宜' }],
    unresolvedPreferences: [{ text: '最近几天', sourceText: '最近几天' }],
  }));

  assert.equal(profile.searchWindowDays, 3);
  assert.equal(findItem(profile.hardConstraints, 'consecutive_availability').rule.minMinutes, 120);
  assert.deepEqual(findItem(profile.hardConstraints, 'start_time').rule, { before: '13:00', after: '17:00' });
  assert.deepEqual(findItem(profile.preferences, 'court').rule.exclude, ['Court 3', 'Court 6']);
  assertNoEquivalentPreferenceForObjective(profile, 'price');
  assert.equal(profile.unresolvedPreferences.length, 0);
});

test('case_003 regression: today scope, semantic evening, duration 60, cheapest objective', async () => {
  const profile = await interpretCase('case_003', baseProfile({
    searchScope: {
      days: 14,
      dateRange: { type: 'today', sourceText: '今天' },
      timeWindow: { period: 'evening', after: '18:00' },
    },
    preferences: [{ feature: 'price', type: 'soft', importance: 'medium', direction: 'lower', sourceText: '便宜订哪个' }],
    preferences: [
      { feature: 'duration', type: 'soft', importance: 'medium', rule: { exactMinutes: 60 }, sourceText: '一个小时' },
      { feature: 'price', type: 'soft', importance: 'medium', direction: 'lower', sourceText: '便宜订哪个' },
    ],
    objectives: [{ feature: 'price', direction: 'minimize', priority: 'medium', sourceText: '便宜订哪个' }],
  }));

  assert.equal(profile.searchWindowDays, 1);
  assert.equal(profile.searchScope.dateRange.type, 'today');
  assert.deepEqual(profile.searchScope.timeWindow, { period: 'evening' });
  assert.equal(findItem(profile.hardConstraints, 'duration').rule.exactMinutes, 60);
  assertNoEquivalentPreferenceForObjective(profile, 'price');
});

test('case_004 regression: price indifference omitted, following hour hard, duration objective', async () => {
  const profile = await interpretCase('case_004', baseProfile({
    preferences: [
      { feature: 'price', type: 'soft', importance: 'low', direction: 'lower', sourceText: '价格无所谓' },
      { feature: 'next_hour_free', type: 'soft', importance: 'high', target: true, sourceText: '主要是后一小时也得空着' },
    ],
    hardConstraints: [],
    objectives: [{ feature: 'duration', direction: 'maximize', priority: 'high', sourceText: '尽量多打一会儿' }],
    unresolvedPreferences: [{ text: '价格无所谓', sourceText: '价格无所谓' }],
  }));

  assert.equal(profile.preferences.some((preference) => preference.feature === 'price'), false);
  assert.equal(findItem(profile.hardConstraints, 'next_hour_free').target, true);
  assert.equal(findItem(profile.objectives, 'duration').direction, 'maximize');
  assert.equal(profile.unresolvedPreferences.length, 0);
});

test('case_005 regression: preferred Court 4/5/6 with fallback', async () => {
  const profile = await interpretCase('case_005', baseProfile({
    preferences: [{
      feature: 'court',
      type: 'soft',
      importance: 'medium',
      relaxable: true,
      rule: { include: ['Court 4', 'Court 5', 'Court 6'] },
      sourceText: 'Court 4、5、6优先吧，实在没有的话其他场也行',
    }],
  }));

  assert.deepEqual(findItem(profile.preferences, 'court').rule.include, ['Court 4', 'Court 5', 'Court 6']);
  assert.equal(findItem(profile.preferences, 'court').relaxable, true);
  assert.equal(profile.hardConstraints.some((constraint) => constraint.feature === 'court'), false);
});

test('case_006 regression: USYD and Court 4/5/6 are hard', async () => {
  const profile = await interpretCase('case_006', baseProfile({
    hardConstraints: [
      { feature: 'venue', type: 'hard', importance: 'high', rule: { include: ['usyd'] }, sourceText: '只看usyd' },
      { feature: 'court', type: 'hard', importance: 'high', rule: { include: ['Court 4', 'Court 5', 'Court 6'] }, sourceText: 'Court 4、5、6' },
    ],
  }));

  assert.deepEqual(findItem(profile.hardConstraints, 'venue').rule.include, ['usyd']);
  assert.deepEqual(findItem(profile.hardConstraints, 'court').rule.include, ['Court 4', 'Court 5', 'Court 6']);
});

test('case_007 regression: vague periods remain semantic', async () => {
  const profile = await interpretCase('case_007', baseProfile({
    preferences: [
      { feature: 'start_time', type: 'soft', importance: 'high', direction: 'preferred', rule: { period: 'morning' }, sourceText: '最好早上打' },
      { feature: 'start_time', type: 'soft', importance: 'medium', direction: 'preferred', rule: { period: 'evening' }, sourceText: '晚上也可以' },
      { feature: 'start_time', type: 'soft', importance: 'medium', direction: 'avoid', rule: { period: 'midday', exclude: [{ start: '11:00', end: '14:00' }] }, sourceText: '中午不想打' },
    ],
  }));

  assert.deepEqual(profile.preferences.map((preference) => preference.rule.period), ['morning', 'evening', 'midday']);
});

test('v2.2 regression: vague midday avoid is not upgraded to a hard constraint', async () => {
  const profile = await interpretCase('case_007', baseProfile({
    preferences: [
      { feature: 'start_time', type: 'soft', importance: 'medium', direction: 'preferred', value: 'morning', rule: { period: 'morning' }, sourceText: '最好早上打，不过晚上也可以' },
      { feature: 'start_time', type: 'soft', importance: 'low', direction: 'preferred', value: 'evening', rule: { period: 'evening' }, sourceText: '不过晚上也可以' },
    ],
    hardConstraints: [
      { feature: 'start_time', type: 'hard', importance: 'high', direction: 'avoid', value: 'midday', rule: { period: 'midday' }, sourceText: '中午不想打' },
    ],
  }));

  assert.equal(startTimeHardConstraints(profile).some((constraint) => constraint.rule?.period === 'midday'), false);
  assert.ok(profile.preferences.some((preference) => preference.feature === 'start_time'
    && preference.direction === 'avoid'
    && preference.rule?.period === 'midday'));
});

test('case_008 regression: after 17 hard and earlier objective', async () => {
  const profile = await interpretCase('case_008', baseProfile({
    hardConstraints: [{ feature: 'start_time', type: 'hard', importance: 'high', rule: { after: '17:00' }, sourceText: '17点以后都可以' }],
    preferences: [{ feature: 'start_time', type: 'soft', importance: 'high', direction: 'earlier', sourceText: '越早越好' }],
    objectives: [{ feature: 'start_time', direction: 'earlier', priority: 'high', sourceText: '越早越好' }],
  }));

  assert.deepEqual(findItem(profile.hardConstraints, 'start_time').rule, { after: '17:00' });
  assertNoEquivalentPreferenceForObjective(profile, 'start_time');
});

test('case_009 regression: tomorrow date and unavailable 13-17 hard, no indifference unresolved', async () => {
  const profile = await interpretCase('case_009', baseProfile({
    searchScope: { days: 7, dateRange: { type: 'tomorrow', sourceText: '明天' } },
    hardConstraints: [
      { feature: 'date', type: 'hard', importance: 'high', rule: { dateRange: { type: 'tomorrow', sourceText: '明天' } } },
      { feature: 'start_time', type: 'hard', importance: 'high', direction: 'avoid', rule: { exclude: [{ start: '13:00', end: '17:00' }] }, sourceText: '13点到17点我有课' },
    ],
    unresolvedPreferences: [{ text: '其他时间随便', sourceText: '其他时间随便' }],
  }));

  assert.equal(profile.searchWindowDays, 1);
  assert.equal(findItem(profile.hardConstraints, 'date').rule.dateRange.type, 'tomorrow');
  assert.deepEqual(findItem(profile.hardConstraints, 'start_time').rule, { before: '13:00', after: '17:00' });
  assert.equal(profile.unresolvedPreferences.length, 0);
});

test('v2.2 regression: equivalent unavailable time constraints are canonicalized and deduped', async () => {
  const profile = await interpretCase('case_009', baseProfile({
    searchScope: {
      days: 1,
      dateRange: { type: 'tomorrow', sourceText: '明天' },
      timeWindow: { before: '13:00', after: '17:00' },
      sourceText: '明天13点到17点我有课，这段时间肯定不行，其他时间随便',
    },
    hardConstraints: [
      {
        feature: 'start_time',
        type: 'hard',
        importance: 'high',
        direction: 'avoid',
        rule: { exclude: [{ start: '13:00', end: '17:00' }] },
        sourceText: '明天13点到17点我有课，这段时间肯定不行',
      },
    ],
  }));

  assert.equal(startTimeHardConstraints(profile).length, 1);
  assert.deepEqual(startTimeHardConstraints(profile)[0].rule, { before: '13:00', after: '17:00' });
});

test('case_010 regression: time indifference omitted from unresolved', async () => {
  const profile = await interpretCase('case_010', baseProfile({
    searchScope: { days: 14, dateRange: { type: 'this_week', sourceText: '这周' } },
    preferences: [{ feature: 'weather', type: 'soft', importance: 'medium', rule: { condition: 'comfortable' }, sourceText: '天气舒服一点最好' }],
    unresolvedPreferences: [{ text: '时间我无所谓', sourceText: '时间我无所谓' }],
  }));

  assert.equal(profile.searchWindowDays, 7);
  assert.equal(findItem(profile.preferences, 'weather').rule.condition, 'comfortable');
  assert.equal(profile.unresolvedPreferences.length, 0);
});

test('v2.2 regression: weather preference does not use meaningless higher direction', async () => {
  const rawProfile = normalizePreferenceProfile(baseProfile({
    preferences: [{
      feature: 'weather',
      type: 'soft',
      importance: 'medium',
      direction: 'higher',
      value: 'comfortable',
      rule: { condition: 'comfortable' },
      sourceText: '天气舒服一点最好',
    }],
  }));

  assert.equal(rawProfile.preferences[0].direction, 'preferred');
  assert.equal(rawProfile.preferences[0].relaxationDirection, 'ask_user');
  assert.throws(
    () => validatePreferenceProfile({
      ...rawProfile,
      preferences: [{ ...rawProfile.preferences[0], direction: 'higher', relaxationDirection: 'lower_quality' }],
    }),
    (error) => error.issues?.some((issue) => issue.includes('direction is not allowed for weather')),
  );
});

test('weather sun exposure aliases normalize instead of rejecting the profile', () => {
  const profile = validatePreferenceProfile(normalizePreferenceProfile(baseProfile({
    preferences: [{
      feature: 'weather',
      type: 'soft',
      importance: 'medium',
      direction: 'avoid',
      rule: { condition: 'not_too_sunny' },
      sourceText: '不要太晒',
    }],
  })));

  const weather = findItem(profile.preferences, 'weather');
  assert.equal(weather.rule.condition, 'comfortable');
  assert.equal(weather.direction, 'avoid');
});

test('case_011 regression: no rain hard weather', async () => {
  const profile = await interpretCase('case_011', baseProfile({
    hardConstraints: [{ feature: 'weather', type: 'hard', importance: 'high', rule: { condition: 'no_rain' }, sourceText: '别下雨就行' }],
    unresolvedPreferences: [{ text: '其他都好说', sourceText: '其他都好说' }],
  }));

  assert.equal(findItem(profile.hardConstraints, 'weather').rule.condition, 'no_rain');
  assert.equal(profile.unresolvedPreferences.length, 0);
});

test('v2.2 regression: no-rain hard constraint cannot be silently dropped', async () => {
  const profile = await interpretCase('case_011', baseProfile({
    searchScope: { days: 7, sourceText: '别下雨就行' },
  }));

  assert.equal(findItem(profile.hardConstraints, 'weather').rule.condition, 'no_rain');
});

test('case_012 regression: vague heat remains semantic and price importance is objective', async () => {
  const profile = await interpretCase('case_012', baseProfile({
    preferences: [
      { feature: 'weather', type: 'soft', importance: 'medium', direction: 'avoid', value: 'not_too_hot', sourceText: '别热得离谱' },
      { feature: 'price', type: 'soft', importance: 'high', direction: 'lower', sourceText: '便宜更重要' },
    ],
  }));

  assert.equal(findItem(profile.preferences, 'weather').rule.condition, 'not_too_hot');
  assert.equal(findItem(profile.preferences, 'weather').rule.maxTemperatureC, undefined);
  assertNoEquivalentPreferenceForObjective(profile, 'price');
});

test('case_013 regression: price max hard and 120min availability soft', async () => {
  const profile = await interpretCase('case_013', baseProfile({
    hardConstraints: [{ feature: 'price', type: 'hard', importance: 'high', rule: { max: 35 }, sourceText: '超过35刀我就不订了' }],
    preferences: [{ feature: 'consecutive_availability', type: 'soft', importance: 'medium', rule: { preferredMinutes: 120 }, sourceText: '最好还能连续打两个小时' }],
  }));

  assert.equal(findItem(profile.hardConstraints, 'price').rule.max, 35);
  assert.equal(findItem(profile.preferences, 'consecutive_availability').rule.preferredMinutes, 120);
});

test('case_014 regression: price-insensitive is not higher price preference and vague time is unresolved', async () => {
  const profile = await interpretCase('case_014', baseProfile({
    preferences: [
      { feature: 'price', type: 'soft', importance: 'medium', direction: 'higher', sourceText: '贵一点没事' },
      { feature: 'next_hour_free', type: 'soft', importance: 'high', relaxable: false, target: true, sourceText: '后一小时没人' },
    ],
    objectives: [{ feature: 'start_time', direction: 'preferred', priority: 'high', sourceText: '只要时间合适' }],
  }));

  assert.equal(profile.preferences.some((preference) => preference.feature === 'price'), false);
  assert.equal(findItem(profile.hardConstraints, 'next_hour_free').target, true);
  assert.equal(profile.objectives.some((objective) => objective.feature === 'start_time'), false);
  assert.equal(profile.unresolvedPreferences[0].text, '只要时间合适');
});

test('v2.2 regression: following-hour requirement may use either canonical feature without duplication or drift', async () => {
  const profile = await interpretCase('case_014', baseProfile({
    hardConstraints: [
      {
        feature: 'consecutive_availability',
        type: 'hard',
        importance: 'high',
        target: true,
        rule: { minMinutes: 120 },
        sourceText: '后一小时没人',
      },
    ],
  }));

  const followingHourHard = profile.hardConstraints.filter((constraint) => (
    constraint.feature === 'next_hour_free' && constraint.target === true
  ) || (
    constraint.feature === 'consecutive_availability' && constraint.rule?.minMinutes === 120
  ));
  assert.equal(followingHourHard.length, 1);
  assert.equal(profile.preferences.some((preference) => ['next_hour_free', 'consecutive_availability'].includes(preference.feature)), false);
});

test('case_015 regression: cheapest objective and court/weather indifference omitted', async () => {
  const profile = await interpretCase('case_015', baseProfile({
    preferences: [
      { feature: 'price', type: 'soft', importance: 'high', direction: 'lower', sourceText: '最便宜' },
      { feature: 'court', type: 'soft', importance: 'low', sourceText: 'Court几都不在乎' },
      { feature: 'weather', type: 'soft', importance: 'low', sourceText: '天气怎么样我都不在乎' },
    ],
    objectives: [{ feature: 'price', direction: 'minimize', priority: 'high', sourceText: '最便宜' }],
    unresolvedPreferences: [{ text: 'Court几、天气怎么样我都不在乎', sourceText: 'Court几、天气怎么样我都不在乎' }],
  }));

  assertNoEquivalentPreferenceForObjective(profile, 'price');
  assert.equal(profile.preferences.some((preference) => ['court', 'weather'].includes(preference.feature)), false);
  assert.equal(profile.unresolvedPreferences.length, 0);
});

test('case_016 regression: three adjacent courts hard', async () => {
  const profile = await interpretCase('case_016', baseProfile({
    hardConstraints: [
      { feature: 'court_count', type: 'hard', importance: 'high', rule: { exact: 3 }, sourceText: '三个连续的场' },
      { feature: 'adjacency', type: 'hard', importance: 'high', rule: { required: true }, sourceText: '必须挨在一起' },
    ],
  }));

  assert.equal(findItem(profile.hardConstraints, 'court_count').rule.exact, 3);
  assert.equal(findItem(profile.hardConstraints, 'adjacency').rule.required, true);
});

test('case_017 regression: two courts hard, adjacency soft, sourceText comes from court phrase', async () => {
  const profile = await interpretCase('case_017', baseProfile({
    preferences: [
      { feature: 'court_count', type: 'soft', importance: 'medium', relaxationDirection: 'shorter_duration', rule: { exact: 2 }, sourceText: '我们大概三个人打' },
      { feature: 'adjacency', type: 'soft', importance: 'medium', rule: { preferred: true }, sourceText: '最好找两块挨着的场' },
    ],
  }));

  assert.equal(findItem(profile.hardConstraints, 'court_count').rule.exact, 2);
  assert.equal(findItem(profile.preferences, 'adjacency').rule.preferred, true);
  assert.match(findItem(profile.hardConstraints, 'court_count').sourceText, /两块挨着的场/);
  assert.doesNotMatch(findItem(profile.hardConstraints, 'court_count').sourceText, /三个人/);
  assert.equal(findItem(profile.preferences, 'adjacency').relaxationDirection, 'non_adjacent_courts');
});

test('case_018 regression: no explicit preference and no unresolved', async () => {
  const profile = await interpretCase('case_018', baseProfile({
    searchScope: { days: 30, sourceText: '最近几天' },
    unresolvedPreferences: [{ text: '没什么特别要求', sourceText: '没什么特别要求' }],
  }));

  assert.equal(profile.searchWindowDays, 3);
  assert.equal(profile.preferences.length, 0);
  assert.equal(profile.objectives.length, 0);
  assert.equal(profile.unresolvedPreferences.length, 0);
});

test('case_019 regression: weekend scope, vague time soft, price soft', async () => {
  const profile = await interpretCase('case_019', baseProfile({
    searchScope: { days: 14, dateRange: { type: 'weekend', sourceText: '周末' } },
    preferences: [
      { feature: 'start_time', type: 'soft', importance: 'medium', rule: { period: 'not_too_early' }, sourceText: '不想起太早' },
      { feature: 'start_time', type: 'soft', importance: 'medium', rule: { period: 'not_too_late' }, sourceText: '也别太晚' },
      { feature: 'price', type: 'soft', importance: 'medium', direction: 'lower', sourceText: '便宜一点就更好了' },
    ],
  }));

  assert.equal(profile.searchWindowDays, 2);
  assert.equal(profile.searchScope.dateRange.type, 'weekend');
  assert.deepEqual(profile.preferences.filter((preference) => preference.feature === 'start_time').map((preference) => preference.rule.period), ['not_too_early', 'not_too_late']);
  assert.equal(findItem(profile.preferences, 'price').direction, 'lower');
});

test('case_020 regression: afternoon conflict is not dropped and uncertain evening is unresolved', async () => {
  const profile = await interpretCase('case_020', baseProfile({
    searchScope: { days: 7, timeWindow: { before: '18:00', after: '20:00' }, sourceText: '我下午有事，晚上可能也有安排，你先看看有什么场再说' },
  }));

  assert.equal(findItem(profile.hardConstraints, 'start_time').rule.period, 'afternoon');
  assert.equal(profile.unresolvedPreferences[0].text, '晚上可能也有安排');
  assert.equal(profile.searchScope.timeWindow, undefined);
});

test('v2.3 regression: uncertain availability is not both structured and unresolved', async () => {
  const profile = await interpretCase('case_020', baseProfile({
    hardConstraints: [
      {
        feature: 'start_time',
        type: 'hard',
        importance: 'medium',
        direction: 'avoid',
        rule: { period: 'evening' },
        sourceText: '晚上可能也有安排',
      },
    ],
    unresolvedPreferences: [{ text: '晚上可能也有安排', sourceText: '晚上可能也有安排' }],
  }));

  assert.equal(profile.hardConstraints.some((constraint) => constraint.sourceText === '晚上可能也有安排'), false);
  assert.equal(profile.unresolvedPreferences.filter((item) => item.text === '晚上可能也有安排').length, 1);
});

test('preference store loads older profiles by normalizing to v2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tennis-preferences-'));
  const path = join(dir, 'preferences.json');
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      searchWindowDays: 7,
      preferences: [
        { feature: 'price', type: 'soft', direction: 'lower', importance: 'high' },
      ],
      hardConstraints: [],
      unresolvedPreferences: [],
      sourceText: 'synthetic',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }));

    const profile = await loadPreferenceProfile({ path });
    assert.equal(profile.version, 2);
    assert.equal(profile.preferences[0].priority, 'high');
    assert.equal(profile.preferences[0].relaxable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing saved preference profile loads empty default profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tennis-preferences-missing-'));
  const path = join(dir, 'preferences.json');
  try {
    const profile = await loadPreferenceProfile({
      path,
      now: new Date('2026-09-10T00:00:00.000Z'),
    });

    assert.equal(profile.version, 2);
    assert.equal(profile.searchWindowDays, 7);
    assert.deepEqual(profile.preferences, []);
    assert.deepEqual(profile.hardConstraints, []);
    assert.deepEqual(profile.objectives, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser profile storage saves and loads persistent fields', () => {
  const storage = fakeLocalStorage();
  const now = new Date('2026-09-10T00:00:00.000Z');
  const profile = profileFromPersistentFields({
    preferredAreas: ['Central'],
    preferredVenues: ['SUSF'],
    preferredCourts: ['Court 4', 'Court 5'],
    avoidedCourts: ['Court 6'],
    preferredSurfaces: ['synthetic'],
    priceSensitivity: 'high',
    preferredTimeWindows: [{ before: '13:00' }, { after: '17:00' }],
    preferredDurationMinutes: 60,
    maxTravelMinutes: 30,
  }, { now });

  saveProfile(profile, { storage, now });
  const loaded = loadProfile({ storage, now });

  assert.equal(loaded.version, 2);
  assert.deepEqual(findItem(loaded.preferences, 'area').rule.include, ['Central']);
  assert.deepEqual(findItem(loaded.preferences, 'venue').rule.include, ['SUSF']);
  assert.deepEqual(findItem(loaded.preferences, 'court').rule.include, ['Court 4', 'Court 5']);
  assert.deepEqual(findItem(loaded.preferences, 'court').rule.exclude, ['Court 6']);
  assert.deepEqual(findItem(loaded.preferences, 'surface').rule.include, ['synthetic']);
  assert.equal(findItem(loaded.preferences, 'price').importance, 'high');
  assert.equal(findStructuredItem(loaded, 'duration').rule.exactMinutes, 60);
  assert.equal(loaded.transportPreference.maxTransitMinutes, 30);
});

test('browser user profile fields roundtrip canonical MVP values', () => {
  const storage = fakeLocalStorage();
  const saved = saveUserProfileFields({
    preferredDays: ['Tuesday'],
    preferredTimeWindows: [{ start: '17:00', end: '20:00' }],
    typicalDurationMinutes: 60,
    maxTravelMinutes: 30,
    preferredVenues: ['SUSF'],
  }, { storage, now: new Date('2026-09-10T00:00:00.000Z') });
  const loaded = loadUserProfileFields({ storage });

  assert.deepEqual(saved, {
    preferredDays: ['Tuesday'],
    preferredTimeWindows: [{ start: '17:00', end: '20:00' }],
    typicalDurationMinutes: 60,
    maxTravelMinutes: 30,
    preferredVenues: ['SUSF'],
  });
  assert.deepEqual(loaded, saved);
});

test('behavior storage roundtrip summarizes booking clicks', () => {
  const storage = fakeLocalStorage();
  recordSearch({ rawRequest: '明天在USYD打球', resolvedLocation: 'USYD' }, { storage, now: new Date('2026-09-10T00:00:00.000Z') });
  recordBookingClick({
    venue: 'SUSF',
    court: 'Court 4',
    startTime: '2026-09-10T18:00:00+10:00',
    durationMinutes: 60,
    bookingProvider: 'susf.example.test',
  }, { storage, now: new Date('2026-09-10T01:00:00.000Z') });

  const loaded = loadBehaviorHistory({ storage });
  const summary = summarizeBehavior(loaded);

  assert.equal(loaded.recentSearches[0].rawRequest, '明天在USYD打球');
  assert.equal(loaded.recentBookingClicks[0].court, 'Court 4');
  assert.equal(summary.bookingClickCount, 1);
  assert.deepEqual(summary.recentStartTimes, ['18:00']);
});

test('behavior storage keeps bounded newest history', () => {
  const storage = fakeLocalStorage();
  for (let index = 0; index < 25; index += 1) {
    recordBookingClick({
      venue: 'SUSF',
      court: `Court ${index}`,
      startTime: `2026-09-${String(index + 1).padStart(2, '0')}T18:00:00+10:00`,
    }, { storage, now: new Date(`2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`) });
  }

  const loaded = loadBehaviorHistory({ storage });
  assert.equal(loaded.recentBookingClicks.length, 20);
  assert.equal(loaded.recentBookingClicks[0].court, 'Court 24');
  assert.equal(loaded.recentBookingClicks.at(-1).court, 'Court 5');
  assert.equal(clearBehaviorHistory({ storage }), true);
  assert.equal(loadBehaviorHistory({ storage }).recentBookingClicks.length, 0);
});

test('browser profile storage reports corrupted JSON', () => {
  const storage = fakeLocalStorage();
  storage.setItem('findmycourt.profile.v1', '{bad json');

  assert.throws(
    () => loadProfile({ storage }),
    (error) => error.code === 'PROFILE_JSON_CORRUPTED',
  );
});

test('browser profile storage treats throwing localStorage getter as unavailable', () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      get localStorage() {
        throw new Error('localStorage blocked');
      },
    },
  });

  try {
    assert.equal(loadProfile(), null);
    assert.equal(clearProfile(), false);
  } finally {
    if (hadWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      });
    } else {
      delete globalThis.window;
    }
  }
});

test('browser profile storage clears saved profile', () => {
  const storage = fakeLocalStorage();
  const profile = profileFromPersistentFields({ preferredCourts: ['Court 4'] });

  saveProfile(profile, { storage });
  assert.ok(loadProfile({ storage }));
  assert.equal(clearProfile({ storage }), true);
  assert.equal(loadProfile({ storage }), null);
});

test('session-only current request fields are not persisted', () => {
  const storage = fakeLocalStorage();
  const current = normalizePreferenceProfile(baseProfile({
    searchScope: {
      days: 1,
      dateRange: { type: 'tomorrow', sourceText: 'tomorrow' },
      timeWindow: { after: '17:00' },
      location: 'Central',
      sourceText: 'tomorrow after 5 near Central',
      source: 'user',
      isExplicit: true,
    },
    preferences: [
      {
        feature: 'start_time',
        type: 'soft',
        importance: 'high',
        rule: { after: '17:00' },
        sourceText: 'tomorrow after 5',
      },
    ],
    hardConstraints: [
      {
        feature: 'date',
        type: 'hard',
        importance: 'high',
        rule: { dateRange: { type: 'tomorrow', sourceText: 'tomorrow' } },
        sourceText: 'tomorrow',
      },
    ],
    sourceText: 'tomorrow after 5 near Central',
  }));

  updateProfile(current, { storage, now: new Date('2026-09-10T00:00:00.000Z') });
  const loaded = loadProfile({ storage });

  assert.equal(loaded.preferences.some((preference) => preference.feature === 'start_time'), false);
  assert.equal(loaded.hardConstraints.some((constraint) => constraint.feature === 'date'), false);
  assert.equal(loaded.searchScope.location, undefined);
});

test('current request overrides persistent profile for merged runtime profile', () => {
  const storage = fakeLocalStorage();
  const now = new Date('2026-09-10T00:00:00.000Z');
  saveProfile(profileFromPersistentFields({ preferredCourts: ['Court 4'] }, { now }), { storage, now });
  const current = normalizePreferenceProfile(baseProfile({
    preferences: [
      {
        feature: 'court',
        type: 'soft',
        importance: 'high',
        rule: { include: ['Court 5'] },
        sourceText: 'today Court 5',
      },
    ],
    sourceText: 'today Court 5',
  }));

  const merged = updateProfile(current, { storage, now });
  const savedAfterCurrentRequest = loadProfile({ storage, now });

  assert.deepEqual(findItem(merged.preferences, 'court').rule.include, ['Court 5']);
  assert.deepEqual(findItem(savedAfterCurrentRequest.preferences, 'court').rule.include, ['Court 4']);
});

test('mergeProfiles uses current request before persistent profile before defaults', () => {
  const persistentProfile = profileFromPersistentFields({
    preferredCourts: ['Court 4'],
    priceSensitivity: 'low',
  });
  const currentRequestProfile = normalizePreferenceProfile(baseProfile({
    preferences: [
      {
        feature: 'price',
        type: 'soft',
        importance: 'high',
        direction: 'lower',
        sourceText: 'cheap is important',
      },
    ],
  }));

  const merged = mergeProfiles({ persistentProfile, currentRequestProfile });

  assert.deepEqual(findItem(merged.preferences, 'court').rule.include, ['Court 4']);
  assert.equal(findItem(merged.preferences, 'price').importance, 'high');
  assert.equal(merged.searchScope.days, 7);
});
