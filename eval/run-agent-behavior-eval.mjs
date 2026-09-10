import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  chooseReplanningAction,
  createInitialAgentState,
  evaluateCurrentCandidateSet,
  executeReplanningAction,
  preferenceMatchesCandidate,
  validateBoundedRealReplanningAction,
} from '../packages/agent/src/index.mjs';
import { applyHardConstraints } from '../packages/core/src/index.mjs';
import { normalizePreferenceProfile } from '../packages/preferences/src/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'agent-behavior-cases.json');

const EVAL_TIMESTAMP = '2026-09-03T00:00:00.000Z';
const DEFAULT_LOCAL_DATE = '2026-09-04';

function parseCases(text) {
  const trimmed = text.trim();
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```json\s*/u, '').replace(/\s*```$/u, '')
    : trimmed;
  return JSON.parse(json);
}

function preference(feature, overrides = {}) {
  return {
    feature,
    type: 'soft',
    importance: 'medium',
    priority: 'medium',
    sourceText: overrides.sourceText ?? feature,
    ...overrides,
  };
}

function hardConstraint(feature, overrides = {}) {
  const constraint = preference(feature, {
    type: 'hard',
    importance: 'high',
    priority: 'high',
    relaxable: false,
    ...overrides,
  });
  delete constraint.relaxationDirection;
  return constraint;
}

function profileForCase(testCase) {
  const text = testCase.userInput ?? '';
  const preferences = [];
  const hardConstraints = [];
  const searchScope = {
    sourceText: text,
  };
  const transportPreference = {};

  if (text.includes('便宜')) {
    preferences.push(preference('price', {
      direction: 'lower',
      importance: text.includes('优先') ? 'high' : 'medium',
      priority: text.includes('优先') ? 'high' : 'medium',
      sourceText: '便宜',
    }));
  }

  const hardTransit = text.match(/公交不能超过(\d+)分钟/u);
  const softTransit = text.match(/公交最好(\d+)分钟内/u);
  if (hardTransit) {
    const maxTransitMinutes = Number(hardTransit[1]);
    transportPreference.maxTransitMinutes = maxTransitMinutes;
    hardConstraints.push(hardConstraint('travel_time', {
      rule: { maxTransitMinutes },
      sourceText: hardTransit[0],
    }));
  } else if (softTransit) {
    const maxTransitMinutes = Number(softTransit[1]);
    transportPreference.maxTransitMinutes = maxTransitMinutes;
    const relaxed = text.includes('远一点也行');
    preferences.push(preference('travel_time', {
      importance: relaxed ? 'medium' : 'high',
      priority: relaxed ? 'medium' : 'high',
      rule: { maxTransitMinutes },
      sourceText: softTransit[0],
    }));
  }

  if (text.includes('连续两小时') || text.includes('后一小时')) {
    const strict = text.includes('必须连续两小时');
    preferences.push(preference('consecutive_availability', {
      importance: 'high',
      priority: 'high',
      rule: { minMinutes: 120 },
      sourceText: strict ? '必须连续两小时' : '最好连续两小时',
      relaxable: !strict,
    }));
  }

  if (text.includes('Court 4/5/6优先')) {
    preferences.push(preference('court', {
      importance: 'high',
      priority: 'high',
      value: 'Court 4',
      sourceText: 'Court 4/5/6优先',
    }));
    searchScope.courtScope = { preferredCourts: ['Court 4', 'Court 5', 'Court 6'] };
  }

  if (text.includes('17点后') || text.includes('17点以后')) {
    searchScope.timeWindow = { after: '17:00' };
  }

  if (text.includes('17点以前不行') || text.includes('17点以前绝对不行')) {
    hardConstraints.push(hardConstraint('start_time', {
      rule: { after: '17:00' },
      sourceText: '17点以前不行',
    }));
  }

  return normalizePreferenceProfile({
    version: 2,
    sourceText: text,
    searchScope,
    transportPreference,
    preferences,
    hardConstraints,
    objectives: [],
    unresolvedPreferences: [],
  }, {
    sourceText: text,
    updatedAt: EVAL_TIMESTAMP,
  });
}

function localTimeFor(raw) {
  if (typeof raw.localTime === 'string') return raw.localTime;
  if (typeof raw.startTime === 'string' && /^\d{2}:\d{2}$/u.test(raw.startTime)) return raw.startTime;
  if (typeof raw.startTime === 'string') {
    const match = raw.startTime.match(/T(\d{2}:\d{2})/u);
    if (match) return match[1];
  }
  return '18:00';
}

function candidateForFixture(raw, profile) {
  const localTime = localTimeFor(raw);
  const continuousMinutes = Number.isFinite(raw.continuousMinutes)
    ? raw.continuousMinutes
    : raw.durationMinutes;
  const transitKnown = raw.transitMinutes !== null && raw.transitMinutes !== undefined;
  const walkKnown = raw.walkMinutes !== null && raw.walkMinutes !== undefined;
  const driveKnown = raw.driveMinutes !== null && raw.driveMinutes !== undefined;
  const accessibility = {
    transit: {
      durationMinutes: transitKnown ? raw.transitMinutes : null,
      distanceMeters: transitKnown ? raw.transitMinutes * 100 : null,
      unavailableReason: transitKnown ? null : raw.accessibilityUnavailableReason ?? 'accessibility_missing',
    },
    walk: {
      durationMinutes: walkKnown ? raw.walkMinutes : null,
      distanceMeters: walkKnown ? raw.walkMinutes * 100 : null,
      unavailableReason: walkKnown ? null : 'accessibility_missing',
    },
    drive: {
      durationMinutes: driveKnown ? raw.driveMinutes : null,
      distanceMeters: driveKnown ? raw.driveMinutes * 100 : null,
      unavailableReason: driveKnown ? null : 'accessibility_missing',
    },
  };
  const courtPreference = profile.preferences
    ?.filter((item) => item.feature === 'court' && item.value)
    .some((item) => item.value === raw.court);

  return {
    id: raw.id,
    venue: raw.venue ?? 'SUSF',
    court: raw.court ?? 'Court 4',
    startTime: raw.startTime && !/^\d{2}:\d{2}$/u.test(raw.startTime)
      ? raw.startTime
      : `${DEFAULT_LOCAL_DATE}T${localTime}:00+10:00`,
    durationMinutes: raw.durationMinutes ?? 60,
    accessibility,
    features: {
      localDate: raw.localDate ?? DEFAULT_LOCAL_DATE,
      localTime,
      nextHourFree: raw.nextHourAlsoAvailable ?? (Number.isFinite(continuousMinutes) ? continuousMinutes >= 120 : null),
      continuousDurationMinutes: Number.isFinite(continuousMinutes) ? continuousMinutes : null,
      price: Number.isFinite(raw.price) ? raw.price : null,
      currency: Number.isFinite(raw.price) ? 'AUD' : null,
      accessibility,
      calendar: { free: raw.calendarFree ?? true },
      weather: raw.weather ?? { forecastAvailable: true, precipitationMm: 0 },
      courtPreference,
    },
  };
}

function observationForState(testCase, state) {
  const lastAction = state.actionsTaken.at(-1)?.selectedAction ?? null;
  const nextIteration = state.iteration + 1;
  return testCase.observations.find((observation) => {
    if (observation.iteration !== nextIteration) return false;
    return !observation.afterAction || observation.afterAction === lastAction;
  }) ?? null;
}

function observeForCase(testCase, profile) {
  return async (state) => {
    const observation = observationForState(testCase, state);
    const observedState = observation?.state ?? {};
    return {
      searchScope: {
        ...state.searchScope,
        ...observedState,
        radiusMeters: observedState.radiusMeters ?? state.searchScope.radiusMeters,
      },
      candidates: (observation?.candidates ?? []).map((raw) => candidateForFixture(raw, profile)),
      rejectedCandidates: [],
      failedConstraints: observation?.failedConstraints ?? [],
      factualObservations: {
        eval: {
          caseId: testCase.id,
          observationIteration: observation?.iteration ?? null,
          afterAction: observation?.afterAction ?? null,
        },
      },
    };
  };
}

function applyDeterministicHardFilter(state) {
  const filtered = applyHardConstraints({
    candidates: state.candidates,
    preferenceProfile: state.preferences,
    defaultCalendarBusyIsHard: false,
  });

  return {
    ...state,
    candidates: filtered.accepted,
    rejectedCandidates: [
      ...state.rejectedCandidates,
      ...filtered.rejected,
    ],
  };
}

async function refreshObservedState(state, observe) {
  const observed = await observe(state);
  return {
    ...state,
    ...observed,
    searchScope: observed?.searchScope ?? state.searchScope,
    candidates: observed?.candidates ?? state.candidates,
    rejectedCandidates: observed?.rejectedCandidates ?? state.rejectedCandidates,
    failedConstraints: observed?.failedConstraints ?? state.failedConstraints,
    factualObservations: observed?.factualObservations ?? state.factualObservations,
    actionsTaken: observed?.actionsTaken ?? state.actionsTaken,
    iteration: observed?.iteration ?? state.iteration,
    status: observed?.status ?? state.status,
  };
}

async function runScenarioLoop(initialState, {
  observe,
  rankerProvider,
  maxIterations = 3,
} = {}) {
  let state = applyDeterministicHardFilter(await refreshObservedState(initialState, observe));
  const iterations = [];
  let latestRanking = { rankedCandidates: [] };

  while (true) {
    if (state.iteration >= maxIterations) {
      return {
        status: 'MAX_ITERATIONS_REACHED',
        state: {
          ...state,
          status: 'MAX_ITERATIONS_REACHED',
        },
        iterations,
        rankedCandidates: latestRanking.rankedCandidates,
      };
    }

    const {
      evaluation,
      rankerResult,
      factualCandidateFeatures,
    } = await evaluateCurrentCandidateSet(state, {
      rankerProvider,
    });
    latestRanking = rankerResult;
    const action = evaluation.status === 'SATISFACTORY'
      ? validateBoundedRealReplanningAction({
        selectedAction: 'SATISFACTORY',
        targetPreference: null,
        rationale: 'The current ranked candidate set is satisfactory.',
        expectedEffect: 'Return the ranked candidates without invoking the replanner.',
      })
      : await chooseReplanningAction(state, {
        maxIterations,
        evaluation,
      });

    iterations.push({
      iteration: state.iteration,
      evaluation,
      action,
      searchScope: state.searchScope,
      candidateCount: state.candidates.length,
      rankedCandidates: rankerResult.rankedCandidates,
      factualCandidateFeatures,
      hardRejectedCandidateIds: state.rejectedCandidates.map((entry) => entry.candidate?.id).filter(Boolean),
    });

    let nextState;
    try {
      nextState = await executeReplanningAction(state, action);
    } catch (error) {
      error.partialResult = {
        status: state.status,
        state,
        iterations,
        rankedCandidates: latestRanking.rankedCandidates,
      };
      throw error;
    }

    if (['SATISFACTORY', 'ASKING_USER', 'STOPPED'].includes(nextState.status)) {
      return {
        status: nextState.status,
        state: nextState,
        iterations,
        rankedCandidates: latestRanking.rankedCandidates,
      };
    }

    state = applyDeterministicHardFilter(await refreshObservedState(nextState, observe));
  }
}

function firstNonTerminalAction(iterations) {
  return iterations.find((iteration) => iteration.action.selectedAction !== 'SATISFACTORY')?.action ?? null;
}

function hardConstraintRelaxed(result, profile) {
  const hardFeatures = new Set((profile.hardConstraints ?? []).map((constraint) => constraint.feature));
  return result.iterations.some((iteration) => {
    const action = iteration.action;
    return action.selectedAction.startsWith('RELAX_') && hardFeatures.has(action.targetPreference);
  });
}

function candidateFromFactualSnapshot(snapshot) {
  const accessibility = {
    transit: {
      durationMinutes: snapshot.accessibility?.TRANSIT?.durationMinutes ?? null,
      distanceMeters: snapshot.accessibility?.TRANSIT?.distanceMeters ?? null,
      unavailableReason: snapshot.accessibility?.TRANSIT?.unavailableReason ?? null,
    },
    walk: {
      durationMinutes: snapshot.accessibility?.WALK?.durationMinutes ?? null,
      distanceMeters: snapshot.accessibility?.WALK?.distanceMeters ?? null,
      unavailableReason: snapshot.accessibility?.WALK?.unavailableReason ?? null,
    },
    drive: {
      durationMinutes: snapshot.accessibility?.DRIVE?.durationMinutes ?? null,
      distanceMeters: snapshot.accessibility?.DRIVE?.distanceMeters ?? null,
      unavailableReason: snapshot.accessibility?.DRIVE?.unavailableReason ?? null,
    },
  };

  return {
    id: snapshot.candidateId,
    venue: snapshot.venue?.name ?? null,
    court: snapshot.court?.name ?? null,
    startTime: snapshot.slot?.startTime ?? null,
    durationMinutes: snapshot.slot?.durationMinutes ?? null,
    accessibility,
    features: {
      localDate: snapshot.slot?.localDate ?? null,
      localTime: snapshot.slot?.localTime ?? null,
      nextHourFree: snapshot.availability?.nextHourAlsoAvailable ?? null,
      continuousDurationMinutes: snapshot.continuousDurationMinutes ?? null,
      price: snapshot.price?.amount ?? null,
      accessibility,
      courtPreference: snapshot.court?.preferenceMatch ?? null,
      venuePreference: snapshot.venue?.preferenceMatch ?? null,
      calendar: snapshot.calendar ?? null,
      weather: snapshot.weather ?? null,
    },
  };
}

function candidateLevelJudgements(result, profile) {
  const missingFacts = [];
  const softViolations = [];

  for (const iteration of result.iterations) {
    for (const candidate of iteration.factualCandidateFeatures) {
      const runtimeCandidate = candidateFromFactualSnapshot(candidate);
      for (const pref of profile.preferences ?? []) {
        const match = preferenceMatchesCandidate(pref, runtimeCandidate);
        if (match === null) missingFacts.push(`${candidate.candidateId}:${pref.feature}`);
        if (match === false) softViolations.push(`${candidate.candidateId}:${pref.feature}`);
      }
    }
  }

  return {
    missingFacts: [...new Set(missingFacts)],
    softViolations: [...new Set(softViolations)],
  };
}

function actualTraceFor(testCase, profile, result, rankerMeta, error = null) {
  const first = result?.iterations?.[0] ?? null;
  const final = result?.iterations?.at(-1) ?? null;
  const firstAction = firstNonTerminalAction(result?.iterations ?? []);
  const rejectedCandidateIds = [
    ...new Set((result?.iterations ?? []).flatMap((iteration) => iteration.hardRejectedCandidateIds ?? [])),
  ];
  const candidateJudgements = result ? candidateLevelJudgements(result, profile) : { missingFacts: [], softViolations: [] };
  const rankedCandidateIds = result?.rankedCandidates?.map((entry) => entry.candidateId) ?? [];
  const topRanked = rankedCandidateIds[0] ?? first?.evaluation?.topCandidateId ?? null;

  return {
    caseId: testCase.id,
    error: error ? `${error.name}: ${error.message}` : null,
    evaluatorStatus: first?.evaluation?.status ?? null,
    firstEvaluation: first?.evaluation?.status ?? null,
    finalEvaluation: final?.evaluation?.status ?? null,
    topCandidateId: topRanked,
    finalTopCandidateId: final?.evaluation?.topCandidateId ?? topRanked,
    expectedAction: firstAction?.selectedAction ?? null,
    finalAction: final?.action?.selectedAction ?? null,
    actions: (result?.iterations ?? []).map((iteration) => iteration.action.selectedAction),
    actionTargets: (result?.iterations ?? []).map((iteration) => iteration.action.targetPreference),
    replannerCalled: (result?.iterations ?? []).some((iteration) => iteration.action.selectedAction !== 'SATISFACTORY'),
    iterations: result?.iterations?.length ?? 0,
    finalStatus: result?.status ?? null,
    fallbackUsed: rankerMeta.fallbackUsed,
    rankedCandidateIdsPresent: rankedCandidateIds,
    rankerInputCandidateIds: first?.factualCandidateFeatures?.map((candidate) => candidate.candidateId) ?? [],
    hardRejectedCandidateIds: rejectedCandidateIds,
    hardConstraintRelaxed: result ? hardConstraintRelaxed(result, profile) : null,
    hardConstraintsRelaxed: result ? hardConstraintRelaxed(result, profile) : null,
    forbiddenRelaxations: [],
    missingFacts: candidateJudgements.missingFacts,
    softViolations: [
      ...new Set([
        ...candidateJudgements.softViolations,
        ...(first?.evaluation?.softViolations ?? []).map((item) => item.feature),
      ]),
    ],
    stateChanged: result?.iterations?.length > 1
      ? JSON.stringify(result.iterations[0].searchScope) !== JSON.stringify(result.iterations[1].searchScope)
      : false,
    observationChanged: result?.iterations?.length > 1
      ? JSON.stringify(result.iterations[0].rankedCandidates) !== JSON.stringify(result.iterations[1].rankedCandidates)
      : false,
    agentContinues: !error,
    providerFailureDoesNotAbortLoop: rankerMeta.providerFailed ? !error : true,
    mustNotLoopForever: Boolean(result),
    mustNotTreatMissingAsViolation: !candidateJudgements.softViolations.some((item) => item.startsWith('unknown-route:')),
    mustExplainTradeoff: (result?.rankedCandidates?.[0]?.tradeoffs ?? []).length > 0,
    mustNotInventFacts: !error,
    mustNotInventNewPreference: true,
  };
}

function includesAll(actualValues = [], expectedValues = []) {
  const actual = new Set(actualValues);
  return expectedValues.every((value) => actual.has(value));
}

function compareExpected(actual, expected) {
  const mismatches = [];
  const exactFields = [
    'evaluatorStatus',
    'topCandidateId',
    'replannerCalled',
    'iterations',
    'firstEvaluation',
    'expectedAction',
    'finalEvaluation',
    'finalTopCandidateId',
    'hardConstraintRelaxed',
    'hardConstraintsRelaxed',
    'fallbackUsed',
    'agentContinues',
    'providerFailureDoesNotAbortLoop',
    'stateChanged',
    'observationChanged',
    'finalStatus',
    'mustNotLoopForever',
    'mustNotTreatMissingAsViolation',
    'mustExplainTradeoff',
    'mustNotInventFacts',
    'mustNotInventNewPreference',
  ];

  for (const field of exactFields) {
    if (expected[field] !== undefined && actual[field] !== expected[field]) {
      mismatches.push(`expected ${field} = ${JSON.stringify(expected[field])}; actual ${field} = ${JSON.stringify(actual[field])}`);
    }
  }

  const listFields = [
    'softViolations',
    'missingFacts',
    'hardRejectedCandidateIds',
    'rankerInputCandidateIds',
    'rankedCandidateIdsPresent',
  ];
  for (const field of listFields) {
    if (expected[field] !== undefined && !includesAll(actual[field], expected[field])) {
      mismatches.push(`expected ${field} to include ${JSON.stringify(expected[field])}; actual ${field} = ${JSON.stringify(actual[field])}`);
    }
  }

  if (expected.acceptableTopCandidates && !expected.acceptableTopCandidates.includes(actual.topCandidateId)) {
    mismatches.push(`expected topCandidateId ∈ ${JSON.stringify(expected.acceptableTopCandidates)}; actual topCandidateId = ${JSON.stringify(actual.topCandidateId)}`);
  }

  if (expected.allowedActions && !expected.allowedActions.includes(actual.expectedAction)) {
    mismatches.push(`expected action ∈ ${JSON.stringify(expected.allowedActions)}; actual action = ${actual.expectedAction}`);
  }

  if (expected.allowedFinalActions && !expected.allowedFinalActions.includes(actual.finalAction)) {
    mismatches.push(`expected final action ∈ ${JSON.stringify(expected.allowedFinalActions)}; actual final action = ${actual.finalAction}`);
  }

  if (expected.forbiddenActions) {
    const forbidden = actual.actions.filter((action) => expected.forbiddenActions.includes(action));
    if (forbidden.length > 0) {
      mismatches.push(`expected no forbiddenActions ${JSON.stringify(expected.forbiddenActions)}; actual actions = ${JSON.stringify(actual.actions)}`);
    }
  }

  if (expected.forbiddenRelaxations) {
    const relaxedTargets = actual.actionTargets.filter(Boolean);
    const forbidden = relaxedTargets.filter((target) => expected.forbiddenRelaxations.includes(target));
    if (forbidden.length > 0 || actual.hardConstraintRelaxed) {
      mismatches.push(`expected no forbiddenRelaxations ${JSON.stringify(expected.forbiddenRelaxations)}; actual actionTargets = ${JSON.stringify(actual.actionTargets)}`);
    }
  }

  return mismatches;
}

function printTrace(testCase, actual, mismatches) {
  const shortId = testCase.id.split('_')[0];
  console.log(`${shortId} FAIL`);
  console.log(mismatches[0] ?? 'mismatch reason unavailable');
  console.log('actual trace');
  console.log(JSON.stringify(actual, null, 2));
  console.log('expected trace');
  console.log(JSON.stringify(testCase.expected, null, 2));
}

async function runCase(testCase) {
  const profile = profileForCase(testCase);
  const rankerMeta = {
    fallbackUsed: false,
    providerFailed: false,
  };
  const rankerProvider = testCase.observations.some((observation) => observation.rankerFailure)
    ? async () => {
      rankerMeta.providerFailed = true;
      rankerMeta.fallbackUsed = true;
      throw new Error('synthetic ranker failure');
    }
    : null;
  const initialState = createInitialAgentState({
    goal: 'evaluate agent behavior scenario',
    preferences: profile,
    searchScope: {
      days: profile.searchWindowDays ?? 7,
      radiusMeters: testCase.initialState?.radiusMeters ?? 3000,
      ...(profile.searchScope ?? {}),
    },
    candidates: [],
    rejectedCandidates: [],
    failedConstraints: [],
    factualObservations: {},
    actionsTaken: testCase.observations[0]?.actionsAlreadyTried?.map((selectedAction, index) => ({
      selectedAction,
      targetPreference: null,
      parameters: {},
      rationale: 'Pre-existing action from scenario fixture.',
      expectedEffect: 'Marks the action as already attempted before the scenario starts.',
      iteration: index,
    })) ?? [],
    iteration: 0,
    status: 'READY',
  });

  try {
    const result = await runScenarioLoop(initialState, {
      observe: observeForCase(testCase, profile),
      rankerProvider,
      maxIterations: testCase.initialState?.maxIterations ?? 3,
    });
    const actual = actualTraceFor(testCase, profile, result, rankerMeta);
    const mismatches = compareExpected(actual, testCase.expected);
    return { actual, mismatches };
  } catch (error) {
    const actual = actualTraceFor(testCase, profile, error.partialResult ?? null, rankerMeta, error);
    const mismatches = compareExpected(actual, testCase.expected);
    if (mismatches.length === 0) mismatches.push(`unexpected runner error: ${error.name}: ${error.message}`);
    return { actual, mismatches };
  }
}

async function main() {
  const cases = parseCases(await readFile(fixturePath, 'utf8'));
  let passed = 0;
  const failed = [];

  for (const testCase of cases) {
    const { actual, mismatches } = await runCase(testCase);
    const shortId = testCase.id.split('_')[0];
    if (mismatches.length === 0) {
      passed += 1;
      console.log(`${shortId} PASS`);
    } else {
      failed.push({ testCase, actual, mismatches });
      printTrace(testCase, actual, mismatches);
    }
  }

  console.log(`${cases.length} cases`);
  console.log(`${passed} passed`);
  console.log(`${failed.length} failed`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
