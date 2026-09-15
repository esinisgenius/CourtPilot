import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPLANNING_ACTIONS,
  EVALUATOR_STATUS,
  ReplannerError,
  ReplanningActionSchemaError,
  chooseReplanningAction,
  createInitialAgentState,
  evaluateCandidateSet,
  evaluateCurrentCandidateSet,
  evaluateReplanningContext,
  runReplanningLoop,
  observeConfiguredAvailabilityProviders,
  shiftTimeWindow,
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
    updatedAt: '2026-09-16T00:00:00.000Z',
  }, {
    updatedAt: '2026-09-16T00:00:00.000Z',
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
    startTime: '2026-09-20T08:00:00.000Z',
    durationMinutes: 60,
    features: {
      localDate: '2026-09-20',
      localTime,
      nextHourFree,
      price,
    },
  };
}

function rainyCandidate(overrides = {}) {
  const base = candidate(overrides);
  return {
    ...base,
    features: {
      ...base.features,
      weather: {
        forecastAvailable: true,
        condition: 'rain',
        precipitationProbability: 72,
        precipitationMm: 1.2,
        weatherCode: '61',
      },
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
      departureTime: '2026-09-20T07:15:00.000Z',
      unavailableReason: null,
    },
    drive: { durationMinutes: driveMinutes, distanceMeters: driveMinutes * 100, unavailableReason: null },
    source: 'google_routes',
    observedAt: '2026-09-16T00:00:00.000Z',
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
  startTime = '2026-09-20T18:00:00',
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

test('preferred courts unavailable includes non-preferred courts before generic expansion', async () => {
  const preferences = profile([
    {
      feature: 'court',
      type: 'soft',
      value: 'Court 4',
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
  ]);
  const currentState = state({
    preferences,
    candidates: [],
    searchScope: {
      courtScope: {
        includeNonPreferred: false,
        preferredCourts: ['Court 4', 'Court 5', 'Court 6'],
      },
    },
    failedConstraints: ['preferred_courts_unavailable'],
  });
  const evaluation = evaluateCandidateSet({
    candidates: currentState.candidates,
    preferences,
    failedConstraints: currentState.failedConstraints,
  });
  const action = await chooseReplanningAction(currentState, { evaluation });

  assert.equal(action.selectedAction, REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS);
  assert.equal(action.targetPreference, 'court');
});

test('included non-preferred courts do not keep failing the relaxed soft court preference', async () => {
  const preferences = profile([
    {
      feature: 'court',
      type: 'soft',
      value: 'Court 4',
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
  ]);
  const currentState = state({
    preferences,
    candidates: [candidate({ id: 'court-2', court: 'Court 2' })],
    actionsTaken: [{
      selectedAction: REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS,
      targetPreference: 'court',
      parameters: {},
      rationale: 'Preferred courts were unavailable.',
      expectedEffect: 'Include non-preferred courts for this run.',
      iteration: 0,
    }],
  });
  const { evaluation } = await evaluateCurrentCandidateSet(currentState);

  assert.equal(evaluation.status, EVALUATOR_STATUS.SATISFACTORY);
  assert.equal(evaluation.topCandidateSoftJudgements[0].status, 'relaxed_by_replanning');
});

test('time-window availability failure shifts within hard start-time bounds', async () => {
  const preferences = profile([], [
    {
      feature: 'start_time',
      type: 'hard',
      rule: { after: '17:00' },
      priority: 'high',
      importance: 'high',
      relaxable: false,
    },
  ]);
  const currentState = state({
    preferences,
    candidates: [],
    searchScope: {
      timeWindow: { after: '17:00' },
    },
    failedConstraints: ['no_availability_in_time_window'],
  });
  const evaluation = evaluateCandidateSet({
    candidates: currentState.candidates,
    preferences,
    failedConstraints: currentState.failedConstraints,
  });
  const action = await chooseReplanningAction(currentState, { evaluation });
  const shifted = shiftTimeWindow(currentState);

  assert.equal(action.selectedAction, REPLANNING_ACTIONS.SHIFT_TIME_WINDOW);
  assert.equal(action.targetPreference, 'start_time');
  assert.doesNotThrow(() => validateBoundedRealReplanningAction(action));
  assert.deepEqual(shifted.searchScope.timeWindow, { after: '17:00' });
  assert.equal(shifted.searchScope.temporalShiftSemantics, 'within_hard_start_time_bounds');
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
  assert.equal(action.selectedAction, REPLANNING_ACTIONS.EXPAND_RADIUS);
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

test('candidate-set evaluator uses the top ranked candidate for satisfactory status', async () => {
  const preferences = profile([
    {
      feature: 'next_hour_free',
      type: 'soft',
      target: true,
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
  ]);
  const currentState = state({
    preferences,
    candidates: [
      candidate({ id: 'good-top', nextHourFree: true }),
      candidate({ id: 'weak-second', nextHourFree: false }),
    ],
  });
  const { evaluation, rankerResult } = await evaluateCurrentCandidateSet(currentState);

  assert.equal(rankerResult.rankedCandidates[0].candidateId, 'good-top');
  assert.equal(evaluation.status, EVALUATOR_STATUS.SATISFACTORY);
  assert.equal(evaluation.topCandidateId, 'good-top');
});

test('no hard-feasible candidates returns NO_FEASIBLE_CANDIDATES', () => {
  const preferences = profile([], [{
    feature: 'travel_time',
    type: 'hard',
    rule: { maxTransitMinutes: 30 },
    priority: 'high',
    importance: 'high',
    relaxable: false,
  }]);
  const hardResult = applyHardConstraints({
    candidates: [accessibleCandidate({ id: 'too-far', transitMinutes: 45 })],
    preferenceProfile: preferences,
    defaultCalendarBusyIsHard: false,
  });
  const evaluation = evaluateCandidateSet({
    candidates: hardResult.accepted,
    rejectedCandidates: hardResult.rejected,
    preferences,
  });

  assert.equal(evaluation.status, EVALUATOR_STATUS.NO_FEASIBLE_CANDIDATES);
  assert.equal(evaluation.satisfactory, false);
  assert.equal(evaluation.failedConstraints[0].reason, 'transport_time_exceeds_limit');
});

test('hard rejected candidate diagnostics do not fail a round with feasible candidates', () => {
  const preferences = profile();
  const accepted = Array.from({ length: 6 }, (_, index) => candidate({ id: `accepted-${index}` }));
  const rejected = Array.from({ length: 4 }, (_, index) => ({
    ...candidate({ id: `rejected-${index}` }),
    reasons: [{
      feature: 'start_time',
      reason: 'start_time_outside_temporal_window',
    }],
  }));
  const evaluation = evaluateCandidateSet({
    candidates: accepted,
    rejectedCandidates: rejected,
    preferences,
  });

  assert.equal(evaluation.status, EVALUATOR_STATUS.SATISFACTORY);
  assert.equal(evaluation.satisfactory, true);
  assert.equal(evaluation.reasons.includes('hard_constraints_failed'), false);
  assert.equal(evaluation.failedConstraints.length, 4);
});

test('hard rejected candidates fail the round only when no feasible candidates remain', () => {
  const preferences = profile();
  const rejected = Array.from({ length: 10 }, (_, index) => ({
    ...candidate({ id: `rejected-${index}` }),
    reasons: [{
      feature: 'start_time',
      reason: 'start_time_outside_temporal_window',
    }],
  }));
  const evaluation = evaluateCandidateSet({
    candidates: [],
    rejectedCandidates: rejected,
    preferences,
  });

  assert.equal(evaluation.status, EVALUATOR_STATUS.NO_FEASIBLE_CANDIDATES);
  assert.equal(evaluation.satisfactory, false);
  assert.equal(evaluation.reasons.includes('hard_constraints_failed'), true);
  assert.equal(evaluation.failedConstraints.length, 10);
});

test('default weather rejection is visible to replanning evaluation', () => {
  const preferences = profile();
  const hardResult = applyHardConstraints({
    candidates: [rainyCandidate({ id: 'rainy-flexible' })],
    preferenceProfile: preferences,
    defaultCalendarBusyIsHard: false,
  });
  const evaluation = evaluateCandidateSet({
    candidates: hardResult.accepted,
    rejectedCandidates: hardResult.rejected,
    preferences,
  });

  assert.equal(hardResult.accepted.length, 0);
  assert.equal(evaluation.status, EVALUATOR_STATUS.NO_FEASIBLE_CANDIDATES);
  assert.equal(evaluation.failedConstraints[0].feature, 'weather');
  assert.equal(evaluation.failedConstraints[0].reason, 'default_bad_weather');
  assert.equal(evaluation.reasons.includes('hard_constraints_failed'), true);
});

test('multiple high-priority soft violations need replanning', async () => {
  const preferences = profile([
    {
      feature: 'travel_time',
      type: 'soft',
      rule: { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] },
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
    {
      feature: 'next_hour_free',
      type: 'soft',
      target: true,
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
  ]);
  preferences.transportPreference = { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] };
  const currentState = state({
    preferences,
    candidates: [accessibleCandidate({ id: 'bad-top', transitMinutes: 55 })],
  });
  currentState.candidates[0].features.nextHourFree = false;
  const { evaluation } = await evaluateCurrentCandidateSet(currentState);

  assert.equal(evaluation.status, EVALUATOR_STATUS.NEEDS_REPLANNING);
  assert.equal(evaluation.reasons.includes('top_candidate_multiple_high_priority_soft_violations'), true);
  assert.deepEqual(evaluation.softViolations.map((item) => item.feature).sort(), ['next_hour_free', 'travel_time']);
});

test('mild relaxable transport violation can remain satisfactory', async () => {
  const preferences = profile([
    {
      feature: 'travel_time',
      type: 'soft',
      rule: { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] },
      priority: 'high',
      importance: 'high',
      relaxable: true,
      relaxationDirection: 'longer_travel_time',
      sourceText: '公交最好30分钟内，远一点也行',
    },
  ]);
  preferences.transportPreference = { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] };
  const { evaluation } = await evaluateCurrentCandidateSet(state({
    preferences,
    candidates: [accessibleCandidate({ id: 'mildly-far', transitMinutes: 35 })],
  }));

  assert.equal(evaluation.status, EVALUATOR_STATUS.SATISFACTORY);
  assert.equal(evaluation.softViolations[0].severity, 'mild');
});

test('missing accessibility fact is not treated as a transport violation', async () => {
  const preferences = profile([
    {
      feature: 'travel_time',
      type: 'soft',
      rule: { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] },
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
  ]);
  preferences.transportPreference = { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] };
  const { evaluation } = await evaluateCurrentCandidateSet(state({
    preferences,
    candidates: [candidate({ id: 'missing-accessibility' })],
  }));

  assert.equal(evaluation.status, EVALUATOR_STATUS.NEEDS_REPLANNING);
  assert.equal(evaluation.missingFacts[0].feature, 'travel_time');
  assert.equal(evaluation.softViolations.some((violation) => violation.feature === 'travel_time'), false);
});

test('ranker failure fallback still feeds evaluator', async () => {
  const preferences = profile([
    {
      feature: 'travel_time',
      type: 'soft',
      rule: { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] },
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
    {
      feature: 'consecutive_availability',
      type: 'soft',
      rule: { preferredMinutes: 120 },
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
  ]);
  preferences.transportPreference = { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] };
  const { evaluation, rankerResult } = await evaluateCurrentCandidateSet(state({
    preferences,
    candidates: [
      accessibleCandidate({ id: 'A', transitMinutes: 35 }),
      accessibleCandidate({ id: 'B', transitMinutes: 24 }),
    ],
  }), {
    rankerProvider: () => {
      throw new Error('synthetic ranker failure');
    },
  });

  assert.equal(rankerResult.rankedCandidates[0].candidateId, 'B');
  assert.equal(evaluation.status, EVALUATOR_STATUS.SATISFACTORY);
});

test('replanner action produces a new observation cycle after evaluator requests replanning', async () => {
  const preferences = profile([
    {
      feature: 'next_hour_free',
      type: 'soft',
      target: true,
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
  ]);
  const observations = [];
  const result = await runReplanningLoop(state({
    preferences,
    candidates: [],
    searchScope: { radiusMeters: 3000 },
  }), {
    provider: {
      async choose({ state: currentState, evaluation }) {
        if (currentState.iteration === 0) {
          assert.equal(evaluation.status, EVALUATOR_STATUS.NEEDS_REPLANNING);
          return {
            selectedAction: REPLANNING_ACTIONS.EXPAND_RADIUS,
            targetPreference: null,
            rationale: 'Current top candidate misses a high-priority soft preference.',
            expectedEffect: 'A wider radius may produce a stronger top candidate.',
          };
        }
        return {
          selectedAction: REPLANNING_ACTIONS.SATISFACTORY,
          targetPreference: null,
          rationale: 'The second observation has a candidate satisfying the high-priority soft preference.',
          expectedEffect: 'Stop with the ranked result.',
        };
      },
    },
    observe: async (currentState) => {
      observations.push(currentState.searchScope.radiusMeters);
      if (currentState.iteration === 0) {
        return { candidates: [candidate({ id: 'initial-weak', nextHourFree: false })] };
      }
      return { candidates: [candidate({ id: 'second-good', nextHourFree: true })] };
    },
  });

  assert.equal(result.status, 'SATISFACTORY');
  assert.deepEqual(observations, [3000, 5000]);
  assert.deepEqual(result.iterations.map((iteration) => iteration.evaluation.status), [
    EVALUATOR_STATUS.NEEDS_REPLANNING,
    EVALUATOR_STATUS.SATISFACTORY,
  ]);
  assert.equal(result.rankedCandidates[0].candidateId, 'second-good');
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

test('replanning loop returns MAX_ITERATIONS_REACHED without recording an extra STOP iteration', async () => {
  const result = await runReplanningLoop(state({
    candidates: [],
    iteration: 0,
  }), {
    observe: async () => ({ candidates: [] }),
    maxIterations: 3,
  });

  assert.equal(result.status, 'MAX_ITERATIONS_REACHED');
  assert.equal(result.state.status, 'MAX_ITERATIONS_REACHED');
  assert.equal(result.iterations.length, 3);
  assert.equal(result.iterations.at(-1).action.selectedAction, REPLANNING_ACTIONS.EXPAND_VENUE_SET);
});

test('heuristic replanner returns only bounded executor actions for weak soft preferences', async () => {
  const preferences = profile([
    {
      feature: 'price',
      type: 'soft',
      direction: 'lower',
      priority: 'medium',
      importance: 'medium',
      relaxable: true,
    },
    {
      feature: 'consecutive_availability',
      type: 'soft',
      rule: { preferredMinutes: 120 },
      priority: 'high',
      importance: 'high',
      relaxable: true,
    },
  ]);
  const currentState = state({
    preferences,
    candidates: [candidate({ id: 'short', price: null, nextHourFree: false })],
  });
  const { evaluation } = await evaluateCurrentCandidateSet(currentState);
  const action = await chooseReplanningAction(currentState, { evaluation });

  assert.doesNotThrow(() => validateBoundedRealReplanningAction(action));
  assert.notEqual(action.selectedAction, REPLANNING_ACTIONS.RELAX_PRICE);
});

test('no-candidate replanner asks user after broad automatic expansions were already tried', async () => {
  const action = await chooseReplanningAction(state({
    candidates: [],
    actionsTaken: [
      { selectedAction: REPLANNING_ACTIONS.EXPAND_RADIUS },
      { selectedAction: REPLANNING_ACTIONS.EXPAND_DATE_WINDOW },
      { selectedAction: REPLANNING_ACTIONS.SEARCH_OTHER_VENUES },
    ].map((entry, iteration) => ({
      ...entry,
      targetPreference: null,
      parameters: {},
      rationale: 'Already tried before this scenario.',
      expectedEffect: 'Do not repeat broad automatic expansion.',
      iteration,
    })),
  }));

  assert.equal(action.selectedAction, REPLANNING_ACTIONS.ASK_USER);
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

test('provider timeout preserves partial availability candidates', async () => {
  const initialState = state({
    candidates: [],
    searchScope: {
      providerScope: {
        activeProviderIds: ['susf'],
        expandableProviderIds: ['susf'],
      },
    },
  });

  const observed = await observeConfiguredAvailabilityProviders(initialState, {
    providerTimeoutMs: 5,
    providerFetchers: {
      susf({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('timed out with partial availability');
            error.code = 'PROVIDER_TIMEOUT';
            error.availability = [availabilitySlot()];
            reject(error);
          }, { once: true });
        });
      },
    },
  });

  assert.equal(observed.candidates.length, 1);
  assert.equal(observed.factualObservations.availability.providers[0].status, 'timed_out');
  assert.equal(observed.factualObservations.availability.providers[0].candidateCount, 1);
  assert.deepEqual(observed.searchScope.providerScope.failedProviderIds, ['susf']);
});

test('SUSF provider can use a wider timeout than lightweight providers', async () => {
  const initialState = state({
    candidates: [],
    searchScope: {
      providerScope: {
        activeProviderIds: ['susf', 'bookable'],
        expandableProviderIds: ['susf', 'bookable'],
      },
    },
  });

  const observed = await observeConfiguredAvailabilityProviders(initialState, {
    providerTimeoutMs: 5,
    susfProviderTimeoutMs: 50,
    providerFetchers: {
      susf() {
        return new Promise((resolve) => {
          setTimeout(() => resolve([availabilitySlot()]), 15);
        });
      },
      bookable({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('bookable timed out');
            error.code = 'PROVIDER_TIMEOUT';
            reject(error);
          }, { once: true });
        });
      },
    },
  });

  const observations = observed.factualObservations.availability.providers;
  assert.equal(observed.candidates.length, 1);
  assert.equal(observations.find((item) => item.providerId === 'susf').status, 'success');
  assert.equal(observations.find((item) => item.providerId === 'bookable').status, 'timed_out');
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

test('soft transport preference can remain satisfactory without hard rejecting a mildly farther candidate', async () => {
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
  assert.equal(evaluation.softViolations[0].feature, 'travel_time');
  assert.equal(evaluation.softViolations[0].relaxable, true);
  assert.equal(evaluation.softViolations[0].severity, 'mild');
  assert.equal(action.selectedAction, REPLANNING_ACTIONS.SATISFACTORY);
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
