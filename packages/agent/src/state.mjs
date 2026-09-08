const allowedAgentStatuses = new Set([
  'READY',
  'SATISFACTORY',
  'NEEDS_REPLANNING',
  'ASKING_USER',
  'STOPPED',
  'MAX_ITERATIONS_REACHED',
]);

class AgentStateSchemaError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'AgentStateSchemaError';
    this.code = 'AGENT_STATE_SCHEMA_ERROR';
    this.issues = issues;
  }
}

function createInitialAgentState({
  goal,
  preferences,
  searchScope = {},
  candidates = [],
  rejectedCandidates = [],
  failedConstraints = [],
  factualObservations = {},
  actionsTaken = [],
  iteration = 0,
  status = 'READY',
} = {}) {
  return validateAgentState({
    goal,
    preferences,
    searchScope,
    candidates,
    rejectedCandidates,
    failedConstraints,
    factualObservations,
    actionsTaken,
    iteration,
    status,
  });
}

function validateAgentState(state) {
  const issues = [];

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new AgentStateSchemaError('Agent state must be an object', ['state must be an object']);
  }

  for (const key of Object.keys(state)) {
    if (![
      'goal',
      'preferences',
      'searchScope',
      'candidates',
      'rejectedCandidates',
      'failedConstraints',
      'factualObservations',
      'actionsTaken',
      'iteration',
      'status',
    ].includes(key)) {
      issues.push(`${key} is not allowed`);
    }
  }

  if (typeof state.goal !== 'string' || state.goal.length === 0) {
    issues.push('goal must be a non-empty string');
  }

  if (!state.preferences || typeof state.preferences !== 'object' || Array.isArray(state.preferences)) {
    issues.push('preferences must be an object');
  }

  if (!state.searchScope || typeof state.searchScope !== 'object' || Array.isArray(state.searchScope)) {
    issues.push('searchScope must be an object');
  }

  for (const key of ['candidates', 'rejectedCandidates', 'failedConstraints', 'actionsTaken']) {
    if (!Array.isArray(state[key])) issues.push(`${key} must be an array`);
  }

  if (!state.factualObservations
    || typeof state.factualObservations !== 'object'
    || Array.isArray(state.factualObservations)) {
    issues.push('factualObservations must be an object');
  }

  if (!Number.isInteger(state.iteration) || state.iteration < 0) {
    issues.push('iteration must be a non-negative integer');
  }

  if (!allowedAgentStatuses.has(state.status)) {
    issues.push(`status must be one of ${[...allowedAgentStatuses].join(', ')}`);
  }

  if (issues.length > 0) {
    throw new AgentStateSchemaError('Invalid agent state', issues);
  }

  return state;
}

export {
  AgentStateSchemaError,
  allowedAgentStatuses,
  createInitialAgentState,
  validateAgentState,
};
