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
    searchScope: { days: 7 },
    transportPreference: {},
    weatherPreference: { avoidBadWeather: true, source: 'default', userOverride: false },
    preferences: soft,
    hardConstraints: hard,
    objectives: [],
    unresolvedPreferences: [],
    sourceText: 'synthetic request',
    updatedAt: '2026-09-20T00:00:00.000+10:00',
  };
}

function candidate({
  id = 'candidate-1',
  court = 'Court 4',
  nextHourFree = true,
  startTime = '2026-09-20T08:00:00.000Z',
  localTime = '18:00',
} = {}) {
  return {
    id,
    venue: 'SUSF',
    court,
    startTime,
    durationMinutes: 60,
    features: { localTime, nextHourFree, price: 20 },
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

test('agent loop can locally reinterpret an omitted explicit lower time bound', async () => {
  const current = agentState({
    goal: '明早我想打球，十点后',
    preferences: preferences({
      hard: [{
        feature: 'start_time',
        type: 'hard',
        importance: 'medium',
        priority: 'medium',
        relaxable: false,
        rule: { period: 'morning' },
        sourceText: '明早',
        source: 'user',
        isExplicit: true,
      }],
    }),
    searchScope: {
      days: 1,
      timeWindow: { period: 'morning' },
      temporalWindow: { dateStart: '2026-09-22', dateEnd: '2026-09-22', timeStart: '06:00', timeEnd: '12:00' },
      providerScope: { activeProviderIds: ['fixture'], expandableProviderIds: ['fixture'], observedProviderIds: [] },
    },
  });

  const result = await runReplanningLoop(current, {
    minCandidates: 1,
    provider: {
      async choose(input) {
        assert.equal(input.originalRequest, '明早我想打球，十点后');
        assert.equal(input.observation.searchScope.temporalWindow.timeStart, '06:00');
        return action(
          REPLANNING_ACTIONS.REINTERPRET_PREFERENCES,
          'The user explicitly said after 10am, but the current interpreted window starts too early.',
          { patch: { timeStart: '10:00' } },
        );
      },
    },
    observe: async (observedState) => (
      observedState.searchScope?.temporalWindow?.timeStart === '10:00'
        ? {
          candidates: [candidate({
            id: 'after-10',
            startTime: '2026-09-22T01:00:00.000Z',
            localTime: '11:00',
          })],
          searchScope: observedState.searchScope,
        }
        : { candidates: [], searchScope: observedState.searchScope }
    ),
  });

  assert.equal(result.status, 'SATISFACTORY');
  assert.equal(result.iterations[0].action.selectedAction, REPLANNING_ACTIONS.REINTERPRET_PREFERENCES);
  assert.equal(result.state.searchScope.temporalWindow.timeStart, '10:00');
  assert.equal(result.state.preferences.searchScope.timeWindow.after, '10:00');
});

test('LLM can choose SEARCH_OTHER_VENUES for bad location/provider scope instead of relaxing price', async () => {
  const current = agentState({
    goal: '我住 Zetland，最近几天想找便宜点的球场',
    preferences: preferences({
      soft: [{
        feature: 'price',
        type: 'soft',
        importance: 'high',
        priority: 'high',
        relaxable: true,
        direction: 'lower',
        sourceText: '便宜点',
      }],
    }),
    searchScope: {
      location: 'Zetland',
      locationSource: 'explicit',
      radiusMeters: 3000,
      providerScope: {
        activeProviderIds: ['susf'],
        expandableProviderIds: ['susf', 'intrac'],
        observedProviderIds: ['susf'],
        failedProviderIds: [],
      },
    },
    candidates: [],
  });

  const result = await runReplanningLoop(current, {
    maxIterations: 1,
    provider: {
      async choose(input) {
        assert.equal(input.observation.searchScope.location, 'Zetland');
        assert.deepEqual(input.observation.searchScope.providerScope.expandableProviderIds, ['susf', 'intrac']);
        return action(
          REPLANNING_ACTIONS.SEARCH_OTHER_VENUES,
          'The provider scope is likely too narrow for the explicit Zetland location.',
        );
      },
    },
  });

  assert.equal(result.status, 'MAX_ITERATIONS_REACHED');
  assert.equal(result.iterations[0].source, 'llm');
  assert.equal(result.iterations[0].action.selectedAction, REPLANNING_ACTIONS.SEARCH_OTHER_VENUES);
  assert.equal(result.iterations[0].action.selectedAction === REPLANNING_ACTIONS.RELAX_PRICE, false);
});

test('two-hour hard requirement is preserved while soft weather weakness can replan without crashing', async () => {
  const hardDuration = {
    feature: 'consecutive_availability',
    type: 'hard',
    importance: 'high',
    priority: 'high',
    relaxable: false,
    rule: { minMinutes: 120 },
    sourceText: '打两个小时',
    source: 'user',
    isExplicit: true,
  };
  const current = agentState({
    goal: '这几天想在 Burwood 打两个小时，25刀左右，不要太晒',
    preferences: preferences({
      hard: [hardDuration],
      soft: [{
        feature: 'weather',
        type: 'soft',
        importance: 'medium',
        priority: 'medium',
        relaxable: true,
        direction: 'preferred',
        rule: { condition: 'comfortable' },
        sourceText: '不要太晒',
      }],
    }),
    searchScope: {
      location: 'Burwood',
      providerScope: { activeProviderIds: ['sportlogic'], expandableProviderIds: ['sportlogic'], observedProviderIds: ['sportlogic'] },
    },
    candidates: [candidate({ id: 'one-hour-only', nextHourFree: false })],
  });

  const result = await runReplanningLoop(current, {
    maxIterations: 1,
    provider: providerReturning(REPLANNING_ACTIONS.ASK_USER),
  });

  assert.equal(result.iterations[0].action.selectedAction, REPLANNING_ACTIONS.ASK_USER);
  assert.deepEqual(result.state.preferences.hardConstraints, [hardDuration]);
  assert.equal(result.state.rejectedCandidates.length, 1);
});

test('recommendation falls back when LLM replanner returns an invalid decision', async () => {
  const result = await recommendCourts({
    request: 'Find a tennis court this week',
    now: new Date('2026-09-20T00:00:00.000+10:00'),
    preferenceProvider: {
      async interpret() {
        return preferences();
      },
    },
    replannerProvider: {
      async choose() {
        return action('NOT_A_REAL_ACTION');
      },
    },
    observeCandidates: async () => ({ candidates: [] }),
    maxIterations: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ASKING_USER');
  assert.equal(result.replanning[0].source, 'heuristic_fallback');
  assert.equal(result.replanning[0].validationFailure.code, 'REPLANNING_ACTION_SCHEMA_ERROR');
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

test('OpenAI replanner retries 429 with bounded Retry-After handling', async () => {
  let calls = 0;
  const waits = [];
  const replannerProvider = createOpenAiReplannerProvider({
    apiKey: 'test-key',
    maxRetries: 2,
    waitImpl: async (ms) => waits.push(ms),
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        return {
          ok: false,
          status: 429,
          headers: { get(name) { return name === 'retry-after' ? '0.01' : null; } },
          async json() { return { error: { type: 'rate_limit_error', code: 'rate_limit' } }; },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: JSON.stringify({ action: 'ASK_USER', reason: 'Need clarification.', parameters: null }) } }] };
        },
      };
    },
  });
  const decision = await replannerProvider.choose({ allowedActions: ['ASK_USER'] });
  assert.equal(decision.selectedAction, 'ASK_USER');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 10]);
});

test('OpenAI replanner stops after bounded 429 retries and preserves safe diagnostics', async () => {
  let calls = 0;
  const replannerProvider = createOpenAiReplannerProvider({
    apiKey: 'test-key',
    maxRetries: 1,
    waitImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: { get() { return null; } },
        async json() { return { error: { type: 'rate_limit_error', code: 'rate_limit', param: null, message: 'slow down' } }; },
      };
    },
  });
  await assert.rejects(
    () => replannerProvider.choose({ allowedActions: ['ASK_USER'] }),
    (error) => error.details?.retryCount === 1 && error.details?.status === 429,
  );
  assert.equal(calls, 2);
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
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties)));
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(schema);
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
