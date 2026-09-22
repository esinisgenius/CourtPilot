import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHardConstraints,
  candidatePreferredTransportModes,
  enrichCandidates,
  evaluateTransport,
} from '../packages/core/src/index.mjs';
import {
  createInitialAgentState,
  evaluateCandidateSet,
} from '../packages/agent/src/index.mjs';
import { normalizePreferenceProfile } from '../packages/preferences/src/index.mjs';

function candidateBatch(candidates) {
  return candidates;
}

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

function rainyWeather(overrides = {}) {
  return {
    forecastAvailable: true,
    condition: 'rain',
    precipitationProbability: 72,
    precipitationMm: 1.2,
    weatherCode: '61',
    ...overrides,
  };
}

function dryWeather(overrides = {}) {
  return {
    forecastAvailable: true,
    condition: 'clear',
    precipitationProbability: 10,
    precipitationMm: 0,
    weatherCode: '0',
    ...overrides,
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

test('hard maxTransitMinutes rejects only known transit limit violations', () => {
  const current = candidateBatch([
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
  const current = candidateBatch([candidate('missing-accessibility')], [])[0];
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
  const current = candidateBatch([
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

test('past availability is rejected before ranking for every provider', () => {
  const [past, future] = candidateBatch([
    candidate('past', '2026-09-14T10:00:00+10:00'),
    candidate('future', '2026-09-14T20:00:00+10:00'),
  ], []);

  const result = applyHardConstraints({
    candidates: [past, future],
    preferenceProfile: profile(),
    now: new Date('2026-09-14T18:53:00+10:00'),
  });

  assert.deepEqual(result.accepted.map((entry) => entry.id), ['future']);
  assert.equal(result.rejected[0].candidate.id, 'past');
  assert.equal(result.rejected[0].reasons[0].reason, 'availability_start_in_past');
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
  });

  assert.deepEqual(result.accepted.map((item) => item.id), ['valid']);
  assert.equal(result.rejected[0].candidate.id, 'cheap-invalid');
  assert.equal(result.rejected[0].reasons[0].feature, 'start_time');
});

test('weather hard constraint rejects precipitation', () => {
  const current = candidateBatch([
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

test('weather hard no_rain rule rejects rain-like condition even without measured precipitation', () => {
  const current = candidateBatch([
    withWeather(candidate('rain-condition'), rainyWeather({
      precipitationMm: 0,
      precipitationProbability: 10,
    })),
  ], [])[0];
  const preferenceProfile = normalizePreferenceProfile({
    version: 2,
    searchWindowDays: 7,
    preferences: [],
    hardConstraints: [{
      feature: 'weather',
      type: 'hard',
      importance: 'high',
      priority: 'high',
      rule: { condition: 'no_rain' },
      sourceText: '别下雨就行',
    }],
    objectives: [],
    unresolvedPreferences: [],
    sourceText: '别下雨就行',
    updatedAt: '2026-09-03T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-03T00:00:00.000Z',
  });

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile,
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reasons[0].reason, 'weather_bad_condition');
});

test('default weather policy keeps rainy outdoor candidates with warning', () => {
  const current = candidateBatch([
    withWeather(candidate('rain-flexible'), rainyWeather()),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile(),
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].features.weatherWarning.active, true);
  assert.equal(result.accepted[0].features.weatherWarning.precipitationProbability, 72);
});

test('default weather policy keeps dry outdoor candidates', () => {
  const current = candidateBatch([
    withWeather(candidate('dry'), dryWeather()),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile(),
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
});

test('user says rain is okay so rainy candidate is not weather-filtered', () => {
  const current = candidateBatch([
    withWeather(candidate('rain-ok'), rainyWeather()),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: normalizePreferenceProfile({
      version: 2,
      searchWindowDays: 7,
      preferences: [],
      hardConstraints: [],
      objectives: [],
      unresolvedPreferences: [],
      sourceText: '小雨没关系',
      updatedAt: '2026-09-03T00:00:00.000Z',
    }, {
      updatedAt: '2026-09-03T00:00:00.000Z',
    }),
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].features.weatherWarning.active, true);
});

test('explicit user time keeps rainy candidate and attaches weather warning', () => {
  const current = candidateBatch([
    withWeather(candidate('rain-explicit-time'), rainyWeather()),
  ], [])[0];
  const preferenceProfile = normalizePreferenceProfile({
    version: 2,
    searchWindowDays: 1,
    searchScope: {
      days: 1,
      timeWindow: { after: '17:00' },
      sourceText: '明天下午5点帮我找场',
      source: 'user',
      isExplicit: true,
    },
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
    sourceText: '明天下午5点帮我找场',
    updatedAt: '2026-09-03T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-03T00:00:00.000Z',
  });

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile,
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].features.weatherWarning.active, true);
  assert.equal(result.accepted[0].features.weatherWarning.badWeather, true);
  assert.equal(result.accepted[0].features.weatherWarning.condition, 'rain');
  assert.equal(result.accepted[0].features.weatherWarning.precipitationProbability, 72);
});

test('replanner-expanded time keeps rainy candidate with warning', () => {
  const current = candidateBatch([
    withWeather(candidate('rain-replanner-time'), rainyWeather()),
  ], [])[0];
  const preferenceProfile = normalizePreferenceProfile({
    version: 2,
    searchWindowDays: 7,
    preferences: [],
    hardConstraints: [{
      feature: 'start_time',
      type: 'hard',
      importance: 'medium',
      priority: 'medium',
      rule: { after: '17:00' },
      sourceText: 'agent shifted time window',
      source: 'replanner',
      isExplicit: false,
    }],
    objectives: [],
    unresolvedPreferences: [],
    sourceText: 'synthetic',
    updatedAt: '2026-09-03T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-03T00:00:00.000Z',
  });

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile,
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].features.weatherWarning.active, true);
});

test('precipitation probability at 50 percent is bad weather boundary', () => {
  const current = candidateBatch([
    withWeather(candidate('rain-boundary'), rainyWeather({
      condition: 'cloudy',
      precipitationMm: 0,
      precipitationProbability: 50,
      weatherCode: '3',
    })),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile(),
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].features.weatherWarning.precipitationProbability, 50);
});

test('missing weather data is not treated as bad weather by default policy', () => {
  const current = candidateBatch([
    withWeather(candidate('weather-missing'), {
      forecastAvailable: false,
      precipitationProbability: null,
      precipitationMm: null,
      condition: null,
      weatherCode: null,
    }),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile(),
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].features.weatherUnknown, true);
});

test('unknown weather is not treated as good for hard weather constraints', () => {
  const current = candidateBatch([
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

test('enriched candidate schema includes weather facts', async () => {
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
  });

  assert.equal(enriched.features.weather.temperatureC, 21);
});

test('Strathfield weather unavailable falls back to nearby Burwood weather', async () => {
  const current = {
    ...candidate('strathfield-weather'),
    venue: 'Strathfield Sports Club Tennis',
    features: {
      ...candidate('strathfield-weather').features,
      venue: {
        id: 'unified-strathfield-sports-club-tennis',
        name: 'Strathfield Sports Club Tennis',
        suburb: 'Strathfield',
        location: { lat: -33.8791, lng: 151.0836 },
      },
    },
    source: {
      canonicalAvailability: {
        venue: {
          id: 'unified-strathfield-sports-club-tennis',
          name: 'Strathfield Sports Club Tennis',
          suburb: 'Strathfield',
          location: { lat: -33.8791, lng: 151.0836 },
        },
      },
    },
  };

  const attempted = [];
  const [enriched] = await enrichCandidates({
    candidates: [current],
    weatherAdapter: async ({ location, slots }) => {
      attempted.push(location.label);
      return slots.map((slot) => ({
        candidateId: slot.id,
        startTime: slot.startTime,
        forecastAvailable: location.label === 'Burwood',
        temperatureC: location.label === 'Burwood' ? 22 : null,
        feelsLikeC: location.label === 'Burwood' ? 22 : null,
        precipitationProbability: location.label === 'Burwood' ? 10 : null,
        precipitationMm: location.label === 'Burwood' ? 0 : null,
        windKph: location.label === 'Burwood' ? 8 : null,
        weatherCode: location.label === 'Burwood' ? '0' : null,
        source: 'test-weather',
        unavailableReason: location.label === 'Burwood' ? undefined : 'forecast_hour_unavailable',
      }));
    },
  });

  assert.deepEqual(attempted, ['Strathfield Sports Club Tennis', 'Strathfield', 'Burwood']);
  assert.equal(enriched.features.weather.forecastAvailable, true);
  assert.equal(enriched.features.weather.weatherSource, 'Burwood');
  assert.equal(enriched.features.weather.fallbackLevel, 'nearby');
  assert.equal(enriched.features.weather.confidence, 'medium_low');
});

test('nearby weather unavailable falls back to Sydney weather', async () => {
  const current = {
    ...candidate('strathfield-sydney-weather'),
    venue: 'Strathfield Sports Club Tennis',
    features: {
      ...candidate('strathfield-sydney-weather').features,
      venue: {
        id: 'unified-strathfield-sports-club-tennis',
        name: 'Strathfield Sports Club Tennis',
        suburb: 'Strathfield',
      },
    },
    source: {
      canonicalAvailability: {
        venue: {
          id: 'unified-strathfield-sports-club-tennis',
          name: 'Strathfield Sports Club Tennis',
          suburb: 'Strathfield',
        },
      },
    },
  };

  const attempted = [];
  const [enriched] = await enrichCandidates({
    candidates: [current],
    weatherAdapter: async ({ location, slots }) => {
      attempted.push(location.label);
      return slots.map((slot) => ({
        candidateId: slot.id,
        startTime: slot.startTime,
        forecastAvailable: location.label === 'Sydney',
        temperatureC: location.label === 'Sydney' ? 23 : null,
        feelsLikeC: location.label === 'Sydney' ? 23 : null,
        precipitationProbability: location.label === 'Sydney' ? 20 : null,
        precipitationMm: location.label === 'Sydney' ? 0 : null,
        windKph: location.label === 'Sydney' ? 12 : null,
        weatherCode: location.label === 'Sydney' ? '1' : null,
        source: 'test-weather',
        unavailableReason: location.label === 'Sydney' ? undefined : 'forecast_hour_unavailable',
      }));
    },
  });

  assert.deepEqual(attempted, ['Strathfield', 'Burwood', 'Sydney CBD', 'Sydney']);
  assert.equal(enriched.features.weather.forecastAvailable, true);
  assert.equal(enriched.features.weather.weatherSource, 'Sydney');
  assert.equal(enriched.features.weather.fallbackLevel, 'sydney');
  assert.equal(enriched.features.weather.confidence, 'low');
});

test('provider-level weather failure does not retry every fallback location', async () => {
  let calls = 0;
  const base = candidate('provider-weather-failure');
  const [enriched] = await enrichCandidates({
    candidates: [{
      ...base,
      features: {
        ...base.features,
        venue: {
          id: 'test-burwood',
          name: 'Test Burwood',
          suburb: 'Burwood',
          location: { lat: -33.8775, lng: 151.1035 },
        },
      },
    }],
    weatherAdapter: async ({ slots }) => {
      calls += 1;
      return slots.map((slot) => ({
        candidateId: slot.id,
        startTime: slot.startTime,
        forecastAvailable: false,
        unavailableReason: 'WEATHER_PROVIDER_HTTP_ERROR',
        httpStatus: 429,
      }));
    },
  });

  assert.equal(calls, 1);
  assert.equal(enriched.features.weather.httpStatus, 429);
});

test('soft weather preference keeps candidate when all weather sources are unavailable', () => {
  const current = candidateBatch([
    withWeather(candidate('soft-weather-unavailable'), {
      forecastAvailable: false,
      precipitationProbability: null,
      precipitationMm: null,
      condition: null,
      weatherCode: null,
      fallbackLevel: 'sydney',
      confidence: 'low',
      unavailableReason: 'all_weather_sources_unavailable',
    }),
  ], [])[0];

  const result = applyHardConstraints({
    candidates: [current],
    preferenceProfile: profile({ weatherType: 'soft' }),
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].features.weatherUnknown, true);
});

test('filtered output is compatible with Agent State and evaluator', () => {
  const result = applyHardConstraints({
    candidates: [candidate('fixture-candidate')],
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

  assert.equal(state.rejectedCandidates.length, 0);
  assert.equal(state.candidates.length, 1);
  assert.equal(evaluation.failedConstraints.length, 0);
});
