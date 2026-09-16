import { fallbackRankCandidates } from './fallback-ranker.mjs';
import {
  buildRankerInput,
  rankerOutputJsonSchema,
  validateRankerOutput,
} from './schema.mjs';

const defaultTimeoutMs = 8000;

function buildCandidateRankerMessages(rankerInput) {
  return [
    {
      role: 'system',
      content: [
        'You are a bounded tennis candidate ranker.',
        'Rank only the provided hard-filtered candidates using the user soft preferences.',
        'Use only factual candidate fields in the input. Do not estimate or invent price, time, distance, weather, availability, court, or venue facts.',
        'Do not add candidates, remove candidates, change candidate ids, relax hard constraints, or propose replanning actions.',
        'Return strict JSON matching the provided schema.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify(rankerInput),
    },
  ];
}

function providerCall(provider, payload) {
  if (!provider) return null;
  if (typeof provider === 'function') return provider(payload);
  if (typeof provider.rank === 'function') return provider.rank(payload);
  throw new Error('LLM ranker provider must be a function or expose rank(payload)');
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('LLM ranker timed out')), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function rankCandidates({
  preferenceProfile = {},
  candidates = [],
  provider = null,
  timeoutMs = defaultTimeoutMs,
} = {}) {
  const input = buildRankerInput({ preferenceProfile, candidates });
  if (input.candidates.length === 0) return { rankedCandidates: [] };

  if (!provider) {
    return fallbackRankCandidates({ preferenceProfile, candidates });
  }

  try {
    const payload = {
      input,
      messages: buildCandidateRankerMessages(input),
      responseSchema: rankerOutputJsonSchema,
    };
    const rawOutput = await withTimeout(Promise.resolve(providerCall(provider, payload)), timeoutMs);
    return validateRankerOutput(rawOutput, {
      candidateFacts: input.candidates,
      preferenceProfile,
    });
  } catch {
    return fallbackRankCandidates({ preferenceProfile, candidates });
  }
}

export {
  buildCandidateRankerMessages,
  rankCandidates,
};
