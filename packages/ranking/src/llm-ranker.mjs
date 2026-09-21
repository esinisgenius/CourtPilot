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
        'You are a bounded listwise tennis recommendation ranker.',
        `The first ${rankerInput.slateSize} ranked candidates form one recommendation slate, so optimize them jointly rather than scoring candidates independently.`,
        'Each slate candidate must be a strong individual match and add meaningful decision value beyond candidates ranked before it.',
        'Infer useful comparison dimensions from the user preferences and supplied facts, including venue, court, surface, time, price, accessibility, weather, and continuous availability when relevant.',
        'Avoid near-duplicate choices that add little information, but do not diversify for appearance or promote a substantially worse candidate merely because it is different.',
        'When the feasible candidates are genuinely similar, preserve quality and state the limited marginal value instead of inventing differences.',
        'Rank every provided candidate exactly once. For each candidate, explain individual reasons, tradeoffs, and marginalValue relative to earlier selections.',
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
  slateSize = 3,
} = {}) {
  const input = buildRankerInput({ preferenceProfile, candidates, slateSize });
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
    return {
      ...validateRankerOutput(rawOutput, {
        candidateFacts: input.candidates,
        preferenceProfile,
      }),
      rankingMode: 'llm_slate',
    };
  } catch {
    return fallbackRankCandidates({ preferenceProfile, candidates });
  }
}

export {
  buildCandidateRankerMessages,
  rankCandidates,
};
