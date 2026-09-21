class LlmRankerProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LlmRankerProviderError';
    this.code = code;
    this.details = details;
  }
}

function parseRankerContent(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new LlmRankerProviderError('LLM_RANKER_EMPTY_RESPONSE', 'OpenAI ranker returned empty content');
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new LlmRankerProviderError('LLM_RANKER_INVALID_JSON', 'OpenAI ranker returned invalid JSON', {
      cause: error.message,
    });
  }
}

function createOpenAiRankerProvider({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_RANKER_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    name: 'openai-listwise-slate-ranker',
    async rank({ messages, responseSchema }) {
      if (!apiKey) {
        throw new LlmRankerProviderError('LLM_PROVIDER_NOT_CONFIGURED', 'Missing OPENAI_API_KEY for LLM ranking');
      }
      const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'tennis_recommendation_slate',
              strict: true,
              schema: responseSchema,
            },
          },
        }),
      });

      if (!response.ok) {
        throw new LlmRankerProviderError(
          'LLM_RANKER_PROVIDER_ERROR',
          `OpenAI ranker failed with HTTP ${response.status}`,
          { status: response.status, model },
        );
      }
      const json = await response.json();
      return parseRankerContent(json?.choices?.[0]?.message?.content);
    },
  };
}

export {
  LlmRankerProviderError,
  createOpenAiRankerProvider,
  parseRankerContent,
};
