import { accessibilityFacts, normalizeTransportMode } from '../../core/src/transport-preferences.mjs';

const rankerOutputJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['rankedCandidates'],
  properties: {
    rankedCandidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'rank', 'reasons', 'tradeoffs', 'marginalValue'],
        properties: {
          candidateId: { type: 'string' },
          rank: { type: 'integer', minimum: 1 },
          reasons: {
            type: 'array',
            items: { type: 'string' },
          },
          tradeoffs: {
            type: 'array',
            items: { type: 'string' },
          },
          marginalValue: { type: 'string' },
        },
      },
    },
  },
});

class RankerSchemaError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'RankerSchemaError';
    this.code = 'RANKER_SCHEMA_ERROR';
    this.issues = issues;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function modeFact(accessibility, mode) {
  const key = mode.toLowerCase();
  const fact = accessibility?.[key] ?? null;
  if (!fact) {
    return {
      durationMinutes: null,
      distanceMeters: null,
      status: 'unknown',
      unavailableReason: 'accessibility_missing',
    };
  }

  const durationMinutes = finiteNumberOrNull(fact.durationMinutes);
  return {
    durationMinutes,
    distanceMeters: finiteNumberOrNull(fact.distanceMeters),
    status: durationMinutes === null ? 'unavailable' : 'known',
    unavailableReason: durationMinutes === null ? fact.unavailableReason ?? 'route_unavailable' : null,
  };
}

function availabilityStatus(candidate) {
  return candidate.source?.availability?.status
    ?? candidate.source?.canonicalAvailability?.provenance?.status
    ?? candidate.availability?.status
    ?? null;
}

function priceOptions(candidate) {
  const options = candidate.features?.priceOptions;
  if (!Array.isArray(options)) return [];
  return options.map((option) => ({
    label: option.label ?? option.name ?? null,
    amount: finiteNumberOrNull(option.amount ?? option.price),
    currency: option.currency ?? null,
  }));
}

function continuousDurationMinutes(candidate) {
  const base = finiteNumberOrNull(candidate.durationMinutes) ?? 0;
  const knownContinuous = finiteNumberOrNull(candidate.features?.continuousDurationMinutes);
  if (knownContinuous !== null) return knownContinuous;
  if (candidate.features?.nextHourFree === true) return Math.max(base, 120);
  return base || null;
}

function snapshotCandidateFacts(candidate) {
  if (!isPlainObject(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new RankerSchemaError('Ranker candidate must have a stable string id');
  }

  const accessibility = accessibilityFacts(candidate);
  return {
    candidateId: candidate.id,
    availability: {
      status: availabilityStatus(candidate),
      nextHourAlsoAvailable: candidate.features?.nextHourFree ?? null,
    },
    price: {
      amount: finiteNumberOrNull(candidate.features?.price),
      currency: candidate.features?.currency ?? null,
      options: priceOptions(candidate),
    },
    continuousDurationMinutes: continuousDurationMinutes(candidate),
    slot: {
      startTime: candidate.startTime ?? null,
      durationMinutes: finiteNumberOrNull(candidate.durationMinutes),
      localDate: candidate.features?.localDate ?? null,
      localTime: candidate.features?.localTime ?? null,
    },
    court: {
      name: candidate.court ?? null,
      surface: candidate.features?.surface
        ?? candidate.source?.canonicalAvailability?.court?.surface
        ?? null,
      preferenceMatch: candidate.features?.courtPreference ?? candidate.matches?.court ?? null,
    },
    venue: {
      name: candidate.venue ?? null,
      preferenceMatch: candidate.features?.venuePreference ?? candidate.matches?.venue ?? null,
      distanceKm: finiteNumberOrNull(candidate.features?.distanceKm),
    },
    accessibility: {
      WALK: modeFact(accessibility, 'WALK'),
      TRANSIT: modeFact(accessibility, 'TRANSIT'),
      DRIVE: modeFact(accessibility, 'DRIVE'),
    },
    weather: cloneJson(candidate.features?.weather),
  };
}

function buildRankerInput({ preferenceProfile = {}, candidates = [], slateSize = 3 } = {}) {
  if (!Array.isArray(candidates)) throw new RankerSchemaError('Ranker candidates must be an array');
  return {
    preferenceProfile,
    slateSize: Math.min(Math.max(1, Math.trunc(slateSize)), candidates.length || 1),
    candidates: candidates.map(snapshotCandidateFacts),
  };
}

function collectPreferenceMinuteValues(preferenceProfile = {}) {
  const minutes = new Set();
  const add = (value) => {
    if (Number.isFinite(value)) minutes.add(Number(value));
  };

  add(preferenceProfile.transportPreference?.maxTransitMinutes);
  add(preferenceProfile.transportPreference?.maxWalkMinutes);
  for (const preference of preferenceProfile.preferences ?? []) {
    add(preference.rule?.maxMinutes);
    add(preference.rule?.preferredMaxMinutes);
    add(preference.rule?.maxTransitMinutes);
    add(preference.rule?.maxWalkMinutes);
    add(preference.rule?.exactMinutes);
    add(preference.rule?.minMinutes);
    add(preference.rule?.preferredMinutes);
  }
  return minutes;
}

function allowedMoneyValues(snapshot) {
  const values = new Set();
  const add = (value) => {
    if (Number.isFinite(value)) values.add(Number(value));
  };
  add(snapshot.price.amount);
  for (const option of snapshot.price.options) add(option.amount);
  return values;
}

function allowedMinuteValues(snapshot, preferenceProfile) {
  const values = collectPreferenceMinuteValues(preferenceProfile);
  const add = (value) => {
    if (Number.isFinite(value)) values.add(Number(value));
  };

  add(snapshot.continuousDurationMinutes);
  add(snapshot.slot.durationMinutes);
  for (const mode of ['WALK', 'TRANSIT', 'DRIVE']) {
    add(snapshot.accessibility[mode].durationMinutes);
  }
  return values;
}

function extractMoneyValues(text) {
  const values = [];
  const pattern = /\$(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:AUD|刀|块)/giu;
  for (const match of text.matchAll(pattern)) values.push(Number(match[1] ?? match[2]));
  return values;
}

function extractMinuteValues(text) {
  const values = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes|分钟)/giu;
  for (const match of text.matchAll(pattern)) values.push(Number(match[1]));
  return values;
}

function validateGroundedText(text, snapshot, preferenceProfile, path, issues) {
  const moneyValues = allowedMoneyValues(snapshot);
  for (const value of extractMoneyValues(text)) {
    if (!moneyValues.has(value)) issues.push(`${path} mentions ungrounded price ${value}`);
  }

  const minuteValues = allowedMinuteValues(snapshot, preferenceProfile);
  for (const value of extractMinuteValues(text)) {
    if (!minuteValues.has(value)) issues.push(`${path} mentions ungrounded minute value ${value}`);
  }
}

function validateStringList(value, path, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }

  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      issues.push(`${path}[${index}] must be a non-empty string`);
    }
  });
  return value.filter((item) => typeof item === 'string');
}

function validateRankerOutput(output, { candidateFacts = [], preferenceProfile = {} } = {}) {
  const issues = [];
  if (!isPlainObject(output)) {
    throw new RankerSchemaError('Ranker output must be an object', ['output must be an object']);
  }

  const candidateById = new Map(candidateFacts.map((candidate) => [candidate.candidateId, candidate]));
  if (!Array.isArray(output.rankedCandidates)) {
    throw new RankerSchemaError('Invalid ranker output', ['rankedCandidates must be an array']);
  }

  const seenIds = new Set();
  const seenRanks = new Set();
  for (const [index, entry] of output.rankedCandidates.entries()) {
    const path = `rankedCandidates[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(`${path} must be an object`);
      continue;
    }

    const extraKeys = Object.keys(entry).filter((key) => (
      !['candidateId', 'rank', 'reasons', 'tradeoffs', 'marginalValue'].includes(key)
    ));
    if (extraKeys.length > 0) issues.push(`${path} has unsupported keys: ${extraKeys.join(', ')}`);
    if (typeof entry.candidateId !== 'string' || !candidateById.has(entry.candidateId)) {
      issues.push(`${path}.candidateId is not in the hard-filtered candidate set`);
    } else if (seenIds.has(entry.candidateId)) {
      issues.push(`${path}.candidateId is duplicated`);
    } else {
      seenIds.add(entry.candidateId);
    }

    if (!Number.isInteger(entry.rank) || entry.rank < 1 || entry.rank > candidateFacts.length) {
      issues.push(`${path}.rank must be an integer from 1 to ${candidateFacts.length}`);
    } else if (seenRanks.has(entry.rank)) {
      issues.push(`${path}.rank is duplicated`);
    } else {
      seenRanks.add(entry.rank);
    }

    const reasons = validateStringList(entry.reasons, `${path}.reasons`, issues);
    const tradeoffs = validateStringList(entry.tradeoffs, `${path}.tradeoffs`, issues);
    if (typeof entry.marginalValue !== 'string' || entry.marginalValue.trim().length === 0) {
      issues.push(`${path}.marginalValue must be a non-empty string`);
    }
    const snapshot = candidateById.get(entry.candidateId);
    if (snapshot) {
      [...reasons, ...tradeoffs, entry.marginalValue].filter((text) => typeof text === 'string')
        .forEach((text, textIndex) => {
          validateGroundedText(text, snapshot, preferenceProfile, `${path}.text[${textIndex}]`, issues);
        });
    }
  }

  if (seenIds.size !== candidateFacts.length) {
    issues.push('rankedCandidates must include each hard-filtered candidate exactly once');
  }

  if (issues.length > 0) throw new RankerSchemaError('Invalid ranker output', issues);

  return {
    rankedCandidates: output.rankedCandidates
      .map((entry) => ({
        candidateId: entry.candidateId,
        rank: entry.rank,
        reasons: entry.reasons,
        tradeoffs: entry.tradeoffs,
        marginalValue: entry.marginalValue,
      }))
      .sort((a, b) => a.rank - b.rank),
  };
}

function transportModeDurations(snapshot) {
  return Object.fromEntries(['WALK', 'TRANSIT', 'DRIVE'].map((mode) => [
    normalizeTransportMode(mode),
    snapshot.accessibility[mode].durationMinutes,
  ]));
}

export {
  RankerSchemaError,
  buildRankerInput,
  rankerOutputJsonSchema,
  snapshotCandidateFacts,
  transportModeDurations,
  validateRankerOutput,
};
