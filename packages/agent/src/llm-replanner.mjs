import { boundedRealReplanningActions } from './actions.mjs';

const DEFAULT_REPLANNER_TIMEOUT_MS = 8000;

class LlmReplannerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LlmReplannerError';
    this.code = code;
    if (options?.details) this.details = options.details;
  }
}

const nullableTime = {
  type: ['string', 'null'],
  pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
};

const nullableString = { type: ['string', 'null'] };

function strictObject(properties) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
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
          strictObject({ targetAreaId: { type: 'string', minLength: 1 } }),
          strictObject({
            patch: strictObject({
              timeStart: nullableTime,
              timeEnd: nullableTime,
              location: nullableString,
              dateRange: {
                anyOf: [
                  { type: 'null' },
                  strictObject({
                    type: nullableString,
                    startDate: nullableString,
                    endDate: nullableString,
                    value: nullableString,
                    sourceText: nullableString,
                  }),
                ],
              },
            }),
          }),
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
        'You are in a Reason -> Act -> Observe -> Reason loop. Read originalRequest, currentState, observation, and diagnostics before choosing.',
        'Treat current interpreted preferences as an initial interpretation that may be locally patched only when observations show it is incomplete, over-narrow, or conflicts with explicit user wording.',
        'Use REINTERPRET_PREFERENCES only for a small local patch. Do not rewrite the whole profile, remove hard constraints, invent facts, or patch prices, distances, weather, availability, or URLs.',
        'Distinguish explicit hard constraints, soft preferences, inferred/default constraints, and system-generated search assumptions. Prefer fixing inferred/default assumptions, provider/search scope, or soft preferences before relaxing user-stated constraints.',
        'Do not choose RELAX_PRICE or EXPAND_RADIUS just because results are poor. First consider parser omissions, merged time expressions, provider scope, location scope, consecutive duration expression, and nearby candidate evidence.',
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
    if (keys.some((key) => !['targetAreaId', 'patch'].includes(key))) {
      throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner parameters contain unsupported keys');
    }
    if (value.action === 'REINTERPRET_PREFERENCES') {
      if (!value.parameters.patch || typeof value.parameters.patch !== 'object' || Array.isArray(value.parameters.patch)) {
        throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner preference patch must be an object');
      }
    } else if (keys.includes('patch')) {
      throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner patch is only valid for REINTERPRET_PREFERENCES');
    }
    if (value.action === 'SWITCH_SEARCH_AREA') {
      if (typeof value.parameters.targetAreaId !== 'string' || value.parameters.targetAreaId.length === 0) {
        throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner targetAreaId must be a non-empty string');
      }
    } else if (keys.includes('targetAreaId')) {
      throw new LlmReplannerError('LLM_REPLANNER_SCHEMA_ERROR', 'LLM replanner targetAreaId is only valid for SWITCH_SEARCH_AREA');
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

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createOpenAiReplannerProvider({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_REPLANNER_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
  timeoutMs = Number(process.env.REPLANNER_TIMEOUT_MS ?? DEFAULT_REPLANNER_TIMEOUT_MS),
  fetchImpl = globalThis.fetch,
  maxRetries = 0,
  retryBaseDelayMs = 500,
  waitImpl = wait,
} = {}) {
  return {
    name: 'openai-bounded-replanner',
    async choose(input) {
      if (!apiKey) {
        throw new LlmReplannerError('LLM_PROVIDER_NOT_CONFIGURED', 'Missing OPENAI_API_KEY for LLM replanning');
      }
      const allowedActions = input.allowedActions ?? [...boundedRealReplanningActions];
      let response;
      let retryCount = 0;
      while (true) {
        response = await withTimeout(fetchImpl('https://api.openai.com/v1/chat/completions', {
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
        if (response.status !== 429 || retryCount >= maxRetries) break;
        const delayMs = retryAfterMs(response) ?? retryBaseDelayMs * (2 ** retryCount);
        retryCount += 1;
        await waitImpl(delayMs);
      }

      if (!response.ok) {
        let providerError = null;
        try {
          providerError = (await response.json())?.error ?? null;
        } catch {}
        throw new LlmReplannerError(
          'LLM_PROVIDER_ERROR',
          `OpenAI replanner failed with HTTP ${response.status}`,
          {
            details: {
              status: response.status,
              errorType: providerError?.type ?? null,
              errorCode: providerError?.code ?? null,
              errorParam: providerError?.param ?? null,
              errorMessage: providerError?.message ?? null,
              model,
              requestMode: 'chat.completions+response_format.json_schema',
              responseSchema: 'bounded_replanning_decision',
              retryCount,
            },
          },
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
