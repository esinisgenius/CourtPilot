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
  venueToCandidateVenueFeature,
};
