import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLANNING_ACTIONS,
  buildDiagnosticSnapshot,
  buildReplannerMessages,
  chooseReplanningDecision,
  createInitialAgentState,
  createOpenAiReplannerProvider,
  evaluateCandidateSet,
  replannerOutputJsonSchema,
  recommendCourts,
  runReplanningLoop,
  validateActionForState,
} from '../packages/agent/src/index.mjs';

function preferences({ soft = [], hard = [] } = {}) {
  return {
    version: 2,
    searchWindowDays: 7,
    preferences: soft,
    hardConstraints: hard,
    objectives: [],
    unresolvedPreferences: [],
  };
}

function candidate({ id = 'candidate-1', court = 'Court 4', nextHourFree = true } = {}) {
  return {
    id,
    venue: 'SUSF',
    court,
    startTime: '2026-09-20T08:00:00.000Z',
    durationMinutes: 60,
    features: { localTime: '18:00', nextHourFree, price: 20 },
  };
}

function agentState(overrides = {}) {
  return createInitialAgentState({
    goal: 'find a tennis court',
    preferences: preferences(),
    searchScope: {
      radiusMeters: 3000,
      courtScope: { includeNonPreferred: false },
      providerScope: {
        activeProviderIds: ['susf'],
        expandableProviderIds: ['susf', 'bookable'],
        observedProviderIds: ['susf'],
        failedProviderIds: [],
      },
    },
    candidates: [],
    rejectedCandidates: [],
    failedConstraints: [],
    factualObservations: {},
    actionsTaken: [],
    iteration: 0,
    status: 'READY',
    ...overrides,
  });
}

function action(selectedAction, rationale = 'Bounded test decision.', parameters = {}) {
  return {
    selectedAction,
    targetPreference: null,
    parameters,
    rationale,
    expectedEffect: 'Observe the bounded search state again.',
  };
}

function providerReturning(selectedAction, parameters = {}) {
  return { async choose() { return action(selectedAction, 'Model-selected bounded action.', parameters); } };
}

test('LLM replanner input is compact, structured, and includes search history', async () => {
  const current = agentState();
  const evaluation = evaluateCandidateSet({ candidates: [], preferences: current.preferences });
  const diagnostics = buildDiagnosticSnapshot(current, evaluation, { observedCandidateCount: 4 });
  let received;
  const decision = await chooseReplanningDecision(current, {
    evaluation,
    diagnostics,
    provider: {
      async choose(input) {
        received = input;
        return action(REPLANNING_ACTIONS.EXPAND_VENUE_SET);
      },
    },
    validateAction: (value) => validateActionForState(current, value, { evaluation }),
  });

  assert.equal(decision.source, 'llm');
  assert.equal(decision.action.selectedAction, REPLANNING_ACTIONS.EXPAND_VENUE_SET);
  assert.equal(received.goal, current.goal);
  assert.equal(received.diagnostics.candidateCounts.observed, 4);
  assert.deepEqual(received.diagnostics.searchCoverage.availableProviders, ['bookable']);
  assert.ok(received.allowedActions.includes(REPLANNING_ACTIONS.ASK_USER));
  assert.equal('candidates' in received.diagnostics, false);
});

test('preferred courts unavailable can include non-preferred courts', async () => {
  const current = agentState({
    preferences: preferences({ soft: [{ feature: 'court', value: 'Court 4', importance: 'high', relaxable: true }] }),
  });
  const evaluation = evaluateCandidateSet({ candidates: [], preferences: current.preferences });
  const decision = await chooseReplanningDecision(current, {
    evaluation,
    provider: providerReturning(REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS),
    validateAction: (value) => validateActionForState(current, value, { evaluation }),
  });
  assert.equal(decision.source, 'llm');
  assert.equal(decision.action.selectedAction, REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS);
});

test('hard start-time bounds survive an LLM time-window shift', async () => {
  const hardConstraint = {
    feature: 'start_time',
    type: 'hard',
    rule: { after: '17:00' },
    relaxable: false,
  };
  const current = agentState({ preferences: preferences({ hard: [hardConstraint] }) });
  const result = await runReplanningLoop(current, {
    provider: {
      async choose({ state }) {
        return state.iteration === 0
          ? action(REPLANNING_ACTIONS.SHIFT_TIME_WINDOW)
          : action(REPLANNING_ACTIONS.ASK_USER);
      },
    },
    observe: async (state) => ({
      candidates: [],
      // An observation is not authorized to rewrite preferences.
      preferences: preferences(),
      searchScope: state.searchScope,
    }),
  });
  assert.deepEqual(result.state.preferences.hardConstraints, [hardConstraint]);
  assert.deepEqual(result.state.searchScope.timeWindow, { after: '17:00' });
});

test('unresolved location can lead the LLM to ASK_USER', async () => {
  const current = agentState({
    searchScope: {
      locationRouting: { status: 'unresolved' },
      providerScope: { activeProviderIds: [], expandableProviderIds: [] },
    },
  });
  const evaluation = evaluateCandidateSet({ candidates: [] });
  const decision = await chooseReplanningDecision(current, {
    evaluation,
    provider: providerReturning(REPLANNING_ACTIONS.ASK_USER),
    validateAction: (value) => validateActionForState(current, value, { evaluation }),
  });
  assert.equal(decision.action.selectedAction, REPLANNING_ACTIONS.ASK_USER);
});

test('LLM may STOP when no meaningful bounded progress remains', async () => {
  const current = agentState({
    searchScope: {
      radiusMeters: 12000,
      courtScope: { includeNonPreferred: true },
      providerScope: { activeProviderIds: ['susf'], expandableProviderIds: ['susf'], observedProviderIds: ['susf'] },
    },
  });
  const evaluation = evaluateCandidateSet({ candidates: [] });
  const decision = await chooseReplanningDecision(current, {
    evaluation,
    provider: providerReturning(REPLANNING_ACTIONS.STOP),
    validateAction: (value) => validateActionForState(current, value, { evaluation }),
  });
  assert.equal(decision.source, 'llm');
  assert.equal(decision.action.selectedAction, REPLANNING_ACTIONS.STOP);
});

test('satisfactory candidates are terminated by an LLM SATISFACTORY decision', async () => {
  const current = agentState({ candidates: [candidate()] });
  const result = await runReplanningLoop(current, {
    provider: providerReturning(REPLANNING_ACTIONS.SATISFACTORY),
  });
  assert.equal(result.status, 'SATISFACTORY');
  assert.equal(result.iterations[0].source, 'llm');
});

test('unsupported LLM action is rejected and recorded before heuristic fallback', async () => {
  const current = agentState();
  const result = await runReplanningLoop(current, {
    provider: { async choose() { return action('INVENTED_TOOL_ACTION'); } },
    maxIterations: 1,
  });
  assert.equal(result.iterations[0].source, 'heuristic_fallback');
  assert.equal(result.iterations[0].action.selectedAction, REPLANNING_ACTIONS.EXPAND_VENUE_SET);
  assert.equal(result.iterations[0].validationFailure.code, 'REPLANNING_ACTION_SCHEMA_ERROR');
});

test('malformed OpenAI JSON throws a provider error that policy can fall back from', async () => {
  const replannerProvider = createOpenAiReplannerProvider({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: '{bad json' } }] }; },
    }),
  });
  const current = agentState();
  const evaluation = evaluateCandidateSet({ candidates: [] });
  const decision = await chooseReplanningDecision(current, {
    evaluation,
    provider: replannerProvider,
    validateAction: (value) => validateActionForState(current, value, { evaluation }),
  });
  assert.equal(decision.source, 'heuristic_fallback');
  assert.equal(decision.validationFailure.code, 'LLM_REPLANNER_MALFORMED_OUTPUT');
});

test('provider exception uses heuristic fallback', async () => {
  const current = agentState();
  const evaluation = evaluateCandidateSet({ candidates: [] });
  const decision = await chooseReplanningDecision(current, {
    evaluation,
    provider: { async choose() { throw new Error('provider offline'); } },
    validateAction: (value) => validateActionForState(current, value, { evaluation }),
  });
  assert.equal(decision.source, 'heuristic_fallback');
  assert.match(decision.validationFailure.message, /provider offline/);
});

test('repeated exhausted action is rejected by state compatibility validation', async () => {
  const current = agentState({
    actionsTaken: [{ ...action(REPLANNING_ACTIONS.SHIFT_TIME_WINDOW), iteration: 0 }],
    iteration: 1,
  });
  const evaluation = evaluateCandidateSet({ candidates: [] });
  await assert.rejects(
    () => validateActionForState(current, action(REPLANNING_ACTIONS.SHIFT_TIME_WINDOW), { evaluation }),
    /already attempted/,
  );
});

test('incompatible provider expansion falls back to ASK_USER instead of throwing', async () => {
  const current = agentState({
    searchScope: {
      radiusMeters: 12000,
      courtScope: { includeNonPreferred: true },
      providerScope: { activeProviderIds: ['susf'], expandableProviderIds: ['susf'], observedProviderIds: ['susf'] },
    },
  });
  const result = await runReplanningLoop(current, {
    provider: providerReturning(REPLANNING_ACTIONS.EXPAND_VENUE_SET),
  });
  assert.equal(result.status, 'ASKING_USER');
  assert.equal(result.iterations[0].source, 'heuristic_fallback');
  assert.match(result.iterations[0].validationFailure.message, /provider expansion remains/);
});

test('prompt and strict output schema expose only bounded decisions', () => {
  const schema = replannerOutputJsonSchema([REPLANNING_ACTIONS.ASK_USER, REPLANNING_ACTIONS.STOP]);
  const messages = buildReplannerMessages({ allowedActions: schema.properties.action.enum });
  assert.deepEqual(schema.properties.action.enum, [REPLANNING_ACTIONS.ASK_USER, REPLANNING_ACTIONS.STOP]);
  assert.equal(schema.additionalProperties, false);
  assert.match(messages[0].content, /Hard constraints are immutable/);
  assert.match(messages[0].content, /avoid repeating/);
});

test('production recommendation entry actually invokes the configured LLM replanner', async () => {
  let replannerCalls = 0;
  const result = await recommendCourts({
    request: 'Find a tennis court this week',
    now: new Date('2026-09-18T00:00:00.000Z'),
    preferenceProvider: {
      async interpret() {
        return {
          version: 2,
          searchWindowDays: 7,
          searchScope: { days: 7 },
          preferences: [],
          hardConstraints: [],
          objectives: [],
          unresolvedPreferences: [],
        };
      },
    },
    replannerProvider: {
      async choose() {
        replannerCalls += 1;
        return action(REPLANNING_ACTIONS.ASK_USER, 'No scoped provider is currently available.');
      },
    },
    observeCandidates: async () => ({ candidates: [] }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ASKING_USER');
  assert.equal(replannerCalls, 1);
  assert.equal(result.replanning[0].source, 'llm');
});
