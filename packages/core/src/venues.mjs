function venueToCandidateVenueFeature(venue) {
  return {
    id: venue.id,
    name: venue.name,
    address: venue.address ?? null,
    location: venue.location,
    availability: venue.availability ?? { status: 'unknown', source: null },
    travelTimeMinutes: venue.travel?.durationMinutes ?? null,
    travel: venue.travel ?? null,
    geoDistanceMeters: venue.geoDistanceMeters ?? null,
  };
}

function hasCoordinate(location) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
}

function configuredVenueContractIssues(venue, {
  requireGeo = false,
  requireTennis = false,
} = {}) {
  const issues = [];
  if (typeof venue?.id !== 'string' || venue.id.length === 0) issues.push('id');
  if (typeof venue?.name !== 'string' || venue.name.length === 0) issues.push('name');
  if (typeof venue?.provider !== 'string' || venue.provider.length === 0) issues.push('provider');
  if (requireTennis && venue?.sport !== 'tennis') issues.push('sport');
  if (requireGeo && !hasCoordinate(venue?.location)) issues.push('location');
  return issues;
}

function canonicalVenueContractIssues(availability, {
  configuredVenue = null,
} = {}) {
  const issues = [];
  const canonical = availability?.canonical ?? availability;
  const venue = canonical?.venue;
  const provider = canonical?.provider;

  if (typeof provider !== 'string' || provider.length === 0) issues.push('provider');
  if (typeof venue?.id !== 'string' || venue.id.length === 0) issues.push('venue.id');
  if (typeof venue?.name !== 'string' || venue.name.length === 0) issues.push('venue.name');
  if (typeof venue?.providerVenueId !== 'string' || venue.providerVenueId.length === 0) issues.push('venue.providerVenueId');

  if (configuredVenue) {
    if (configuredVenue.provider && provider !== configuredVenue.provider) issues.push('provider_mismatch');
    if (configuredVenue.id && venue?.id !== configuredVenue.id) issues.push('venue.id_mismatch');
    if (configuredVenue.location && !hasCoordinate(venue?.location)) issues.push('venue.location_missing');
  }

  return issues;
}

function assertConfiguredVenueContract(venue, options) {
  const issues = configuredVenueContractIssues(venue, options);
  if (issues.length > 0) {
    throw new Error(`Configured venue metadata contract failed for ${venue?.id ?? 'unknown'}: ${issues.join(', ')}`);
  }
  return venue;
}

function assertCanonicalVenueContract(availability, options) {
  const issues = canonicalVenueContractIssues(availability, options);
  if (issues.length > 0) {
    const canonical = availability?.canonical ?? availability;
    throw new Error(`Canonical venue metadata contract failed for ${canonical?.venue?.id ?? 'unknown'}: ${issues.join(', ')}`);
  }
  return availability;
}

function attachVenueToCandidate(candidate, venue) {
  return {
    ...candidate,
    venue: candidate.venue,
    features: {
      ...candidate.features,
      venue: venueToCandidateVenueFeature(venue),
      travelTimeMinutes: venue.travel?.durationMinutes ?? null,
    },
  };
}

export {
  attachVenueToCandidate,
  assertCanonicalVenueContract,
  assertConfiguredVenueContract,
  canonicalVenueContractIssues,
  configuredVenueContractIssues,
  venueToCandidateVenueFeature,
};
