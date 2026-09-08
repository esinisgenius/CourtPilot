import {
  DEFAULT_TRANSIT_DEPARTURE_LEAD_MINUTES,
  MAPS_ERROR_CODES,
  TRAVEL_MODES,
  accessibilityModeUnavailable,
  deriveTransitDepartureTime,
  enrichVenueAccessibility,
} from '../../maps/src/index.mjs';

function candidateVenueKey(candidate) {
  const canonicalVenue = candidate.source?.canonicalAvailability?.venue;
  return canonicalVenue?.id
    ?? candidate.features?.venue?.id
    ?? candidate.venue;
}

function candidateVenueInput(candidate) {
  const featureVenue = candidate.features?.venue;
  const canonicalVenue = candidate.source?.canonicalAvailability?.venue;
  return {
    id: candidateVenueKey(candidate),
    name: featureVenue?.name ?? canonicalVenue?.name ?? candidate.venue,
    address: featureVenue?.address ?? null,
    location: featureVenue?.location ?? null,
    placeId: featureVenue?.placeId ?? null,
    startTime: candidate.startTime,
  };
}

function unknownAccessibility({
  originLabel = null,
  originPlaceId = null,
  departureTime = null,
  observedAt = new Date().toISOString(),
  reason = MAPS_ERROR_CODES.TRAVEL_TIME_UNAVAILABLE,
} = {}) {
  return {
    origin: {
      placeId: originPlaceId,
      label: originLabel,
    },
    walk: accessibilityModeUnavailable(TRAVEL_MODES.WALK, { reason }),
    transit: accessibilityModeUnavailable(TRAVEL_MODES.TRANSIT, { departureTime, reason }),
    drive: accessibilityModeUnavailable(TRAVEL_MODES.DRIVE, { reason }),
    source: 'google_routes',
    observedAt,
  };
}

function attachAccessibility(candidates, byCandidateId) {
  return candidates.map((candidate) => ({
    ...candidate,
    accessibility: byCandidateId.get(candidate.id) ?? null,
    features: {
      ...candidate.features,
      accessibility: byCandidateId.get(candidate.id) ?? null,
    },
  }));
}

async function enrichCandidateAccessibility({
  candidates,
  originText,
  origin,
  provider,
  cache,
  observedAt = new Date().toISOString(),
  transitDepartureLeadMinutes = DEFAULT_TRANSIT_DEPARTURE_LEAD_MINUTES,
  accessibilityAdapter = enrichVenueAccessibility,
} = {}) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array');
  if (candidates.length === 0) return [];

  const byCandidateId = new Map();
  const groups = new Map();

  for (const candidate of candidates) {
    const departureTime = deriveTransitDepartureTime(candidate, { transitDepartureLeadMinutes });
    const key = `${candidateVenueKey(candidate)}|${departureTime ?? 'provider_default'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        departureTime,
        representative: candidateVenueInput(candidate),
        candidateIds: [],
      });
    }
    groups.get(key).candidateIds.push(candidate.id);
  }

  try {
    const grouped = [...groups.values()];
    const enrichedVenues = await accessibilityAdapter({
      originText,
      origin,
      venues: grouped.map((group) => ({
        ...group.representative,
        startTime: group.departureTime
          ? new Date(new Date(group.departureTime).getTime() + transitDepartureLeadMinutes * 60 * 1000).toISOString()
          : group.representative.startTime,
      })),
      provider,
      cache,
      observedAt,
      transitDepartureLeadMinutes,
    });

    enrichedVenues.forEach((venue, index) => {
      for (const candidateId of grouped[index].candidateIds) {
        byCandidateId.set(candidateId, venue.accessibility);
      }
    });
  } catch (error) {
    for (const candidate of candidates) {
      const departureTime = deriveTransitDepartureTime(candidate, { transitDepartureLeadMinutes });
      byCandidateId.set(candidate.id, unknownAccessibility({
        originLabel: origin?.label ?? originText ?? null,
        originPlaceId: origin?.placeId ?? null,
        departureTime,
        observedAt,
        reason: error.code ?? MAPS_ERROR_CODES.TRAVEL_TIME_UNAVAILABLE,
      }));
    }
  }

  return attachAccessibility(candidates, byCandidateId);
}

export {
  attachAccessibility,
  candidateVenueInput,
  candidateVenueKey,
  enrichCandidateAccessibility,
  unknownAccessibility,
};
