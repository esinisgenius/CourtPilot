import { applyHardConstraints } from '../../core/src/index.mjs';
import {
  normalizePreferenceProfile,
  validatePreferenceProfile,
} from '../../preferences/src/index.mjs';
import {
  buildRankerInput,
  rankCandidates,
} from '../../ranking/src/index.mjs';
import { getNextRadius, getSavedPlayArea } from '../../maps/src/index.mjs';
import { boundedRealReplanningActions, REPLANNING_ACTIONS, validateReplanningAction } from './actions.mjs';
import { buildDiagnosticSnapshot, buildReplanningObservation, evaluateCandidateSet } from './evaluator.mjs';
import { chooseReplanningDecision } from './policy.mjs';
import {
  expandSearchRadius,
  expandVenueSet,
  includeNonPreferredCourts,
  shiftTimeWindow,
  switchSearchArea,
} from './search-scope.mjs';
import { validateAgentState } from './state.mjs';

class ReplannerError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ReplannerError';
    this.code = 'REPLANNER_ERROR';
    this.issues = issues;
  }
}

function validateBoundedRealReplanningAction(action) {
  const validated = validateReplanningAction(action);
  if (!boundedRealReplanningActions.has(validated.selectedAction)) {
    throw new ReplannerError('Action is outside the Real LLM Replanner contract', [
      `selectedAction must be one of ${[...boundedRealReplanningActions].join(', ')}`,
    ]);
  }
  return validated;
}

function actionWasTaken(state, selectedAction, predicate = () => true) {
  return state.actionsTaken.some((entry) => entry.selectedAction === selectedAction && predicate(entry));
}

async function validateActionForState(state, action, {
  evaluation,
  savedAreasPath,
} = {}) {
  const current = validateAgentState(state);
  const validated = validateBoundedRealReplanningAction(action);
  const selected = validated.selectedAction;

  if (selected === REPLANNING_ACTIONS.SATISFACTORY && evaluation?.satisfactory !== true) {
    throw new ReplannerError('SATISFACTORY is incompatible with the current evaluation');
  }
  if (selected === REPLANNING_ACTIONS.EXPAND_RADIUS
    && getNextRadius(current.searchScope?.radiusMeters) <= (current.searchScope?.radiusMeters ?? 0)) {
    throw new ReplannerError('Search radius is already at the configured maximum');
  }
  if (selected === REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS) {
    const courtPreference = (current.preferences?.preferences ?? [])
      .some((preference) => preference.feature === 'court' && preference.relaxable !== false);
    if (!courtPreference || current.searchScope?.courtScope?.includeNonPreferred === true) {
      throw new ReplannerError('Non-preferred court expansion is unavailable or already exhausted');
    }
  }
  if (selected === REPLANNING_ACTIONS.SHIFT_TIME_WINDOW
    && actionWasTaken(current, REPLANNING_ACTIONS.SHIFT_TIME_WINDOW)) {
    throw new ReplannerError('Time-window shift was already attempted without sufficient progress');
  }
  if (selected === REPLANNING_ACTIONS.EXPAND_VENUE_SET) {
    try {
      expandVenueSet(current);
    } catch (error) {
      throw new ReplannerError(error.message, [error.message]);
    }
  }
  if (selected === REPLANNING_ACTIONS.SEARCH_OTHER_VENUES) {
    try {
      expandVenueSet(current);
    } catch (error) {
      throw new ReplannerError(error.message, [error.message]);
    }
  }
  if (selected === REPLANNING_ACTIONS.REINTERPRET_PREFERENCES) {
    if (actionWasTaken(current, REPLANNING_ACTIONS.REINTERPRET_PREFERENCES)) {
      throw new ReplannerError('Preference reinterpretation was already attempted without sufficient progress');
    }
    validatePreferencePatch(current.preferences, validated.parameters.patch);
  }
  if (selected === REPLANNING_ACTIONS.SWITCH_SEARCH_AREA) {
    const targetAreaId = validated.parameters.targetAreaId;
    if (targetAreaId === current.searchScope?.activeAreaId
      || actionWasTaken(current, selected, (entry) => entry.parameters?.targetAreaId === targetAreaId)) {
      throw new ReplannerError('The requested search area is current or already exhausted');
    }
    if (!await getSavedPlayArea(targetAreaId, { filePath: savedAreasPath })) {
      throw new ReplannerError(`Saved play area not found: ${targetAreaId}`);
    }
  }
  return validated;
}

function profileForValidation(profile = {}) {
  const {
    version,
    searchWindowDays,
    searchScope,
    transportPreference,
    weatherPreference,
    preferences,
    hardConstraints,
    objectives,
    unresolvedPreferences,
    sourceText,
    updatedAt,
  } = profile;
  const scope = searchScope ?? {};
  return {
    version,
    searchWindowDays,
    searchScope: {
      days: scope.days,
      dateRange: scope.dateRange,
      timeWindow: scope.timeWindow,
      location: typeof scope.location === 'string' ? scope.location : undefined,
      sourceText: scope.sourceText,
      source: scope.source,
      isExplicit: scope.isExplicit,
    },
    transportPreference,
    weatherPreference,
    preferences,
    hardConstraints,
    objectives,
    unresolvedPreferences,
    sourceText,
    updatedAt,
  };
}

function hasHardConstraintSubset(before = [], after = []) {
  const afterKeys = new Set(after.map((constraint) => JSON.stringify(constraint)));
  return before.every((constraint) => afterKeys.has(JSON.stringify(constraint)));
}

function validatePreferencePatch(profile, patch) {
  applyPreferencePatch(profile, patch);
}

function patchedTimeWindow(searchScope = {}, patch = {}) {
  const timeWindow = { ...(searchScope.timeWindow ?? {}) };
  if (patch.timeStart) timeWindow.after = patch.timeStart;
  if (patch.timeEnd) timeWindow.before = patch.timeEnd;
  return Object.keys(timeWindow).length > 0 ? timeWindow : undefined;
}

function applyPreferencePatch(profile, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ReplannerError('Preference patch must be an object');
  }
  const allowedKeys = new Set([
    'timeStart',
    'timeEnd',
    'location',
    'dateRange',
    'addSoftPreference',
    'addHardConstraint',
  ]);
  const unsupported = Object.keys(patch).filter((key) => !allowedKeys.has(key));
  if (unsupported.length > 0) {
    throw new ReplannerError('Preference patch contains unsupported fields', unsupported);
  }

  const before = profileForValidation(profile);
  const raw = structuredClone(before);
  raw.searchScope = {
    ...(raw.searchScope ?? {}),
    source: 'replanner',
    isExplicit: true,
    ...(patch.location ? { location: patch.location } : {}),
    ...(patch.dateRange ? { dateRange: patch.dateRange } : {}),
  };
  const timeWindow = patchedTimeWindow(raw.searchScope, patch);
  if (timeWindow) raw.searchScope.timeWindow = timeWindow;
  if (patch.addSoftPreference) {
    raw.preferences = [
      ...(raw.preferences ?? []),
      {
        ...patch.addSoftPreference,
        type: 'soft',
        source: 'replanner',
        isExplicit: false,
      },
    ];
  }
  if (patch.addHardConstraint) {
    raw.hardConstraints = [
      ...(raw.hardConstraints ?? []),
      {
        ...patch.addHardConstraint,
        type: 'hard',
        relaxable: false,
        source: 'replanner',
        isExplicit: false,
      },
    ];
  }

  const normalized = validatePreferenceProfile(normalizePreferenceProfile(raw, {
    sourceText: before.sourceText,
    updatedAt: new Date().toISOString(),
  }));
  if (!hasHardConstraintSubset(before.hardConstraints ?? [], normalized.hardConstraints ?? [])) {
    throw new ReplannerError('Preference patch cannot remove existing hard constraints');
  }
  return {
    ...profile,
    ...normalized,
    searchScope: {
      ...(profile.searchScope ?? {}),
      ...(normalized.searchScope ?? {}),
    },
  };
}

function applyPreferencePatchToState(state, patch) {
  const preferences = applyPreferencePatch(state.preferences, patch);
  return {
    ...state,
    preferences,
    searchScope: {
      ...state.searchScope,
      ...(preferences.searchScope ?? {}),
      temporalWindow: {
        ...(state.searchScope?.temporalWindow ?? {}),
        ...(patch.timeStart ? { timeStart: patch.timeStart } : {}),
        ...(patch.timeEnd ? { timeEnd: patch.timeEnd } : {}),
      },
    },
    candidates: [],
    rejectedCandidates: [],
  };
}

function validateFactualObservations(factualObservations = {}) {
  if (!factualObservations || typeof factualObservations !== 'object' || Array.isArray(factualObservations)) {
    throw new ReplannerError('factualObservations must be an object', ['factualObservations must be an object']);
  }

  const issues = [];
  const venues = factualObservations.maps?.venues ?? factualObservations.venues ?? [];
  if (venues !== undefined && !Array.isArray(venues)) {
    issues.push('maps.venues must be an array when provided');
  }

  if (Array.isArray(venues)) {
    venues.forEach((venue, index) => {
      const status = venue.availability?.status;
      if (status !== undefined && !['verified', 'unknown'].includes(status)) {
        issues.push(`maps.venues[${index}].availability.status must be verified or unknown`);
      }
      const travel = venue.travel ?? venue.features?.venue?.travel ?? null;
      if (travel?.durationMinutes !== null
        && travel?.durationMinutes !== undefined
        && !Number.isFinite(travel.durationMinutes)) {
        issues.push(`maps.venues[${index}].travel.durationMinutes must be numeric or null`);
      }
    });
  }

  if (issues.length > 0) throw new ReplannerError('Invalid factual observations', issues);
  return factualObservations;
}

function evaluateReplanningContext(state, {
  minCandidates = 1,
  rankerResult = {},
  factualCandidateFeatures = [],
} = {}) {
  const validState = validateAgentState(state);
  const factualObservations = validateFactualObservations(validState.factualObservations);
  return evaluateCandidateSet({
    candidates: validState.candidates,
    rejectedCandidates: validState.rejectedCandidates,
    preferences: validState.preferences,
    rankerResult,
    factualCandidateFeatures,
    failedConstraints: validState.failedConstraints,
    factualObservations,
    actionsTaken: validState.actionsTaken,
    minCandidates,
  });
}

function recordAction(state, action) {
  return {
    ...state,
    actionsTaken: [
      ...state.actionsTaken,
      {
        ...action,
        iteration: state.iteration,
      },
    ],
  };
}

async function executeReplanningAction(state, action, { savedAreasPath } = {}) {
  const currentState = validateAgentState(state);
  const validatedAction = validateBoundedRealReplanningAction(action);

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.SATISFACTORY) {
    return validateAgentState({
      ...recordAction(currentState, validatedAction),
      status: 'SATISFACTORY',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.ASK_USER) {
    return validateAgentState({
      ...recordAction(currentState, validatedAction),
      status: 'ASKING_USER',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.STOP) {
    return validateAgentState({
      ...recordAction(currentState, validatedAction),
      status: 'STOPPED',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.EXPAND_RADIUS) {
    const expanded = expandSearchRadius(currentState);
    return validateAgentState({
      ...recordAction(expanded, validatedAction),
      iteration: currentState.iteration + 1,
      status: 'READY',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS) {
    const expanded = includeNonPreferredCourts(currentState);
    return validateAgentState({
      ...recordAction(expanded, validatedAction),
      iteration: currentState.iteration + 1,
      status: 'READY',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.SHIFT_TIME_WINDOW) {
    const shifted = shiftTimeWindow(currentState);
    return validateAgentState({
      ...recordAction(shifted, validatedAction),
      iteration: currentState.iteration + 1,
      status: 'READY',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.EXPAND_VENUE_SET) {
    const expanded = expandVenueSet(currentState);
    return validateAgentState({
      ...recordAction(expanded, validatedAction),
      iteration: currentState.iteration + 1,
      status: 'READY',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.SEARCH_OTHER_VENUES) {
    const expanded = expandVenueSet(currentState);
    return validateAgentState({
      ...recordAction(expanded, validatedAction),
      iteration: currentState.iteration + 1,
      status: 'READY',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.REINTERPRET_PREFERENCES) {
    const patched = applyPreferencePatchToState(currentState, validatedAction.parameters.patch);
    return validateAgentState({
      ...recordAction(patched, validatedAction),
      iteration: currentState.iteration + 1,
      status: 'READY',
    });
  }

  if (validatedAction.selectedAction === REPLANNING_ACTIONS.SWITCH_SEARCH_AREA) {
    const targetAreaId = validatedAction.parameters.targetAreaId;
    const switched = await switchSearchArea(currentState, targetAreaId, { savedAreasPath });
    return validateAgentState({
      ...recordAction(switched, validatedAction),
      iteration: currentState.iteration + 1,
      status: 'READY',
    });
  }

  throw new ReplannerError(`Unsupported action: ${validatedAction.selectedAction}`);
}

async function refreshObservedState(state, observe) {
  if (!observe) return validateAgentState(state);
  const observed = await observe(validateAgentState(state));
  return validateAgentState({
    ...state,
    ...observed,
    goal: state.goal,
    preferences: state.preferences,
    searchScope: observed?.searchScope ?? state.searchScope,
    candidates: observed?.candidates ?? state.candidates,
    rejectedCandidates: observed?.rejectedCandidates ?? state.rejectedCandidates,
    failedConstraints: observed?.failedConstraints ?? state.failedConstraints,
    factualObservations: observed?.factualObservations ?? state.factualObservations,
    actionsTaken: observed?.actionsTaken ?? state.actionsTaken,
    iteration: observed?.iteration ?? state.iteration,
    status: observed?.status ?? state.status,
  });
}

function compactState(state) {
  const providerScope = state.searchScope?.providerScope ?? {};
  return {
    status: state.status,
    iteration: state.iteration,
    candidateCount: state.candidates.length,
    rejectedCandidateCount: state.rejectedCandidates.length,
    radiusMeters: state.searchScope?.radiusMeters ?? null,
    timeWindow: state.searchScope?.timeWindow ?? null,
    activeAreaId: state.searchScope?.activeAreaId ?? null,
    activeProviderIds: providerScope.activeProviderIds ?? [],
    observedProviderIds: providerScope.observedProviderIds ?? [],
    includeNonPreferredCourts: state.searchScope?.courtScope?.includeNonPreferred === true,
  };
}

function assertHardConstraintsUnchanged(before, after) {
  if (!hasHardConstraintSubset(
    before.preferences?.hardConstraints ?? [],
    after.preferences?.hardConstraints ?? [],
  )) {
    throw new ReplannerError('Existing hard constraints changed during replanning');
  }
}

function applyDeterministicHardFilter(state) {
  const current = validateAgentState(state);
  const filtered = applyHardConstraints({
    candidates: current.candidates,
    preferenceProfile: current.preferences,
  });

  return validateAgentState({
    ...current,
    candidates: filtered.accepted,
    rejectedCandidates: [
      ...current.rejectedCandidates,
      ...filtered.rejected,
    ],
  });
}

async function evaluateCurrentCandidateSet(state, {
  minCandidates = 1,
  rankerProvider = null,
  rankerTimeoutMs,
} = {}) {
  const rankerResult = await rankCandidates({
    preferenceProfile: state.preferences,
    candidates: state.candidates,
    provider: rankerProvider,
    timeoutMs: rankerTimeoutMs,
  });
  const factualCandidateFeatures = buildRankerInput({
    preferenceProfile: state.preferences,
    candidates: state.candidates,
  }).candidates;
  const evaluation = evaluateReplanningContext(state, {
    minCandidates,
    rankerResult,
    factualCandidateFeatures,
  });

  return {
    evaluation,
    rankerResult,
    factualCandidateFeatures,
  };
}

async function runReplanningLoop(initialState, {
  provider,
  observe,
  rankerProvider = null,
  rankerTimeoutMs,
  maxIterations = 3,
  minCandidates = 1,
  savedAreasPath,
} = {}) {
  const validatedInitialState = validateAgentState(initialState);
  const initialHardConstraints = structuredClone(validatedInitialState.preferences?.hardConstraints ?? []);
  let observedState = await refreshObservedState(validatedInitialState, observe);
  let observedCandidateCount = observedState.candidates.length;
  let state = applyDeterministicHardFilter(observedState);
  const iterations = [];
  let latestRanking = { rankedCandidates: [], rankingMode: null };

  while (true) {
    if (state.iteration >= maxIterations) {
      return {
        status: 'MAX_ITERATIONS_REACHED',
        state: validateAgentState({
          ...state,
          status: 'MAX_ITERATIONS_REACHED',
        }),
        iterations,
        rankedCandidates: latestRanking.rankedCandidates,
        rankingMode: latestRanking.rankingMode,
      };
    }

    const {
      evaluation,
      rankerResult,
      factualCandidateFeatures,
    } = await evaluateCurrentCandidateSet(state, {
      minCandidates,
      rankerProvider,
      rankerTimeoutMs,
    });
    latestRanking = rankerResult;
    const diagnostics = buildDiagnosticSnapshot(state, evaluation, { observedCandidateCount });
    const observation = buildReplanningObservation(state, {
      evaluation,
      diagnostics,
      observedCandidateCount,
    });
    const stateBefore = compactState(state);
    const decision = await chooseReplanningDecision(state, {
      provider,
      maxIterations,
      evaluation,
      diagnostics,
      observation,
      validateAction: (action) => validateActionForState(state, action, {
        evaluation,
        savedAreasPath,
      }),
    });
    const action = decision.action;

    const nextState = await executeReplanningAction(state, action, { savedAreasPath });
    assertHardConstraintsUnchanged(
      { preferences: { hardConstraints: initialHardConstraints } },
      nextState,
    );
    iterations.push({
      iteration: state.iteration,
      source: decision.source,
      action,
      reason: action.rationale,
      validationFailure: decision.validationFailure,
      diagnosticsSummary: diagnostics,
      observation,
      stateBefore,
      stateAfter: compactState(nextState),
      evaluation,
      searchScope: state.searchScope,
      candidateCount: state.candidates.length,
      rankedCandidates: rankerResult.rankedCandidates,
      factualCandidateFeatures,
    });
    if (['SATISFACTORY', 'ASKING_USER', 'STOPPED'].includes(nextState.status)) {
      return {
        status: nextState.status,
        state: nextState,
        iterations,
        rankedCandidates: latestRanking.rankedCandidates,
        rankingMode: latestRanking.rankingMode,
      };
    }

    observedState = await refreshObservedState(nextState, observe);
    assertHardConstraintsUnchanged(
      { preferences: { hardConstraints: initialHardConstraints } },
      observedState,
    );
    observedCandidateCount = observedState.candidates.length;
    state = applyDeterministicHardFilter(observedState);
  }
}

export {
  ReplannerError,
  evaluateReplanningContext,
  executeReplanningAction,
  evaluateCurrentCandidateSet,
  applyPreferencePatch,
  runReplanningLoop,
  validateBoundedRealReplanningAction,
  validateActionForState,
  validateFactualObservations,
};
