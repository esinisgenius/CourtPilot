import { MAPS_ERROR_CODES, MapsError } from './errors.mjs';
import { assertValidCoordinate, haversineMeters } from './geo.mjs';
import { INITIAL_RADIUS_METERS } from './radius.mjs';

const SUSF_RECONCILIATION = Object.freeze({
  nameIncludes: ['sydney uni sport', 'susf', 'university of sydney tennis'],
  center: { lat: -33.8886, lng: 151.1873 },
  maxDistanceMeters: 350,
});

const DEFAULT_TENNIS_QUERIES = Object.freeze([
  'tennis_court',
  'sports_complex',
  'sports_club',
  'sports_activity_location',
  'athletic_field',
]);

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isLikelyTennisVenue(place) {
  const providerTypes = Array.isArray(place.providerTypes) ? place.providerTypes : [];
  const normalizedName = normalizeName(place.name);
  return providerTypes.includes('tennis_court')
    || normalizedName.includes('tennis')
    || normalizedName.includes('sydney uni sport')
    || normalizedName.includes('susf');
}

function availabilityForVenue(place, { susfMapping = SUSF_RECONCILIATION } = {}) {
  const normalizedName = normalizeName(place.name);
  const nameMatches = susfMapping.nameIncludes.some((needle) => normalizedName.includes(normalizeName(needle)));
  const closeToSusf = place.location
    ? haversineMeters(place.location, susfMapping.center) <= susfMapping.maxDistanceMeters
    : false;

  if (nameMatches && closeToSusf) {
    return {
      status: 'verified',
      source: 'susf',
    };
  }

  return {
    status: 'unknown',
    source: null,
  };
}

function normalizeProviderVenue(place, { center, susfMapping } = {}) {
  if (!place || typeof place !== 'object') return null;
  if (!place.location || !Number.isFinite(place.location.lat) || !Number.isFinite(place.location.lng)) return null;

  const placeId = place.placeId ?? place.id ?? null;
  const name = place.name ?? place.displayName ?? null;
  if (!placeId && !name) return null;

  const location = {
    lat: place.location.lat,
    lng: place.location.lng,
  };

  return {
    id: placeId ? `google_places:${placeId}` : `google_places:${normalizeName(name)}:${location.lat},${location.lng}`,
    name,
    location,
    address: place.address ?? place.formattedAddress ?? null,
    source: 'google_places',
    placeId,
    geoDistanceMeters: Number.isFinite(place.geoDistanceMeters)
      ? Math.round(place.geoDistanceMeters)
      : center ? haversineMeters(center, location) : null,
    providerTypes: Array.isArray(place.providerTypes) ? place.providerTypes : [],
    travel: null,
    availability: availabilityForVenue({ name, location, placeId }, { susfMapping }),
  };
}

function dedupeVenues(venues) {
  const byKey = new Map();

  for (const venue of venues) {
    const key = venue.placeId
      ? `place:${venue.placeId}`
      : `namegeo:${normalizeName(venue.name)}:${Math.round(venue.location.lat * 10000)}:${Math.round(venue.location.lng * 10000)}`;
    const existing = byKey.get(key);
    if (!existing || (venue.geoDistanceMeters ?? Infinity) < (existing.geoDistanceMeters ?? Infinity)) {
      byKey.set(key, venue);
    }
  }

  return [...byKey.values()].sort((a, b) => (a.geoDistanceMeters ?? Infinity) - (b.geoDistanceMeters ?? Infinity));
}

async function searchTennisVenues({
  center,
  radiusMeters = INITIAL_RADIUS_METERS,
  limit = 10,
  provider,
  queries = DEFAULT_TENNIS_QUERIES,
  susfMapping,
} = {}) {
  assertValidCoordinate(center, 'venue search center');
  if (!provider?.searchPlaces) {
    throw new MapsError(MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED, 'Maps provider is not configured for venue discovery');
  }

  try {
    const batches = [];
    for (const query of queries) {
      batches.push(await provider.searchPlaces({ query, center, radiusMeters, limit }));
    }
    const venues = dedupeVenues(
      batches.flat()
        .map((place) => normalizeProviderVenue(place, { center, susfMapping }))
        .filter((venue) => venue
          && (venue.geoDistanceMeters === null || venue.geoDistanceMeters <= radiusMeters)
          && isLikelyTennisVenue(venue)),
    );
    return Number.isInteger(limit) && limit > 0 ? venues.slice(0, limit) : venues;
  } catch (error) {
    if (error instanceof MapsError) throw error;
    throw new MapsError(MAPS_ERROR_CODES.VENUE_SEARCH_FAILED, 'Venue search failed', { cause: error });
  }
}

export {
  DEFAULT_TENNIS_QUERIES,
  SUSF_RECONCILIATION,
  availabilityForVenue,
  dedupeVenues,
  normalizeProviderVenue,
  searchTennisVenues,
};
