const TENNIS_SPORT_PROOFS = new Set([
  'provider_resource',
  'provider_venue',
  'verified_booking_page',
]);

const NON_TENNIS_ONLY_TERMS = [
  /\bgolf(?:\s+course)?\b/i,
  /\bdriving\s+range\b/i,
  /\bpickleball[-\s]*only\b/i,
  /\bpadel[-\s]*only\b/i,
];

const TENNIS_TERM = /\btennis\b/i;
const DEFAULT_TARGET_RADIUS_METERS = 5000;

function normalizeText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateSportProof(candidate) {
  return candidate?.features?.eligibility?.sport
    ?? candidate?.eligibility?.sport
    ?? candidate?.source?.canonicalAvailability?.eligibility?.sport
    ?? null;
}

function flattenMetadataValues(value, output = []) {
  if (value == null) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) flattenMetadataValues(entry, output);
    return output;
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value)) flattenMetadataValues(entry, output);
  }
  return output;
}

function candidateSportMetadata(candidate) {
  const venue = canonicalVenue(candidate);
  return flattenMetadataValues([
    candidate?.features?.sportMetadata,
    candidate?.features?.sport,
    candidate?.features?.activity,
    candidate?.features?.category,
    candidate?.features?.venueType,
    candidate?.source?.canonicalAvailability?.providerMetadata,
    venue?.sport,
    venue?.activity,
    venue?.category,
    venue?.venueType,
    venue?.tags,
  ]).map(normalizeText).filter(Boolean);
}

function hasTennisMetadata(candidate) {
  const proof = candidateSportProof(candidate);
  return proof?.type === 'tennis'
    || candidateSportMetadata(candidate).some((value) => TENNIS_TERM.test(value));
}

function hasNonTennisOnlyMetadata(candidate) {
  const values = candidateSportMetadata(candidate);
  return values.some((value) => NON_TENNIS_ONLY_TERMS.some((pattern) => pattern.test(value)))
    && !values.some((value) => TENNIS_TERM.test(value));
}

function canonicalVenue(candidate) {
  return candidate?.features?.venue
    ?? candidate?.source?.canonicalAvailability?.venue
    ?? null;
}

function candidateProvider(candidate) {
  return candidate?.source?.provider
    ?? candidate?.source?.canonicalAvailability?.provider
    ?? null;
}

function candidateVenueIdentity(candidate) {
  const venue = canonicalVenue(candidate);
  return {
    id: venue?.id ?? null,
    providerVenueId: venue?.providerVenueId ?? null,
    name: venue?.name ?? candidate?.venue ?? null,
    provider: candidateProvider(candidate),
  };
}

function sportEligibility(candidate) {
  const proof = candidateSportProof(candidate);
  if (hasNonTennisOnlyMetadata(candidate)) {
    return {
      eligible: false,
      reason: {
        feature: 'sport',
        reason: 'sport_eligibility_excluded',
        detail: 'Provider metadata identifies this facility as non-tennis-only.',
      },
    };
  }

  if (proof?.type === 'tennis' && TENNIS_SPORT_PROOFS.has(proof.proof)) {
    return { eligible: true };
  }

  if (hasTennisMetadata(candidate)) {
    return { eligible: true };
  }

  return {
    eligible: false,
    reason: {
      feature: 'sport',
      reason: 'sport_eligibility_insufficient',
      detail: 'Candidate lacks positive proof that the facility/resource is tennis.',
    },
  };
}

function explicitTarget(searchScope = {}) {
  return searchScope.targetLocation
    ?? searchScope.targetArea
    ?? searchScope.location
    ?? null;
}

function targetCenter(target) {
  if (target && typeof target === 'object') {
    const center = target.center ?? target.location ?? target;
    if (Number.isFinite(center?.lat) && Number.isFinite(center?.lng)) return center;
  }
  return null;
}

function targetRadiusMeters(searchScope = {}) {
  const target = explicitTarget(searchScope);
  if (target && typeof target === 'object' && Number.isFinite(target.radiusMeters)) {
    return target.radiusMeters;
  }
  if (Number.isFinite(searchScope.radiusMeters)) return searchScope.radiusMeters;
  return DEFAULT_TARGET_RADIUS_METERS;
}

function degreesToRadians(value) {
  return value * (Math.PI / 180);
}

function distanceMeters(a, b) {
  const earthRadiusMeters = 6371000;
  const dLat = degreesToRadians(b.lat - a.lat);
  const dLng = degreesToRadians(b.lng - a.lng);
  const lat1 = degreesToRadians(a.lat);
  const lat2 = degreesToRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(h));
}

function configuredVenueMatch(candidate, matchedVenue) {
  const identity = candidateVenueIdentity(candidate);
  if (matchedVenue.provider && identity.provider && matchedVenue.provider !== identity.provider) return false;
  const ids = [
    identity.id,
    identity.providerVenueId,
  ].filter(Boolean).map(String);
  if (matchedVenue.id && ids.includes(String(matchedVenue.id))) return true;
  if (matchedVenue.providerVenueId && ids.includes(String(matchedVenue.providerVenueId))) return true;
  return normalizeText(identity.name) !== ''
    && normalizeText(identity.name) === normalizeText(matchedVenue.name);
}

function geographicEligibility(candidate, searchScope = {}) {
  const target = explicitTarget(searchScope);
  if (!target) return { eligible: true };

  const routing = searchScope.locationRouting ?? null;
  if (routing?.status === 'matched_configured_venue' || routing?.status === 'matched_geographic_scope') {
    const matchedVenues = routing.matchedVenues ?? [];
    if (matchedVenues.some((venue) => configuredVenueMatch(candidate, venue))) {
      return { eligible: true };
    }

    return {
      eligible: false,
      reason: {
        feature: 'geography',
        reason: 'candidate_outside_target_scope',
        detail: 'Candidate is not one of the configured venues matched to the explicit target area.',
      },
    };
  }

  const center = targetCenter(target);
  if (!center) {
    return {
      eligible: false,
      reason: {
        feature: 'geography',
        reason: 'target_scope_unresolved',
        detail: 'Explicit target area could not be resolved to a configured venue or coordinates.',
      },
    };
  }

  const venue = canonicalVenue(candidate);
  if (!Number.isFinite(venue?.location?.lat) || !Number.isFinite(venue?.location?.lng)) {
    return {
      eligible: false,
      reason: {
        feature: 'geography',
        reason: 'geographic_eligibility_insufficient',
        detail: 'Candidate has no coordinates for explicit target-area validation.',
      },
    };
  }

  const distance = distanceMeters(center, venue.location);
  if (distance <= targetRadiusMeters(searchScope)) return { eligible: true };

  return {
    eligible: false,
    reason: {
      feature: 'geography',
      reason: 'candidate_outside_target_scope',
      detail: `Candidate is ${Math.round(distance)}m from the explicit target center.`,
    },
  };
}

function evaluateCandidateEligibility(candidate, searchScope = {}) {
  const reasons = [];
  const sport = sportEligibility(candidate);
  if (!sport.eligible) reasons.push(sport.reason);

  const geography = geographicEligibility(candidate, searchScope);
  if (!geography.eligible) reasons.push(geography.reason);

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function applyCandidateEligibilityGate({ candidates, searchScope = {} }) {
  const accepted = [];
  const rejected = [];

  for (const candidate of candidates ?? []) {
    const result = evaluateCandidateEligibility(candidate, searchScope);
    if (result.eligible) {
      accepted.push(candidate);
    } else {
      rejected.push({
        candidate,
        reasons: result.reasons,
      });
    }
  }

  return { accepted, rejected };
}

export {
  applyCandidateEligibilityGate,
  evaluateCandidateEligibility,
};
