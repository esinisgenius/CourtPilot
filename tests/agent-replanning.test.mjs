import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPLANNING_ACTIONS,
  ReplannerError,
  ReplanningActionSchemaError,
  chooseReplanningAction,
  createInitialAgentState,
  evaluateCandidateSet,
  evaluateReplanningContext,
  runReplanningLoop,
  observeConfiguredAvailabilityProviders,
  validateBoundedRealReplanningAction,
  validateReplanningAction,
} from '../packages/agent/src/index.mjs';
import {
  interpretPreferences,
  normalizePreferenceProfile,
  validatePreferenceProfile,
} from '../packages/preferences/src/index.mjs';
import {
  applyHardConstraints,
} from '../packages/core/src/index.mjs';
import {
  USYD,
  mapsVenue,
  savedAreasDocument,
  verifiedSlotCandidate,
} from './fixtures/replanner-maps-scenarios.mjs';

async function tempJsonFile(value) {
  const dir = await mkdtemp(join(tmpdir(), 'tennis-replanner-test-'));
  const filePath = join(dir, 'saved-play-areas.json');
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function mockPreferenceProvider(profile) {
  return {
    async interpret() {
      return profile;
    },
  };
}

function profile(preferences = [], hardConstraints = []) {
  return normalizePreferenceProfile({
    version: 1,
    searchWindowDays: 7,
    preferences,
    hardConstraints,
    unresolvedPreferences: [],
    sourceText: 'synthetic preference text',
    updatedAt: '2026-09-03T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-03T00:00:00.000Z',
  });
}

function candidate({
  id = 'candidate-1',
  court = 'Court 4',
  localTime = '18:00',
  nextHourFree = true,
  price = 29,
} = {}) {
  return {
    id,
    venue: 'SUSF',
    court,
    startTime: '2026-09-03T08:00:00.000Z',
    durationMinutes: 60,
    features: {
      localDate: '2026-09-03',
      localTime,
      nextHourFree,
      price,
    },
  };
}

function accessibleCandidate({
  id = 'accessible-candidate',
  transitMinutes = 35,
  walkMinutes = 20,
  driveMinutes = 12,
} = {}) {
  const base = candidate({ id });
  const accessibility = {
    origin: { placeId: 'origin', label: 'USYD' },
    walk: { durationMinutes: walkMinutes, distanceMeters: walkMinutes * 100, unavailableReason: null },
    transit: {
      durationMinutes: transitMinutes,
      distanceMeters: transitMinutes * 100,
      departureTime: '2026-09-05T07:15:00.000Z',
      unavailableReason: null,
    },
    drive: { durationMinutes: driveMinutes, distanceMeters: driveMinutes * 100, unavailableReason: null },
    source: 'google_routes',
    observedAt: '2026-09-05T00:00:00.000Z',
  };
  return {
    ...base,
    accessibility,
    features: {
      ...base.features,
      accessibility,
    },
  };
}

function state(overrides = {}) {
  const preferences = overrides.preferences ?? profile([
    {
      feature: 'next_hour_free',
      type: 'soft',
      target: true,
      priority: 'high',
      importance: 'high',
      relaxable: true,
      sourceText: 'best if following hour is free',
    },
  ]);

  return createInitialAgentState({
    goal: 'find next tennis session',
    preferences,
    searchScope: { days: 7, radiusMeters: 3000 },
    candidates: [candidate()],
    rejectedCandidates: [],
    failedConstraints: [],
    factualObservations: {},
    actionsTaken: [],
    iteration: 0,
    status: 'READY',
    ...overrides,
  });
}

function availabilitySlot({
  provider = 'SUSF',
  venue = 'SUSF',
  court = 'Court 4',
  startTime = '2026-09-04T18:00:00',
  durationMinutes = 120,
} = {}) {
  return {
    venue,
    provider,
    court,
    startTime,
    durationMinutes,
    nextHourAlsoAvailable: true,
    priceOptions: [],
    provenance: {
      status: 'verified',
      source: provider === 'bookable' ? 'bookable' : 'susf_perfectmind',
      access: 'public',
      freshness: 'live',
    },
  };
}

test('hard constraint is normalized as non-relaxable and cannot validate as relaxable', () => {
  const normalized = profile([], [
    {
      feature: 'calendar',
      type: 'hard',
      priority: 'high',
      importance: 'high',
      relaxable: true,
      sourceText: 'must not conflict with calendar',
    },
  ]);

  assert.equal(normalized.hardConstraints[0].relaxable, false);

  assert.throws(
    () => validatePreferenceProfile({
      ...normalized,
      hardConstraints: [{ ...normalized.hardConstraints[0], relaxable: true }],
    }),
    /Invalid Preference Profile/,
  );
});

test('no candidates requires replanning', async () => {
  const currentState = state({ candidates: [] });
  const evaluation = evaluateCandidateSet({
    candidates: currentState.candidates,
    preferences: currentState.preferences,
  });
  const action = await chooseReplanningAction(currentState, { evaluation });

  assert.equal(evaluation.satisfactory, false);
  assert.equal(evaluation.reasons.includes('candidate_count_below_minimum'), true);
  assert.equal(action.selectedAction, REPLANNING_ACTIONS.EXPAND_RADIUS);
});

test('no candidates in configured provider scope expands venue set before radius', async () => {
  const currentState = state({
    candidates: [],
    searchScope: {
      providerScope: {
        activeProviderIds: ['susf'],
        expandableProviderIds: ['bookable'],
      },
    },
  });
  const evaluation = evaluateCandidateSet({
    candidates: currentState.candidates,
    preferences: currentState.preferences,
  });
  const action = await chooseReplanningAction(currentState, { evaluation });

  assert.equal(action.selectedAction, REPLANNING_ACTIONS.EXPAND_VENUE_SET);
});

test('only low quality candidates require replanning', async () => {
  const currentState = state({
    candidates: [candidate({ id: 'weak', nextHourFree: false })],
  });
  const evaluation = evaluateCandidateSet({
    candidates: currentState.candidates,
    preferences: currentState.preferences,
  });
  const action = await chooseReplanningAction(currentState, { evaluation });

  assert.equal(evaluation.satisfactory, false);
  assert.deepEqual(evaluation.reasons, ['high_priority_preferences_weak']);
  assert.equal(evaluation.weakPreferences[0].feature, 'next_hour_free');
  assert.equal(action.selectedAction, REPLANNING_ACTIONS.ASK_USER);
});

test('high quality candidates are satisfactory and stop replanning', async () => {
  const currentState = state();
  const evaluation = evaluateCandidateSet({
    candidates: currentState.candidates,
    preferences: currentState.preferences,
  });
  const action = await chooseReplanningAction(currentState, { evaluation });

  assert.equal(evaluation.satisfactory, true);
  assert.deepEqual(evaluation.reasons, []);
  assert.equal(action.selectedAction, REPLANNING_ACTIONS.SATISFACTORY);
});

test('action enum validation accepts only known actions', () => {
  const action = validateReplanningAction({
    selectedAction: REPLANNING_ACTIONS.EXPAND_RADIUS,
    targetPreference: null,
    rationale: 'Try a wider geographic scope.',
    expectedEffect: 'More candidate venues may be discovered.',
  });

  assert.equal(action.selectedAction, 'EXPAND_RADIUS');
});

test('max iteration stops replanning to avoid infinite loops', async () => {
  const action = await chooseReplanningAction(state({
    candidates: [],
    iteration: 3,
  }), {
    maxIterations: 3,
  });

  assert.equal(action.selectedAction, REPLANNING_ACTIONS.STOP);
  assert.match(action.rationale, /Maximum replanning iterations/);
});

test('unknown provider action is rejected', async () => {
  await assert.rejects(
    () => chooseReplanningAction(state({ candidates: [] }), {
      provider: {
        async choose() {
          return {
            selectedAction: 'MAKE_UP_A_NEW_ACTION',
            targetPreference: null,
            rationale: 'Invalid free-form action.',
            expectedEffect: 'Should be rejected.',
          };
        },
      },
    }),
    (error) => error instanceof ReplanningActionSchemaError,
  );
});

test('bounded Real LLM Replanner rejects older non-Maps search actions', () => {
  assert.throws(
    () => validateBoundedRealReplanningAction({
      selectedAction: REPLANNING_ACTIONS.EXPAND_DATE_WINDOW,
      targetPreference: null,
      rationale: 'Search more days.',
      expectedEffect: 'More slots may appear.',
    }),
    (error) => error instanceof ReplannerError,
  );
});

test('bounded Real LLM Replanner accepts configured provider expansion action', () => {
  const action = validateBoundedRealReplanningAction({
    selectedAction: REPLANNING_ACTIONS.EXPAND_VENUE_SET,
    targetPreference: null,
    rationale: 'Add the next configured provider source.',
    expectedEffect: 'Bookable venues can be observed without preloading all providers.',
  });

  assert.equal(action.selectedAction, REPLANNING_ACTIONS.EXPAND_VENUE_SET);
});

test('factual observations with only unknown Maps venue availability are insufficient', () => {
  const currentState = state({
    candidates: [],
    factualObservations: {
      maps: {
        providerVerification: 'EXTERNAL_BLOCKER_NOT_VERIFIED',
        venues: [mapsVenue({ id: 'unknown-local', name: 'Local Tennis Club' })],
      },
    },
  });

  const evaluation = evaluateReplanningContext(currentState);
  assert.equal(evaluation.satisfactory, false);
  assert.equal(evaluation.reasons.includes('factual_observations_insufficient'), true);
  assert.equal(evaluation.observationIssues[0].code, 'maps_venue_availability_not_verified');
});

test('synthetic Maps replanning expands radius switches area then reaches satisfactory', async () => {
  const savedAreasPath = await tempJsonFile(savedAreasDocument);
  const preferences = profile([
    {
      feature: 'travel_time',
      type: 'soft',
      rule: { maxMinutes: 20 },
      priority: 'high',
      importance: 'high',
      relaxable: true,
      sourceText: 'within 20 minutes transit',
    },
  ]);
  const initialState = state({
    preferences,
    searchScope: {
      location: { label: 'USYD', ...USYD, source: 'saved_area' },
      activeAreaId: 'usyd',
      radiusMeters: 3000,
      travelMode: 'TRANSIT',
      travelModeSource: 'product_default',
    },
    candidates: [],
    factualObservations: {},
  });
  const proposedActions = [];

  const provider = {
    async choose({ state: currentState, evaluation }) {
      if (currentState.iteration === 0) {
        assert.deepEqual(evaluation.reasons, [
          'candidate_count_below_minimum',
          'factual_observations_insufficient',
          'high_priority_preferences_weak',
        ]);
        proposedActions.push(REPLANNING_ACTIONS.EXPAND_RADIUS);
        return {
          selectedAction: REPLANNING_ACTIONS.EXPAND_RADIUS,
          targetPreference: 'travel_time',
          rationale: 'Nearby observations have no verified availability, so broaden the venue radius.',
          expectedEffect: 'More venue observations may appear without treating unknown availability as bookable.',
        };
      }

      if (currentState.iteration === 1) {
        proposedActions.push(REPLANNING_ACTIONS.SWITCH_SEARCH_AREA);
        return {
          selectedAction: REPLANNING_ACTIONS.SWITCH_SEARCH_AREA,
          targetPreference: 'travel_time',
          parameters: { targetAreaId: 'home' },
          rationale: 'Expanded USYD radius still only produced unknown availability, so try another saved area.',
          expectedEffect: 'Search the saved home area while preserving factual availability checks.',
        };
      }

      proposedActions.push(REPLANNING_ACTIONS.SATISFACTORY);
      return {
        selectedAction: REPLANNING_ACTIONS.SATISFACTORY,
        targetPreference: null,
        rationale: 'A verified slot satisfies the current travel-time preference.',
        expectedEffect: 'Stop replanning and return the candidate set.',
      };
    },
  };

  const observedRadii = [];
  const result = await runReplanningLoop(initialState, {
    provider,
    savedAreasPath,
    observe: async (currentState) => {
      observedRadii.push(currentState.searchScope.radiusMeters);
      if (currentState.searchScope.activeAreaId === 'home') {
        const venue = mapsVenue({
          id: 'susf-home',
          name: 'Sydney Uni Sport Tennis Courts',
          availabilityStatus: 'verified',
          travelTimeMinutes: 14,
        });
        return {
          candidates: [verifiedSlotCandidate({ venue })],
          factualObservations: {
            maps: {
              providerVerification: 'SYNTHETIC_ONLY',
              venues: [venue],
            },
          },
        };
      }

      return {
        candidates: [],
        factualObservations: {
          maps: {
            providerVerification: 'EXTERNAL_BLOCKER_NOT_VERIFIED',
            venues: [mapsVenue({
              id: `unknown-${currentState.searchScope.radiusMeters}`,
              name: 'Synthetic Unknown Tennis Venue',
              availabilityStatus: 'unknown',
              travelTimeMinutes: 11,
            })],
          },
        },
      };
    },
  });

  assert.equal(result.status, 'SATISFACTORY');
  assert.deepEqual(proposedActions, [
    REPLANNING_ACTIONS.EXPAND_RADIUS,
    REPLANNING_ACTIONS.SWITCH_SEARCH_AREA,
    REPLANNING_ACTIONS.SATISFACTORY,
  ]);
  assert.deepEqual(result.iterations.map((iteration) => iteration.candidateCount), [0, 0, 1]);
  assert.deepEqual(observedRadii, [3000, 5000, 3000]);
  assert.equal(result.state.searchScope.activeAreaId, 'home');
  assert.equal(result.state.candidates[0].features.venue.availability.status, 'verified');
});

test('Agent expands from preferred SUSF scope to Bookable only after replanning action', async () => {
  const initialState = state({
    candidates: [],
    searchScope: {
      courtScope: { includeNonPreferred: false },
      providerScope: {
        activeProviderIds: ['susf'],
        expandableProviderIds: ['bookable'],
      },
    },
  });
  const fetchCalls = [];
  const provider = {
    async choose({ state: currentState }) {
      if (currentState.iteration === 0) {
        return {
          selectedAction: REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS,
          targetPreference: 'court',
          rationale: 'Preferred SUSF courts did not produce a satisfactory candidate.',
          expectedEffect: 'Observe the wider configured SUSF court scope before adding another provider.',
        };
      }
      if (currentState.iteration === 1) {
        return {
          selectedAction: REPLANNING_ACTIONS.EXPAND_VENUE_SET,
          targetPreference: 'court',
          rationale: 'All SUSF courts are still unsatisfactory, so add the next configured provider.',
          expectedEffect: 'Observe configured Bookable venues and merge normalized candidates.',
        };
      }
      return {
        selectedAction: REPLANNING_ACTIONS.SATISFACTORY,
        targetPreference: null,
        rationale: 'Bookable produced a verified two-hour candidate.',
        expectedEffect: 'Stop bounded replanning.',
      };
    },
  };

  const result = await runReplanningLoop(initialState, {
    provider,
    observe: (currentState) => observeConfiguredAvailabilityProviders(currentState, {
      providerFetchers: {
        async susf() {
          fetchCalls.push('susf');
          return [];
        },
        async bookable() {
          fetchCalls.push('bookable');
          return [availabilitySlot({
            provider: 'bookable',
            venue: 'Hamilton Park tennis courts',
            court: 'Acrylic hard court 1',
          })];
        },
      },
    }),
    maxIterations: 4,
  });

  assert.equal(result.status, 'SATISFACTORY');
  assert.deepEqual(fetchCalls, ['susf', 'bookable']);
  assert.deepEqual(result.iterations.map((iteration) => iteration.action.selectedAction), [
    REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS,
    REPLANNING_ACTIONS.EXPAND_VENUE_SET,
    REPLANNING_ACTIONS.SATISFACTORY,
  ]);
  assert.equal(result.state.searchScope.courtScope.includeNonPreferred, true);
  assert.equal(result.state.searchScope.providerScope.scopeStatus, 'expanded');
  assert.equal(result.state.candidates[0].source.provider, 'bookable');
});

test('Agent does not query Bookable when SUSF is already satisfactory', async () => {
  const fetchCalls = [];
  const initialState = state({
    candidates: [],
    searchScope: {
      providerScope: {
        activeProviderIds: ['susf'],
        expandableProviderIds: ['bookable'],
      },
    },
  });

  const result = await runReplanningLoop(initialState, {
    observe: (currentState) => observeConfiguredAvailabilityProviders(currentState, {
      providerFetchers: {
        async susf() {
          fetchCalls.push('susf');
          return [availabilitySlot()];
        },
        async bookable() {
          fetchCalls.push('bookable');
          return [availabilitySlot({ provider: 'bookable', venue: 'Aloha Street Tennis Courts' })];
        },
      },
    }),
  });

  assert.equal(result.status, 'SATISFACTORY');
  assert.deepEqual(fetchCalls, ['susf']);
  assert.equal(result.state.candidates[0].source.provider, 'SUSF');
});

test('Bookable acquisition failure is recorded instead of converted to zero availability', async () => {
  const initialState = state({
    candidates: [],
    searchScope: {
      providerScope: {
        activeProviderIds: ['bookable'],
        expandableProviderIds: ['bookable'],
      },
    },
  });

  const observed = await observeConfiguredAvailabilityProviders(initialState, {
    providerFetchers: {
      async bookable() {
        const error = new Error('fixture endpoint changed');
        error.code = 'BOOKABLE_PROVIDER_ERROR';
        throw error;
      },
    },
  });

  assert.deepEqual(observed.candidates, []);
  assert.equal(observed.factualObservations.availability.providers[0].status, 'failed');
  assert.equal(observed.factualObservations.availability.acquisitionFailures[0].code, 'BOOKABLE_PROVIDER_ERROR');
  assert.deepEqual(observed.searchScope.providerScope.failedProviderIds, ['bookable']);
});

test('duplicate provider expansion is rejected deterministically', async () => {
  const currentState = state({
    candidates: [],
    searchScope: {
      providerScope: {
        activeProviderIds: ['susf', 'bookable'],
        expandableProviderIds: ['bookable'],
        observedProviderIds: ['susf', 'bookable'],
      },
    },
  });

  await assert.rejects(
    () => runReplanningLoop(currentState, {
      provider: {
        async choose() {
          return {
            selectedAction: REPLANNING_ACTIONS.EXPAND_VENUE_SET,
            targetPreference: null,
            rationale: 'Try Bookable again.',
            expectedEffect: 'Should be rejected because expansion is exhausted.',
          };
        },
      },
      maxIterations: 4,
    }),
    /No configured provider expansion remains/,
  );
});

test('both providers exhausted reaches bounded terminal behavior', async () => {
  const currentState = state({
    candidates: [],
    iteration: 3,
    searchScope: {
      providerScope: {
        activeProviderIds: ['susf', 'bookable'],
        expandableProviderIds: ['bookable'],
        observedProviderIds: ['susf', 'bookable'],
      },
    },
  });

  const action = await chooseReplanningAction(currentState, { maxIterations: 3 });
  assert.equal(action.selectedAction, REPLANNING_ACTIONS.STOP);
});

test('soft transport preference can trigger replanning without hard rejecting farther candidates', async () => {
  const preferences = profile([
    {
      feature: 'travel_time',
      type: 'soft',
      rule: { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] },
      priority: 'high',
      importance: 'high',
      relaxable: true,
      sourceText: '公交最好30分钟以内，远一点也行',
    },
  ]);
  preferences.transportPreference = {
    maxTransitMinutes: 30,
    preferredTransportModes: ['TRANSIT'],
  };
  const currentState = state({
    preferences,
    candidates: [accessibleCandidate({ id: 'transit-35', transitMinutes: 35 })],
  });

  const hardResult = applyHardConstraints({
    candidates: currentState.candidates,
    preferenceProfile: preferences,
    defaultCalendarBusyIsHard: false,
  });
  const evaluation = evaluateCandidateSet({
    candidates: hardResult.accepted,
    preferences,
  });
  const action = await chooseReplanningAction(currentState, { evaluation });

  assert.equal(hardResult.accepted.length, 1);
  assert.equal(evaluation.weakPreferences[0].feature, 'travel_time');
  assert.equal(evaluation.weakPreferences[0].relaxable, true);
  assert.equal(action.selectedAction, REPLANNING_ACTIONS.ASK_USER);
});

test('hard transport constraint rejects before replanner can relax it', () => {
  const preferences = profile([], [{
    feature: 'travel_time',
    type: 'hard',
    rule: { maxTransitMinutes: 30 },
    priority: 'high',
    importance: 'high',
    relaxable: false,
    sourceText: '公交不能超过30分钟',
  }]);
  preferences.transportPreference = { maxTransitMinutes: 30 };
  const hardResult = applyHardConstraints({
    candidates: [accessibleCandidate({ id: 'hard-transit-35', transitMinutes: 35 })],
    preferenceProfile: preferences,
    defaultCalendarBusyIsHard: false,
  });

  assert.equal(hardResult.accepted.length, 0);
  assert.equal(hardResult.rejected[0].reasons[0].reason, 'transport_time_exceeds_limit');
  assert.equal(hardResult.rejected[0].reasons[0].mode, 'TRANSIT');
});

test('eval: farther-is-ok transit preference is not a hard reject with real candidate accessibility facts', async () => {
  const userText = '明天17点后，便宜一点，公交最好30分钟内，远一点也行，最好连续两小时';
  const preferences = await interpretPreferences(userText, {
    provider: mockPreferenceProvider({
      version: 2,
      searchWindowDays: 1,
      searchScope: {
        days: 1,
        dateRange: { type: 'tomorrow', sourceText: '明天' },
        timeWindow: { after: '17:00' },
        sourceText: userText,
      },
      transportPreference: {
        maxTransitMinutes: 30,
        preferredTransportModes: ['TRANSIT'],
      },
      preferences: [{
        feature: 'price',
        type: 'soft',
        direction: 'lower',
        importance: 'medium',
        priority: 'medium',
        relaxable: true,
        relaxationDirection: 'higher_price',
        sourceText: '便宜一点',
      }, {
        feature: 'travel_time',
        type: 'soft',
        importance: 'high',
        priority: 'high',
        relaxable: true,
        relaxationDirection: 'longer_travel_time',
        rule: {
          maxTransitMinutes: 30,
          preferredTransportModes: ['TRANSIT'],
        },
        sourceText: '公交最好30分钟内，远一点也行',
      }, {
        feature: 'consecutive_availability',
        type: 'soft',
        importance: 'medium',
        priority: 'medium',
        relaxable: true,
        relaxationDirection: 'shorter_duration',
        rule: { preferredMinutes: 120 },
        sourceText: '最好连续两小时',
      }],
      hardConstraints: [{
        feature: 'start_time',
        type: 'hard',
        importance: 'medium',
        priority: 'medium',
        relaxable: false,
        rule: { after: '17:00' },
        sourceText: '17点后',
      }],
      objectives: [],
      unresolvedPreferences: [],
      sourceText: userText,
      updatedAt: '2026-09-08T00:00:00.000Z',
    }),
    now: new Date('2026-09-08T00:00:00.000Z'),
  });
  const realCandidateFacts = accessibleCandidate({
    id: 'real-shaped-transit-35',
    transitMinutes: 35,
    walkMinutes: 44,
    driveMinutes: 16,
  });
  const hardResult = applyHardConstraints({
    candidates: [realCandidateFacts],
    preferenceProfile: preferences,
    defaultCalendarBusyIsHard: false,
  });
  const evaluation = evaluateCandidateSet({
    candidates: hardResult.accepted,
    preferences,
  });

  assert.equal(preferences.transportPreference.maxTransitMinutes, 30);
  assert.equal(preferences.hardConstraints.some((constraint) => constraint.feature === 'travel_time'), false);
  assert.equal(hardResult.accepted.length, 1);
  assert.equal(evaluation.weakPreferences.some((preference) => preference.feature === 'travel_time'), true);
  assert.equal(
    evaluation.failedConstraints.some((failure) => failure.reason === 'transport_time_exceeds_limit'),
    false,
  );
});
