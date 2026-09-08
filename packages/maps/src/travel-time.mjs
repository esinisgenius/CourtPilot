import { MAPS_ERROR_CODES, MapsError } from './errors.mjs';
import { assertValidCoordinate } from './geo.mjs';

const TRAVEL_MODES = Object.freeze({
  TRANSIT: 'TRANSIT',
  WALK: 'WALK',
  DRIVE: 'DRIVE',
});

function normalizeTravelMode(mode = TRAVEL_MODES.TRANSIT) {
  const upper = String(mode).toUpperCase();
  if (upper === 'WALKING') return TRAVEL_MODES.WALK;
  if (upper === 'DRIVING') return TRAVEL_MODES.DRIVE;
  if (!Object.values(TRAVEL_MODES).includes(upper)) {
    throw new Error(`Unsupported travel mode: ${mode}`);
  }
  return upper;
}

function inferTravelModeFromText(text, { defaultMode = TRAVEL_MODES.TRANSIT } = {}) {
  const sourceText = String(text ?? '').toLowerCase();
  if (/走路|步行|walk/.test(sourceText)) return { mode: TRAVEL_MODES.WALK, valueSource: 'user_explicit' };
  if (/开车|駕車|驾车|drive|car/.test(sourceText)) return { mode: TRAVEL_MODES.DRIVE, valueSource: 'user_explicit' };
  if (/公交|公共交通|巴士|火车|train|bus|transit|public transport/.test(sourceText)) {
    return { mode: TRAVEL_MODES.TRANSIT, valueSource: 'user_explicit' };
  }
  return { mode: normalizeTravelMode(defaultMode), valueSource: 'product_default' };
}

function normalizeTargetTime(targetTime) {
  if (targetTime === null || targetTime === undefined) return null;
  const date = targetTime instanceof Date ? targetTime : new Date(targetTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error('targetTime must be a valid date/time');
  }
  return date.toISOString();
}

function createTravelEstimateContext({ targetTime, targetTimeType = 'arrival' } = {}) {
  const normalizedTargetTime = normalizeTargetTime(targetTime);
  if (!normalizedTargetTime) {
    return {
      type: 'venue_level_current_or_provider_default',
      targetTime: null,
      targetTimeType: null,
      limitation: 'No target time was provided; provider may use current/default routing conditions.',
    };
  }

  return {
    type: targetTimeType === 'departure' ? 'target_departure_time' : 'target_arrival_time',
    targetTime: normalizedTargetTime,
    targetTimeType: targetTimeType === 'departure' ? 'departure' : 'arrival',
    limitation: null,
  };
}

function normalizeRouteResult(route, { mode, valueSource, estimateContext }) {
  if (!route || route.status === 'unavailable') {
    return {
      mode,
      durationMinutes: null,
      distanceMeters: null,
      source: 'google_routes',
      valueSource,
      estimateContext,
      unavailableReason: route?.reason ?? 'route_unavailable',
    };
  }

  return {
    mode,
    durationMinutes: Number.isFinite(route.durationMinutes) ? Math.ceil(route.durationMinutes) : null,
    distanceMeters: Number.isFinite(route.distanceMeters) ? Math.round(route.distanceMeters) : null,
    source: 'google_routes',
    valueSource,
    estimateContext,
    unavailableReason: null,
  };
}

async function enrichVenueTravelTimes({
  origin,
  venues,
  mode = TRAVEL_MODES.TRANSIT,
  modeValueSource = 'product_default',
  provider,
  targetTime,
  targetTimeType = 'arrival',
  estimateContext = createTravelEstimateContext({ targetTime, targetTimeType }),
} = {}) {
  assertValidCoordinate(origin, 'travel origin');
  if (!Array.isArray(venues)) throw new Error('venues must be an array');
  const normalizedMode = normalizeTravelMode(mode);

  if (venues.length === 0) return [];
  if (!provider?.computeTravelTimes) {
    throw new MapsError(MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED, 'Maps provider is not configured for travel time');
  }

  const uniqueDestinations = [];
  const destinationKeyToIndex = new Map();
  for (const venue of venues) {
    assertValidCoordinate(venue.location, 'venue location');
    const key = `${venue.location.lat},${venue.location.lng}`;
    if (!destinationKeyToIndex.has(key)) {
      destinationKeyToIndex.set(key, uniqueDestinations.length);
      uniqueDestinations.push(venue.location);
    }
  }

  let routes;
  try {
    routes = await provider.computeTravelTimes({
      origin,
      destinations: uniqueDestinations,
      mode: normalizedMode,
      estimateContext,
      targetTime: estimateContext.targetTime,
      targetTimeType: estimateContext.targetTimeType,
    });
  } catch (error) {
    if (error instanceof MapsError) throw error;
    throw new MapsError(MAPS_ERROR_CODES.ROUTES_PROVIDER_ERROR, 'Travel time provider failed', { cause: error });
  }

  return venues.map((venue) => {
    const key = `${venue.location.lat},${venue.location.lng}`;
    const route = routes[destinationKeyToIndex.get(key)];
    return {
      ...venue,
      travel: normalizeRouteResult(route, {
        mode: normalizedMode,
        valueSource: modeValueSource,
        estimateContext,
      }),
    };
  });
}

export {
  TRAVEL_MODES,
  createTravelEstimateContext,
  enrichVenueTravelTimes,
  inferTravelModeFromText,
  normalizeRouteResult,
  normalizeTargetTime,
  normalizeTravelMode,
};
