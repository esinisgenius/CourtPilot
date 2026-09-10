import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHardConstraints,
  attachCalendar,
  candidatePreferredTransportModes,
  enrichCandidates,
  evaluateTransport,
} from '../packages/core/src/index.mjs';
import {
  createInitialAgentState,
  evaluateCandidateSet,
} from '../packages/agent/src/index.mjs';
import { normalizePreferenceProfile } from '../packages/preferences/src/index.mjs';

function candidate(id, startTime = '2026-09-03T09:00:00.000Z') {
  return {
    id,
    venue: 'SUSF',
    court: 'Court 4',
    startTime,
    durationMinutes: 60,
    features: {
      nextHourFree: true,
      localDate: '2026-09-03',
      localTime: '19:00',
      price: null,
      priceOptions: [],
    },
  };
}

function profile({ weatherType = null } = {}) {
  const hardConstraints = [];
  const preferences = [];
  if (weatherType === 'hard') {
    hardConstraints.push({
      feature: 'weather',
      type: 'hard',
      importance: 'high',
      priority: 'high',
      value: 'no_precipitation',
    });
  }
  if (weatherType === 'soft') {
    preferences.push({
      feature: 'weather',
      type: 'soft',
      importance: 'medium',
      priority: 'medium',
      relaxable: true,
    });
  }

  return normalizePreferenceProfile({
    version: 1,
    searchWindowDays: 7,
    preferences,
    hardConstraints,
    unresolvedPreferences: [],
    sourceText: 'synthetic',
    updatedAt: '2026-09-03T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-03T00:00:00.000Z',
  });
}

function withWeather(baseCandidate, weather) {
  return {
    ...baseCandidate,
    features: {
      ...baseCandidate.features,
      weather,
    },
  };
}

function withAccessibility(baseCandidate, accessibility) {
  return {
    ...baseCandidate,
    accessibility,
    features: {
      ...baseCandidate.features,
      accessibility,
    },
  };
}

function accessibility({
  walkMinutes = 12,
  transitMinutes = 25,
  driveMinutes = 10,
  walkReason = null,
  transitReason = null,
  driveReason = null,
} = {}) {
  return {
    origin: { placeId: 'origin', label: 'USYD' },
    walk: { durationMinutes: walkMinutes, distanceMeters: walkMinutes === null ? null : walkMinutes * 100, unavailableReason: walkReason },
    transit: {
      durationMinutes: transitMinutes,
      distanceMeters: transitMinutes === null ? null : transitMinutes * 100,
      departureTime: '2026-09-03T08:15:00.000Z',
      unavailableReason: transitReason,
    },
    drive: { durationMinutes: driveMinutes, distanceMeters: driveMinutes === null ? null : driveMinutes * 100, unavailableReason: driveReason },
    source: 'google_routes',
    observedAt: '2026-09-03T00:00:00.000Z',
  };
}

function transportProfile({ hard = [], soft = [], transportPreference = {} } = {}) {
  return normalizePreferenceProfile({
    version: 2,
    searchWindowDays: 7,
    searchScope: {
      days: 7,
      sourceText: 'synthetic transport',
    },
    transportPreference,
    preferences: soft,
    hardConstraints: hard,
    objectives: [],
    unresolvedPreferences: [],
    sourceText: 'synthetic transport',
    updatedAt: '2026-09-03T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-03T00:00:00.000Z',
  });
}

test('calendar busy candidate is rejected by default hard policy', () => {
  const [current] = attachCalendar([candidate('busy')], [
    { start: '2026-09-03T09:30:00.000Z', end: '2026-09-03T10:30:00.000Z' },
  ]);

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile(),
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reasons[0].reason, 'calendar_conflict');
});

test('hard maxTransitMinutes rejects only known transit limit violations', () => {
  const current = attachCalendar([
    withAccessibility(candidate('too-far'), accessibility({ transitMinutes: 35 })),
  ], [])[0];
  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: transportProfile({
      hard: [{
        feature: 'travel_time',
        type: 'hard',
        importance: 'high',
        priority: 'high',
        rule: { maxTransitMinutes: 30 },
      }],
      transportPreference: { maxTransitMinutes: 30 },
    }),
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reasons[0].reason, 'transport_time_exceeds_limit');
  assert.equal(result.rejected[0].reasons[0].mode, 'TRANSIT');
});

test('hard transport missing accessibility is distinct from exceeding the limit', () => {
  const current = attachCalendar([candidate('missing-accessibility')], [])[0];
  const result = evaluateTransport(current, transportProfile({
    hard: [{
      feature: 'travel_time',
      type: 'hard',
      importance: 'high',
      priority: 'high',
      rule: { maxTransitMinutes: 30 },
    }],
  }));

  assert.equal(result.accepted, false);
  assert.equal(result.failures[0].reason, 'accessibility_missing');
  assert.equal(result.failures[0].factStatus, 'unknown');
});

test('route unavailable is distinct from exceeding the transport limit', () => {
  const current = withAccessibility(candidate('route-unavailable'), accessibility({
    transitMinutes: null,
    transitReason: 'route_not_found',
  }));
  const result = evaluateTransport(current, transportProfile({
    hard: [{
      feature: 'travel_time',
      type: 'hard',
      importance: 'high',
      priority: 'high',
      rule: { maxTransitMinutes: 30 },
    }],
  }));

  assert.equal(result.accepted, false);
  assert.equal(result.failures[0].reason, 'route_not_found');
  assert.equal(result.failures[0].factStatus, 'unavailable');
});

test('origin missing and provider error accessibility are distinct factual failures', () => {
  for (const reason of ['origin_missing', 'provider_error']) {
    const current = withAccessibility(candidate(reason), accessibility({
      transitMinutes: null,
      transitReason: reason,
    }));
    const result = evaluateTransport(current, transportProfile({
      hard: [{
        feature: 'travel_time',
        type: 'hard',
        importance: 'high',
        priority: 'high',
        rule: { maxTransitMinutes: 30 },
      }],
    }));

    assert.equal(result.accepted, false);
    assert.equal(result.failures[0].reason, reason);
    assert.notEqual(result.failures[0].reason, 'transport_time_exceeds_limit');
  }
});

test('soft maxTransitMinutes does not hard reject candidates over the preferred limit', () => {
  const current = attachCalendar([
    withAccessibility(candidate('soft-far'), accessibility({ transitMinutes: 35 })),
  ], [])[0];
  const preferenceProfile = transportProfile({
    soft: [{
      feature: 'travel_time',
      type: 'soft',
      importance: 'high',
      priority: 'high',
      rule: { maxTransitMinutes: 30 },
      relaxable: true,
    }],
    transportPreference: { maxTransitMinutes: 30 },
  });
  const hardResult = applyHardConstraints({ candidates: [current], preferenceProfile });
  const evaluation = evaluateCandidateSet({
    candidates: hardResult.accepted,
    preferenceProfile,
    preferences: preferenceProfile,
  });

  assert.equal(hardResult.accepted.length, 1);
  assert.equal(evaluation.satisfactory, true);
  assert.equal(evaluation.softViolations[0].feature, 'travel_time');
  assert.equal(evaluation.softViolations[0].relaxable, true);
  assert.equal(evaluation.softViolations[0].severity, 'mild');
});

test('maxWalkMinutes uses candidate accessibility walk facts', () => {
  const current = withAccessibility(candidate('walkable'), accessibility({ walkMinutes: 14 }));
  const preferenceProfile = transportProfile({
    soft: [{
      feature: 'travel_time',
      type: 'soft',
      importance: 'high',
      priority: 'high',
      rule: { maxWalkMinutes: 15 },
      relaxable: true,
    }],
    transportPreference: { maxWalkMinutes: 15 },
  });
  const evaluation = evaluateCandidateSet({
    candidates: [current],
    preferences: preferenceProfile,
  });

  assert.equal(evaluation.satisfactory, true);
});

test('preferred transport mode ranking signal does not forbid unlisted modes', () => {
  const transitCandidate = withAccessibility(candidate('transit'), accessibility({ transitMinutes: 24, walkMinutes: 50 }));
  const driveCandidate = withAccessibility(candidate('drive'), accessibility({ transitMinutes: null, transitReason: 'route_not_found', driveMinutes: 12 }));
  const preferenceProfile = transportProfile({
    soft: [{
      feature: 'travel_time',
      type: 'soft',
      importance: 'medium',
      priority: 'medium',
      rule: { preferredTransportModes: ['TRANSIT'] },
      relaxable: true,
    }],
    transportPreference: { preferredTransportModes: ['TRANSIT'] },
  });
  const evaluation = evaluateCandidateSet({
    candidates: [transitCandidate, driveCandidate],
    preferences: preferenceProfile,
  });

  assert.equal(candidatePreferredTransportModes(transitCandidate, preferenceProfile.transportPreference).matches, true);
  assert.equal(candidatePreferredTransportModes(driveCandidate, preferenceProfile.transportPreference).matches, false);
  assert.equal(evaluation.satisfactory, true);
  assert.equal(evaluation.weakPreferences.length, 0);
});

test('calendar free candidate is accepted when no other hard constraint fails', () => {
  const [current] = attachCalendar([candidate('free')], [
    { start: '2026-09-03T08:00:00.000Z', end: '2026-09-03T09:00:00.000Z' },
  ]);

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile(),
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
});

test('hard start_time constraint rejects before ranking', () => {
  const preferenceProfile = normalizePreferenceProfile({
    version: 2,
    preferences: [{ feature: 'price', type: 'soft', importance: 'medium', direction: 'lower' }],
    hardConstraints: [{
      feature: 'start_time',
      type: 'hard',
      importance: 'high',
      priority: 'high',
      rule: { after: '17:00' },
      sourceText: '17点以前绝对不行',
    }],
    objectives: [],
    unresolvedPreferences: [],
    sourceText: '17点以前绝对不行，便宜一点',
    updatedAt: '2026-09-03T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-03T00:00:00.000Z',
  });
  const cheapInvalid = candidate('cheap-invalid');
  const valid = candidate('valid');
  const result = applyHardConstraints({
    candidates: [
      {
        ...cheapInvalid,
        features: { ...cheapInvalid.features, localTime: '16:00', price: 10 },
      },
      {
        ...valid,
        features: { ...valid.features, localTime: '18:00', price: 35 },
      },
    ],
    preferenceProfile,
    defaultCalendarBusyIsHard: false,
  });

  assert.deepEqual(result.accepted.map((item) => item.id), ['valid']);
  assert.equal(result.rejected[0].candidate.id, 'cheap-invalid');
  assert.equal(result.rejected[0].reasons[0].feature, 'start_time');
});

test('weather hard constraint rejects precipitation', () => {
  const current = attachCalendar([
    withWeather(candidate('rain'), {
      forecastAvailable: true,
      precipitationMm: 1.2,
      precipitationProbability: 90,
    }),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile({ weatherType: 'hard' }),
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reasons[0].reason, 'weather_precipitation');
});

test('weather soft preference does not reject candidates in hard filtering', () => {
  const current = attachCalendar([
    withWeather(candidate('rain'), {
      forecastAvailable: true,
      precipitationMm: 1.2,
      precipitationProbability: 90,
    }),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile({ weatherType: 'soft' }),
  });

  assert.equal(result.accepted.length, 1);
});

test('unknown calendar is not treated as free', () => {
  const result = applyHardConstraints({
    candidates: [candidate('unknown-calendar')],
    preferenceProfile: profile(),
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reasons[0].reason, 'calendar_unknown');
});

test('unknown weather is not treated as good for hard weather constraints', () => {
  const current = attachCalendar([
    withWeather(candidate('unknown-weather'), {
      forecastAvailable: false,
      precipitationMm: null,
    }),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile({ weatherType: 'hard' }),
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reasons[0].reason, 'weather_unknown');
});

test('enriched candidate schema includes weather and calendar facts', async () => {
  const [enriched] = await enrichCandidates({
    candidates: [candidate('schema')],
    weatherAdapter: async ({ slots }) => slots.map((slot) => ({
      candidateId: slot.id,
      startTime: slot.startTime,
      temperatureC: 21,
      feelsLikeC: 21,
      precipitationProbability: 0,
      precipitationMm: 0,
      windKph: 12,
      weatherCode: '0',
      source: 'test-weather',
      forecastAvailable: true,
    })),
    calendarAdapter: async () => ({ busy: [] }),
  });

  assert.equal(enriched.features.weather.temperatureC, 21);
  assert.equal(enriched.features.calendar.free, true);
});

test('hard filtering returns explainable rejection reasons', () => {
  const result = applyHardConstraints({
    candidates: [candidate('unknown-calendar')],
    preferenceProfile: profile(),
  });

  assert.deepEqual(result.rejected[0].reasons, [
    { feature: 'calendar', reason: 'calendar_unknown' },
  ]);
});

test('filtered output is compatible with Agent State and evaluator', () => {
  const result = applyHardConstraints({
    candidates: [candidate('unknown-calendar')],
    preferenceProfile: profile(),
  });
  const state = createInitialAgentState({
    goal: 'find next tennis session',
    preferences: profile(),
    searchScope: { days: 7 },
    candidates: result.accepted,
    rejectedCandidates: result.rejected,
    failedConstraints: [],
    actionsTaken: [],
    iteration: 0,
    status: 'READY',
  });
  const evaluation = evaluateCandidateSet({
    candidates: state.candidates,
    rejectedCandidates: state.rejectedCandidates,
    preferences: state.preferences,
  });

  assert.equal(state.rejectedCandidates.length, 1);
  assert.equal(evaluation.satisfactory, false);
  assert.equal(evaluation.failedConstraints[0].reason, 'calendar_unknown');
});
