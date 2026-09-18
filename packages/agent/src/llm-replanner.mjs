import { boundedRealReplanningActions } from './actions.mjs';

const DEFAULT_REPLANNER_TIMEOUT_MS = 8000;

class LlmReplannerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LlmReplannerError';
    this.code = code;
  }
}

function replannerOutputJsonSchema(allowedActions = [...boundedRealReplanningActions]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'reason', 'parameters'],
    properties: {
      action: { type: 'string', enum: allowedActions },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      parameters: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['targetAreaId'],
            properties: {
              targetAreaId: { type: 'string', minLength: 1 },
            },
          },
        ],
      },
    },
  };
}

function buildReplannerMessages(input) {
  return [
    {
      role: 'system',
      content: [
        'You are a bounded replanning policy for a tennis recommendation agent.',
        'Your primary objective is to find the best feasible recommendation while preserving every user-defined hard constraint.',
        'Hard constraints are immutable. Never relax, rewrite, or bypass them. If progress requires relaxing one, choose ASK_USER.',
        'Availability, provider coverage, candidate facts, and search state in the input are authoritative; never fabricate them.',
        'Choose exactly one action from allowedActions. Never invent tools or action types.',
        'Use soft-preference performance to choose a search strategy and reason about trade-offs.',
        'Prefer a lower-cost, lower-disruption action when it plausibly addresses the diagnosis, but do not apply a rigid priority order.',
        'For example, when price is weak and providers remain unsearched, exploring another provider may be better than a large radius increase.',
        'Use previousActions and avoid repeating an action that made no progress or is exhausted.',
        'Choose SATISFACTORY when the current results are good enough.',
        'Choose ASK_USER when clarification or explicit permission to change the acceptable solution space could help.',
        'Choose STOP when no meaningful bounded progress remains and clarification would not help.',
        'Return only strict JSON matching the response schema. The reason must be short. Do not emit tool instructions.',
      ].join(' '),
    },
    { role: 'user', content: JSON.stringify(input) },
  ];
}

function parseReplannerContent(content) {
  if (typeof content !== 'string') {
    throw new LlmReplannerError('LLM_REPLANNER_MALFORMED_OUTPUT', 'LLM replanner output was not a JSON string');
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new LlmReplannerError('LLM_REPLANNER_MALFORMED_OUTPUT', 'LLM replanner output was not valid JSON', { cause: error });
  }
}

function validateProviderDecision(value, allowedActions) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner decision must be an object');
  }
  if (!allowedActions.includes(value.action)) {
    throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner returned an unsupported action');
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner reason must be a non-empty string');
  }
  if (value.parameters !== null && value.parameters !== undefined) {
    if (typeof value.parameters !== 'object' || Array.isArray(value.parameters)) {
      throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner parameters must be an object or null');
    }
    const keys = Object.keys(value.parameters);
    if (keys.some((key) => key !== 'targetAreaId')) {
      throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner parameters contain unsupported keys');
    }
  }
  return value;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new LlmReplannerError(
      'LLM_REPLANNER_TIMEOUT',
      `LLM replanner timed out after ${timeoutMs}ms`,
    )), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function createOpenAiReplannerProvider({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_REPLANNER_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
  timeoutMs = Number(process.env.REPLANNER_TIMEOUT_MS ?? DEFAULT_REPLANNER_TIMEOUT_MS),
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    name: 'openai-bounded-replanner',
    async choose(input) {
      if (!apiKey) {
        throw new LlmReplannerError('LLM_PROVIDER_NOT_CONFIGURED', 'Missing OPENAI_API_KEY for LLM replanning');
      }
      const allowedActions = input.allowedActions ?? [...boundedRealReplanningActions];
      const response = await withTimeout(fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: buildReplannerMessages(input),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'bounded_replanning_decision',
              strict: true,
              schema: replannerOutputJsonSchema(allowedActions),
            },
          },
        }),
      }), timeoutMs);

      if (!response.ok) {
        throw new LlmReplannerError(
          'LLM_PROVIDER_ERROR',
          `OpenAI replanner failed with HTTP ${response.status}`,
        );
      }
      const json = await response.json();
      const decision = validateProviderDecision(
        parseReplannerContent(json?.choices?.[0]?.message?.content),
        allowedActions,
      );
      return {
        selectedAction: decision.action,
        targetPreference: null,
        parameters: decision.parameters ?? {},
        rationale: decision.reason.trim(),
        expectedEffect: 'Apply the selected bounded search action and observe authoritative providers again.',
      };
    },
  };
}

export {
  DEFAULT_REPLANNER_TIMEOUT_MS,
  LlmReplannerError,
  buildReplannerMessages,
  createOpenAiReplannerProvider,
  parseReplannerContent,
  replannerOutputJsonSchema,
};
