import { defaultMapsCache, stableJson } from './cache.mjs';
import { MAPS_ERROR_CODES, MapsError } from './errors.mjs';
import { assertValidCoordinate } from './geo.mjs';
import { resolveLocation } from './location-resolver.mjs';
import { TRAVEL_MODES, createTravelEstimateContext, normalizeRouteResult } from './travel-time.mjs';

const ACCESSIBILITY_MODES = Object.freeze([
  TRAVEL_MODES.WALK,
  TRAVEL_MODES.TRANSIT,
  TRAVEL_MODES.DRIVE,
]);

const VENUE_LOCATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRANSIT_DEPARTURE_LEAD_MINUTES = 45;

function venueCacheKey(venue) {
  return `venue-location:${stableJson({
    id: venue.id ?? null,
    placeId: venue.placeId ?? null,
    name: venue.name ?? null,
    address: venue.address ?? null,
    location: venue.location ?? null,
  })}`;
}

function geocodeQueryForVenue(venue) {
  return [venue.name, venue.address].filter(Boolean).join(', ').trim();
}

function normalizeResolvedVenueLocation(venue, resolved = {}) {
  const location = resolved.lat !== undefined && resolved.lng !== undefined
    ? { lat: resolved.lat, lng: resolved.lng }
    : venue.location;

  assertValidCoordinate(location, 'venue location');
  return {
    id: venue.id ?? resolved.placeId ?? null,
    placeId: venue.placeId ?? resolved.placeId ?? null,
    label: venue.name ?? resolved.label ?? resolved.address ?? null,
    name: venue.name ?? resolved.label ?? null,
    address: venue.address ?? resolved.address ?? null,
    lat: location.lat,
    lng: location.lng,
  };
}

async function resolveVenueLocation(venue, {
  provider,
  cache = defaultMapsCache,
  ttlMs = VENUE_LOCATION_TTL_MS,
} = {}) {
  if (!venue || typeof venue !== 'object') throw new Error('venue must be an object');
  const key = venueCacheKey(venue);
  const cached = cache.get(key);
  if (cached) return cached;

  if (venue.location?.lat !== undefined && venue.location?.lng !== undefined) {
    return cache.set(key, normalizeResolvedVenueLocation(venue), ttlMs);
  }

  if (!provider?.geocode) {
    throw new MapsError(MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED, 'Maps provider is not configured for venue geocoding');
  }

  const query = geocodeQueryForVenue(venue);
  if (!query) {
    throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, 'Venue has no location, name, or address to resolve');
  }

  const resolved = await provider.geocode({ query });
  if (!resolved) {
    throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, `Could not reliably resolve venue: ${query}`);
  }

  return cache.set(key, normalizeResolvedVenueLocation(venue, resolved), ttlMs);
}

function deriveTransitDepartureTime(candidate, {
  departureTime,
  transitDepartureLeadMinutes = DEFAULT_TRANSIT_DEPARTURE_LEAD_MINUTES,
} = {}) {
  if (departureTime) return new Date(departureTime).toISOString();
  if (!candidate?.startTime) return null;

  const start = new Date(candidate.startTime);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() - transitDepartureLeadMinutes * 60 * 1000).toISOString();
}

function accessibilityModeUnavailable(mode, {
  departureTime = null,
  reason = 'route_unavailable',
} = {}) {
  const base = {
    durationMinutes: null,
    distanceMeters: null,
    unavailableReason: reason,
  };

  if (mode === TRAVEL_MODES.TRANSIT) {
    return {
      ...base,
      departureTime,
    };
  }

  return base;
}

async function computeModeAccessibility({
  provider,
  origin,
  destinations,
  mode,
  departureTime = null,
  estimateContext,
} = {}) {
  try {
    const routes = await provider.computeTravelTimes({
      origin,
      destinations,
      mode,
      estimateContext,
      targetTime: departureTime,
      targetTimeType: departureTime ? 'departure' : null,
    });

    return routes.map((route) => {
      const normalized = normalizeRouteResult(route, {
        mode,
        valueSource: departureTime ? 'candidate_slot_time' : 'provider_default',
        estimateContext,
      });
      const value = {
        durationMinutes: normalized.durationMinutes,
        distanceMeters: normalized.distanceMeters,
        unavailableReason: normalized.unavailableReason,
      };
      if (mode === TRAVEL_MODES.TRANSIT) value.departureTime = departureTime;
      return value;
    });
  } catch (error) {
    const reason = error.code ?? MAPS_ERROR_CODES.ROUTES_PROVIDER_ERROR;
    return destinations.map(() => accessibilityModeUnavailable(mode, { departureTime, reason }));
  }
}

async function computeTransitAccessibilityByDeparture({
  provider,
  origin,
  destinations,
  venues,
  transitDepartureTime,
  transitDepartureLeadMinutes,
} = {}) {
  const groups = new Map();
  venues.forEach((venue, index) => {
    const departureTime = deriveTransitDepartureTime(venue, {
      departureTime: transitDepartureTime,
      transitDepartureLeadMinutes,
    });
    const key = departureTime ?? 'provider_default';
    if (!groups.has(key)) groups.set(key, { departureTime, indexes: [] });
    groups.get(key).indexes.push(index);
  });

  const output = Array(venues.length);
  for (const group of groups.values()) {
    const estimateContext = group.departureTime
      ? {
        type: 'candidate_slot_departure_time_policy',
        departureTime: group.departureTime,
        targetSlotStartTimes: [...new Set(group.indexes.map((index) => venues[index]?.startTime ?? null))],
        transitDepartureLeadMinutes,
        limitation: null,
      }
      : createTravelEstimateContext();

    const values = await computeModeAccessibility({
      provider,
      origin,
      destinations: group.indexes.map((index) => destinations[index]),
      mode: TRAVEL_MODES.TRANSIT,
      departureTime: group.departureTime,
      estimateContext,
    });

    group.indexes.forEach((venueIndex, valueIndex) => {
      output[venueIndex] = values[valueIndex];
    });
  }

  return output;
}

async function enrichVenueAccessibility({
  originText,
  origin,
  venues,
  provider,
  cache = defaultMapsCache,
  observedAt = new Date().toISOString(),
  transitDepartureTime,
  transitDepartureLeadMinutes = DEFAULT_TRANSIT_DEPARTURE_LEAD_MINUTES,
} = {}) {
  if (!provider?.computeTravelTimes) {
    throw new MapsError(MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED, 'Maps provider is not configured for route matrix');
  }
  if (!Array.isArray(venues)) throw new Error('venues must be an array');

  const resolvedOrigin = origin ?? await resolveLocation({
    type: 'user_text',
    query: originText,
  }, { provider });

  const resolvedVenues = await Promise.all(venues.map((venue) => resolveVenueLocation(venue, { provider, cache })));
  const destinations = resolvedVenues.map((venue) => ({
    lat: venue.lat,
    lng: venue.lng,
    placeId: venue.placeId,
  }));
  const routeOrigin = {
    lat: resolvedOrigin.lat,
    lng: resolvedOrigin.lng,
    placeId: resolvedOrigin.placeId,
  };
  const [walk, drive, transit] = await Promise.all([
    computeModeAccessibility({
      provider,
      origin: routeOrigin,
      destinations,
      mode: TRAVEL_MODES.WALK,
      estimateContext: createTravelEstimateContext(),
    }),
    computeModeAccessibility({
      provider,
      origin: routeOrigin,
      destinations,
      mode: TRAVEL_MODES.DRIVE,
      estimateContext: createTravelEstimateContext(),
    }),
    computeTransitAccessibilityByDeparture({
      provider,
      origin: routeOrigin,
      destinations,
      venues,
      transitDepartureTime,
      transitDepartureLeadMinutes,
    }),
  ]);

  return venues.map((venue, index) => ({
    ...venue,
    accessibility: {
      origin: {
        placeId: resolvedOrigin.placeId ?? null,
        label: resolvedOrigin.label ?? originText ?? null,
      },
      walk: walk[index],
      transit: transit[index],
      drive: drive[index],
      source: 'google_routes',
      observedAt,
    },
  }));
}

export {
  ACCESSIBILITY_MODES,
  DEFAULT_TRANSIT_DEPARTURE_LEAD_MINUTES,
  VENUE_LOCATION_TTL_MS,
  accessibilityModeUnavailable,
  computeTransitAccessibilityByDeparture,
  deriveTransitDepartureTime,
  enrichVenueAccessibility,
  resolveVenueLocation,
};
