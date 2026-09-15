import { REPLANNING_ACTIONS, validateReplanningAction } from './actions.mjs';
import { evaluateCandidateSet } from './evaluator.mjs';
import { canExpandProviderScope } from './provider-scope.mjs';
import { validateAgentState } from './state.mjs';

function actionForWeakPreference(preference) {
  if (preference?.feature === 'price') return REPLANNING_ACTIONS.EXPAND_RADIUS;
  if (preference?.feature === 'start_time') return REPLANNING_ACTIONS.ASK_USER;
  if (preference?.feature === 'court') return REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS;
  if (preference?.feature === 'venue') return REPLANNING_ACTIONS.EXPAND_VENUE_SET;
  if (preference?.feature === 'travel_time') return REPLANNING_ACTIONS.ASK_USER;
  if (preference?.feature === 'consecutive_availability') return REPLANNING_ACTIONS.EXPAND_RADIUS;
  if (preference?.feature === 'duration') return REPLANNING_ACTIONS.EXPAND_RADIUS;
  if (preference?.feature === 'next_hour_free') return REPLANNING_ACTIONS.EXPAND_RADIUS;
  return REPLANNING_ACTIONS.ASK_USER;
}

function actionWasTried(state, action) {
  return (state.actionsTaken ?? []).some((entry) => entry.selectedAction === action);
}

function broadNoCandidateSearchAlreadyTried(state) {
  const triedRadius = actionWasTried(state, REPLANNING_ACTIONS.EXPAND_RADIUS);
  const triedDate = actionWasTried(state, REPLANNING_ACTIONS.EXPAND_DATE_WINDOW);
  const triedOtherVenues = actionWasTried(state, REPLANNING_ACTIONS.SEARCH_OTHER_VENUES)
    || actionWasTried(state, REPLANNING_ACTIONS.EXPAND_VENUE_SET);
  return triedRadius && triedDate && triedOtherVenues;
}

function locationNeedsUserClarification(state = {}) {
  const status = state.searchScope?.locationRouting?.status;
  return status === 'unresolved'
    || status === 'no_provider_coverage';
}

function failedConstraintCodes(evaluation = {}) {
  return new Set((evaluation.failedConstraints ?? []).map((failure) => {
    if (typeof failure === 'string') return failure;
    return failure.code ?? failure.reason ?? failure.feature ?? null;
  }).filter(Boolean));
}

function relaxableSoftPreference(state, feature) {
  return (state.preferences?.preferences ?? [])
    .some((preference) => preference.feature === feature && preference.relaxable !== false);
}

function canIncludeNonPreferredCourts(state) {
  return relaxableSoftPreference(state, 'court')
    && state.searchScope?.courtScope?.includeNonPreferred !== true;
}

function diagnoseFailureModes(state, evaluation) {
  const codes = failedConstraintCodes(evaluation);
  const modes = [];

  if (codes.has('preferred_courts_unavailable') && canIncludeNonPreferredCourts(state)) {
    modes.push({
      code: 'PREFERRED_COURTS_UNAVAILABLE',
      action: REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS,
      targetPreference: 'court',
      rationale: 'The observed failure is specific to preferred courts, and the court preference is soft and relaxable.',
      expectedEffect: 'Include non-preferred courts while preserving hard constraints.',
    });
  }

  if (codes.has('no_availability_in_time_window')) {
    modes.push({
      code: 'NO_AVAILABILITY_IN_TIME_WINDOW',
      action: REPLANNING_ACTIONS.SHIFT_TIME_WINDOW,
      targetPreference: 'start_time',
      rationale: 'The observed failure is specific to the searched time window.',
      expectedEffect: 'Move or expand the searched interval only inside hard start-time bounds; never cross a hard temporal boundary.',
    });
  }

  return modes;
}

function actionForFailureMode(mode) {
  return {
    selectedAction: mode.action,
    targetPreference: mode.targetPreference,
    rationale: mode.rationale,
    expectedEffect: mode.expectedEffect,
  };
}

function heuristicReplanningAction(state, evaluation) {
  if (evaluation.satisfactory) {
    return {
      selectedAction: REPLANNING_ACTIONS.SATISFACTORY,
      targetPreference: null,
      rationale: 'The current candidate set is satisfactory.',
      expectedEffect: 'Return the current best candidates without further replanning.',
    };
  }

  if (state.candidates.length === 0) {
    const [diagnosedMode] = diagnoseFailureModes(state, evaluation);
    if (diagnosedMode) return actionForFailureMode(diagnosedMode);

    if (locationNeedsUserClarification(state)) {
      return {
        selectedAction: REPLANNING_ACTIONS.ASK_USER,
        targetPreference: 'area',
        rationale: 'The target area could not be resolved to a reliable geographic provider scope.',
        expectedEffect: 'Ask the user to clarify the area or choose a broader search area before searching farther.',
      };
    }

    if (broadNoCandidateSearchAlreadyTried(state)) {
      return {
        selectedAction: REPLANNING_ACTIONS.ASK_USER,
        targetPreference: null,
        rationale: 'The broad automatic no-candidate search expansions have already been attempted.',
        expectedEffect: 'Ask the user which major trade-off they are willing to make next.',
      };
    }

    if (state.searchScope?.providerScope && canExpandProviderScope(state.searchScope.providerScope)) {
      return {
        selectedAction: REPLANNING_ACTIONS.EXPAND_VENUE_SET,
        targetPreference: null,
        rationale: 'No candidates are currently available from the observed provider scope.',
        expectedEffect: 'Add the next configured public availability provider without inventing venues or URLs.',
      };
    }

    return {
      selectedAction: REPLANNING_ACTIONS.EXPAND_RADIUS,
      targetPreference: null,
      rationale: 'No candidates are currently available in the search scope.',
      expectedEffect: 'Search a wider nearby venue radius while preserving hard constraints.',
    };
  }

  const weakPreference = evaluation.weakPreferences.find((preference) => preference.relaxable);
  if (!weakPreference) {
    return {
      selectedAction: REPLANNING_ACTIONS.ASK_USER,
      targetPreference: null,
      rationale: 'The weak preferences are not relaxable by policy.',
      expectedEffect: 'Ask the user which trade-off they are willing to make.',
    };
  }

  return {
    selectedAction: actionForWeakPreference(weakPreference),
    targetPreference: weakPreference.feature,
    rationale: `The current candidates are weak on ${weakPreference.feature}.`,
    expectedEffect: 'Relax one soft preference or alter the search scope without changing hard constraints.',
  };
}

async function chooseReplanningAction(state, {
  provider,
  maxIterations = 3,
  evaluation = evaluateCandidateSet({
    candidates: state.candidates,
    rejectedCandidates: state.rejectedCandidates,
    preferences: state.preferences,
    failedConstraints: state.failedConstraints,
  }),
} = {}) {
  validateAgentState(state);

  if (state.iteration >= maxIterations) {
    return validateReplanningAction({
      selectedAction: REPLANNING_ACTIONS.STOP,
      targetPreference: null,
      rationale: 'Maximum replanning iterations reached.',
      expectedEffect: 'Stop to avoid an infinite replanning loop.',
    });
  }

  if (provider) {
    const proposedAction = await provider.choose({ state, evaluation });
    return validateReplanningAction(proposedAction);
  }

  return validateReplanningAction(heuristicReplanningAction(state, evaluation));
}

export {
  chooseReplanningAction,
  heuristicReplanningAction,
};
