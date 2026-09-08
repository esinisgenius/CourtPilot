import { createHash } from 'node:crypto';
import { getSusfAvailability } from '../../susf/src/index.mjs';
import {
  legacyAvailabilityFromCanonical,
  validateCanonicalAvailability,
} from './availability-schema.mjs';
import { getSydneyLocalDateTime } from './features.mjs';

function stableCandidateId({ provider, venue, court, startTime, durationMinutes }) {
  const input = [provider, venue, court, startTime, durationMinutes].join('|');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function factsFromAvailability(availability) {
  if (!availability?.canonical) return availability;

  const canonical = validateCanonicalAvailability(availability.canonical);
  return legacyAvailabilityFromCanonical(canonical, {
    nextHourAlsoAvailable: availability.nextHourAlsoAvailable ?? false,
    sourceMetadata: {
      itemId: availability.itemId,
      officialUrl: availability.officialUrl,
    },
  });
}

function buildCandidate(availability) {
  const facts = factsFromAvailability(availability);
  const canonical = availability?.canonical ? validateCanonicalAvailability(availability.canonical) : null;
  const provider = facts.provider ?? facts.venue;
  const local = getSydneyLocalDateTime(facts.startTime);

  return {
    id: stableCandidateId({
      provider,
      venue: canonical?.venue.id ?? facts.venue,
      court: canonical?.court.id ?? facts.court,
      startTime: facts.startTime,
      durationMinutes: facts.durationMinutes,
    }),
    venue: facts.venue,
    court: facts.court,
    startTime: facts.startTime,
    durationMinutes: facts.durationMinutes,
    features: {
      nextHourFree: facts.nextHourAlsoAvailable,
      localTime: local.localTime,
      localDate: local.localDate,
      preferredTime: null,
      price: canonical?.price.amount ?? null,
      priceOptions: facts.priceOptions ?? [],
    },
    source: {
      provider,
      availability: canonical?.provenance ?? facts.provenance ?? null,
      canonicalAvailability: canonical,
    },
  };
}

function buildCandidates(availability) {
  if (!Array.isArray(availability)) {
    throw new Error('buildCandidates expects an array of availability objects');
  }

  return availability
    .map(buildCandidate)
    .sort((a, b) => `${a.startTime} ${a.court}`.localeCompare(`${b.startTime} ${b.court}`));
}

async function getCurrentSusfCandidates({
  days = 7,
  durationMinutes = 60,
} = {}) {
  const availability = await getSusfAvailability({ days, durationMinutes });
  return buildCandidates(availability);
}

function summarizeCandidates(candidates) {
  const byCourt = {};
  let nextHourFree = 0;

  for (const candidate of candidates) {
    byCourt[candidate.court] = (byCourt[candidate.court] ?? 0) + 1;
    if (candidate.features.nextHourFree) nextHourFree += 1;
  }

  return {
    total: candidates.length,
    byCourt,
    nextHourFree,
  };
}

export {
  buildCandidate,
  buildCandidates,
  getCurrentSusfCandidates,
  stableCandidateId,
  summarizeCandidates,
};
