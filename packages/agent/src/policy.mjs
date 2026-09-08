import { REPLANNING_ACTIONS, validateReplanningAction } from './actions.mjs';
import { evaluateCandidateSet } from './evaluator.mjs';
import { canExpandProviderScope } from './provider-scope.mjs';
import { validateAgentState } from './state.mjs';

function actionForWeakPreference(preference) {
  if (preference?.feature === 'price') return REPLANNING_ACTIONS.RELAX_PRICE;
  if (preference?.feature === 'start_time') return REPLANNING_ACTIONS.SHIFT_TIME_WINDOW;
  if (preference?.feature === 'court') return REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS;
  if (preference?.feature === 'venue') return REPLANNING_ACTIONS.SEARCH_OTHER_VENUES;
  if (preference?.feature === 'travel_time') return REPLANNING_ACTIONS.ASK_USER;
  return REPLANNING_ACTIONS.ASK_USER;
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
