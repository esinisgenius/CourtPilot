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
      bookingUrl: availability.bookingUrl,
    },
  });
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function bookingCapability(provider, facts) {
  if (safeUrl(facts.bookingUrl)) {
    if (provider === 'sportlogic') return 'court_date_time_preselected';
    if (provider === 'intrac') return 'date_time_preselected';
    if (provider === 'clubspark') return 'court_date_time_preselected';
  }
  if (safeUrl(facts.officialUrl)) return 'booking_page';
  return null;
}

function bookingFromFacts(provider, facts) {
  const url = safeUrl(facts.bookingUrl) ?? safeUrl(facts.officialUrl);
  return {
    url,
    capability: url ? bookingCapability(provider, facts) : null,
    provider,
  };
}

function buildCandidate(availability) {
  const facts = factsFromAvailability(availability);
  const canonical = availability?.canonical ? validateCanonicalAvailability(availability.canonical) : null;
  const provider = facts.provider ?? facts.venue;
  const local = getSydneyLocalDateTime(facts.startTime);
  const sportMetadata = {
    sport: facts.sport ?? facts.activity ?? null,
    activity: facts.activity ?? null,
    category: facts.category ?? null,
    venueType: facts.venueType ?? facts.type ?? null,
    tags: facts.tags ?? facts.canonicalTags ?? [],
    providerMetadata: facts.providerMetadata ?? facts.metadata ?? null,
  };

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
    booking: bookingFromFacts(provider, facts),
    features: {
      nextHourFree: facts.nextHourAlsoAvailable,
      localTime: local.localTime,
      localDate: local.localDate,
      weekday: local.weekday,
      preferredTime: null,
      price: canonical?.price.amount ?? null,
      priceOptions: facts.priceOptions ?? [],
      venue: canonical?.venue ?? null,
      eligibility: canonical?.eligibility ?? facts.eligibility ?? null,
      sportMetadata,
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
  bookingFromFacts,
  getCurrentSusfCandidates,
  stableCandidateId,
  summarizeCandidates,
};
