const REPLANNING_ACTIONS = Object.freeze({
  EXPAND_RADIUS: 'EXPAND_RADIUS',
  EXPAND_DATE_WINDOW: 'EXPAND_DATE_WINDOW',
  SHIFT_TIME_WINDOW: 'SHIFT_TIME_WINDOW',
  INCLUDE_NONPREFERRED_COURTS: 'INCLUDE_NONPREFERRED_COURTS',
  EXPAND_VENUE_SET: 'EXPAND_VENUE_SET',
  RELAX_PRICE: 'RELAX_PRICE',
  SEARCH_OTHER_VENUES: 'SEARCH_OTHER_VENUES',
  SWITCH_SEARCH_AREA: 'SWITCH_SEARCH_AREA',
  ASK_USER: 'ASK_USER',
  SATISFACTORY: 'SATISFACTORY',
  STOP: 'STOP',
});

const allowedReplanningActions = new Set(Object.values(REPLANNING_ACTIONS));
const boundedRealReplanningActions = new Set([
  REPLANNING_ACTIONS.EXPAND_RADIUS,
  REPLANNING_ACTIONS.INCLUDE_NONPREFERRED_COURTS,
  REPLANNING_ACTIONS.EXPAND_VENUE_SET,
  REPLANNING_ACTIONS.SWITCH_SEARCH_AREA,
  REPLANNING_ACTIONS.ASK_USER,
  REPLANNING_ACTIONS.SATISFACTORY,
  REPLANNING_ACTIONS.STOP,
]);

class ReplanningActionSchemaError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ReplanningActionSchemaError';
    this.code = 'REPLANNING_ACTION_SCHEMA_ERROR';
    this.issues = issues;
  }
}

function validateReplanningAction(action) {
  const issues = [];

  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new ReplanningActionSchemaError('Replanning action must be an object', ['action must be an object']);
  }

  for (const key of Object.keys(action)) {
    if (!['selectedAction', 'targetPreference', 'parameters', 'rationale', 'expectedEffect'].includes(key)) {
      issues.push(`${key} is not allowed`);
    }
  }

  if (!allowedReplanningActions.has(action.selectedAction)) {
    issues.push(`selectedAction must be one of ${[...allowedReplanningActions].join(', ')}`);
  }

  if (action.targetPreference !== null
    && action.targetPreference !== undefined
    && typeof action.targetPreference !== 'string') {
    issues.push('targetPreference must be a string or null');
  }

  if (action.parameters !== undefined
    && (typeof action.parameters !== 'object' || action.parameters === null || Array.isArray(action.parameters))) {
    issues.push('parameters must be an object when provided');
  }

  if (action.parameters) {
    const allowedParameterKeys = action.selectedAction === REPLANNING_ACTIONS.SWITCH_SEARCH_AREA
      ? ['targetAreaId']
      : [];
    for (const key of Object.keys(action.parameters)) {
      if (!allowedParameterKeys.includes(key)) issues.push(`parameters.${key} is not allowed`);
    }
    if (action.selectedAction === REPLANNING_ACTIONS.SWITCH_SEARCH_AREA
      && (typeof action.parameters.targetAreaId !== 'string' || action.parameters.targetAreaId.length === 0)) {
      issues.push('parameters.targetAreaId must be a non-empty string for SWITCH_SEARCH_AREA');
    }
    if (action.selectedAction !== REPLANNING_ACTIONS.SWITCH_SEARCH_AREA
      && Object.keys(action.parameters).length > 0) {
      issues.push('parameters must be empty for this action');
    }
  }

  if (typeof action.rationale !== 'string' || action.rationale.length === 0) {
    issues.push('rationale must be a non-empty string');
  }

  if (typeof action.expectedEffect !== 'string' || action.expectedEffect.length === 0) {
    issues.push('expectedEffect must be a non-empty string');
  }

  if (issues.length > 0) {
    throw new ReplanningActionSchemaError('Invalid replanning action', issues);
  }

  return {
    selectedAction: action.selectedAction,
    targetPreference: action.targetPreference ?? null,
    parameters: action.parameters ?? {},
    rationale: action.rationale,
    expectedEffect: action.expectedEffect,
  };
}

const replanningActionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['selectedAction', 'targetPreference', 'rationale', 'expectedEffect'],
  properties: {
    selectedAction: {
      type: 'string',
      enum: [...allowedReplanningActions],
    },
    targetPreference: {
      type: ['string', 'null'],
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targetAreaId: {
          type: 'string',
        },
      },
    },
    rationale: {
      type: 'string',
    },
    expectedEffect: {
      type: 'string',
    },
  },
};

export {
  REPLANNING_ACTIONS,
  ReplanningActionSchemaError,
  allowedReplanningActions,
  boundedRealReplanningActions,
  replanningActionJsonSchema,
  validateReplanningAction,
};
