import { defaultMapsCache, stableJson } from './cache.mjs';
import { MAPS_ERROR_CODES, MapsError, providerError, redactSecret } from './errors.mjs';
import { haversineMeters, isValidCoordinate, roundedPoint } from './geo.mjs';
import { TRAVEL_MODES, normalizeTravelMode } from './travel-time.mjs';

const GOOGLE_GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_PLACES_TTL_MS = 20 * 60 * 1000;
const GOOGLE_ROUTES_TTL_MS = 5 * 60 * 1000;

function getGoogleMapsApiKey(env = process.env) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new MapsError(MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED, 'GOOGLE_MAPS_API_KEY is not configured');
  }
  return key;
}

async function parseGoogleResponse(response, errorCode) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const providerMessage = json?.error?.message ?? json?.error_message ?? response.statusText;
    throw providerError(errorCode, `Google Maps provider error ${response.status}: ${providerMessage}`, {
      details: redactSecret(text.slice(0, 500)),
    });
  }

  return json;
}

async function parseGoogleNdjsonResponse(response, errorCode) {
  const text = await response.text();
  if (!response.ok) {
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const providerMessage = json?.error?.message ?? response.statusText;
    throw providerError(errorCode, `Google Maps provider error ${response.status}: ${providerMessage}`, {
      details: redactSecret(text.slice(0, 500)),
    });
  }

  try {
    const json = text ? JSON.parse(text) : [];
    return Array.isArray(json) ? json : [];
  } catch {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function secondsToMinutes(duration) {
  if (typeof duration === 'string' && duration.endsWith('s')) {
    return Number(duration.slice(0, -1)) / 60;
  }
  if (Number.isFinite(duration)) return duration / 60;
  return null;
}

function isOkRouteElementStatus(status) {
  if (status === null || status === undefined) return true;
  if (typeof status !== 'object') return false;
  if (Object.keys(status).length === 0) return true;
  if (status.code === 0 || status.code === '0') return true;
  if (status.status === 'OK') return true;
  return false;
}

function routeElementStatusReason(status) {
  if (!status || typeof status !== 'object') return 'route_status_error';
  if (status.message) return status.message;
  if (status.status) return `route_status_${String(status.status).toLowerCase()}`;
  if (status.code !== undefined) return `route_status_code_${status.code}`;
  return 'route_status_error';
}

function normalizeRouteMatrixElement(row) {
  if (!row) {
    return { status: 'unavailable', reason: 'route_unavailable' };
  }

  if (row.condition === 'ROUTE_NOT_FOUND') {
    return { status: 'unavailable', reason: 'route_not_found' };
  }

  if (!isOkRouteElementStatus(row.status)) {
    return { status: 'unavailable', reason: routeElementStatusReason(row.status) };
  }

  if (row.condition && row.condition !== 'ROUTE_EXISTS') {
    return { status: 'unavailable', reason: 'route_condition_unavailable' };
  }

  return {
    durationMinutes: secondsToMinutes(row.duration),
    distanceMeters: row.distanceMeters ?? null,
  };
}

function routePointCacheKey(point) {
  return stableJson({
    placeId: point.placeId ?? null,
    location: roundedPoint(point),
  });
}

function routeWaypoint(point) {
  if (point.placeId) {
    return { placeId: point.placeId };
  }

  return {
    location: {
      latLng: {
        latitude: point.lat,
        longitude: point.lng,
      },
    },
  };
}

function safeGeocodeDetails(json) {
  return {
    providerStatus: json?.status ?? null,
    resultCount: Array.isArray(json?.results) ? json.results.length : 0,
  };
}

function assertSuccessfulGeocodeStatus(json) {
  if (json?.status === 'OK') return;
  if (json?.status === 'ZERO_RESULTS') return;

  throw providerError(
    MAPS_ERROR_CODES.MAPS_PROVIDER_ERROR,
    `Google Geocoding status ${json?.status ?? 'UNKNOWN'}: ${json?.error_message ?? 'No result was returned'}`,
    { details: safeGeocodeDetails(json) },
  );
}

function selectReliableGeocodeResult(results = []) {
  return results.find((result) => isValidCoordinate({
    lat: result?.geometry?.location?.lat,
    lng: result?.geometry?.location?.lng,
  })) ?? null;
}

class GoogleMapsProvider {
  constructor({
    apiKey,
    fetchImpl = globalThis.fetch,
    cache = defaultMapsCache,
    env = process.env,
    maxRouteBatchSize = 25,
  } = {}) {
    this.apiKey = apiKey ?? getGoogleMapsApiKey(env);
    this.fetch = fetchImpl;
    this.cache = cache;
    this.maxRouteBatchSize = maxRouteBatchSize;
    if (!this.fetch) throw new MapsError(MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED, 'fetch is not available');
  }

  async geocode({ query }) {
    const trimmed = query.trim();
    const cacheKey = `geocode:${trimmed.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', trimmed);
    url.searchParams.set('key', this.apiKey);
    const json = await parseGoogleResponse(await this.fetch(url), MAPS_ERROR_CODES.MAPS_PROVIDER_ERROR);
    assertSuccessfulGeocodeStatus(json);

    if (json.status === 'ZERO_RESULTS') return null;
    const first = selectReliableGeocodeResult(json.results);
    if (!first) return null;
    const value = {
      label: first.formatted_address ?? trimmed,
      address: first.formatted_address ?? null,
      lat: first.geometry.location.lat,
      lng: first.geometry.location.lng,
      placeId: first.place_id ?? null,
      providerMetadata: {
        provider: 'google_geocoding',
        providerStatus: json.status,
        resultCount: json.results.length,
        resultTypes: first.types ?? [],
        locationType: first.geometry.location_type ?? null,
        reliabilityDecision: 'accepted_first_valid_coordinate_result',
      },
    };
    return this.cache.set(cacheKey, value, GOOGLE_GEOCODE_TTL_MS);
  }

  async searchPlaces({ query, center, radiusMeters, limit = 10 }) {
    const cacheKey = `places:${stableJson({ query, center: roundedPoint(center), radiusMeters, limit })}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const body = {
      includedTypes: [query],
      maxResultCount: Math.min(Math.max(limit, 1), 20),
      rankPreference: 'DISTANCE',
      locationRestriction: {
        circle: {
          center: {
            latitude: center.lat,
            longitude: center.lng,
          },
          radius: radiusMeters,
        },
      },
    };

    const response = await this.fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types',
      },
      body: JSON.stringify(body),
    });
    const json = await parseGoogleResponse(response, MAPS_ERROR_CODES.MAPS_PROVIDER_ERROR);
    const places = (json.places ?? []).map((place) => {
      const location = place.location ? { lat: place.location.latitude, lng: place.location.longitude } : null;
      return {
        placeId: place.id ?? null,
        name: place.displayName?.text ?? null,
        address: place.formattedAddress ?? null,
        location,
        providerTypes: place.types ?? [],
        geoDistanceMeters: location ? haversineMeters(center, location) : null,
      };
    });
    return this.cache.set(cacheKey, places, GOOGLE_PLACES_TTL_MS);
  }

  async computeTravelTimes({
    origin,
    destinations,
    mode = TRAVEL_MODES.TRANSIT,
    estimateContext,
    targetTime,
    targetTimeType,
  } = {}) {
    const normalizedMode = normalizeTravelMode(mode);
    const results = [];

    for (let offset = 0; offset < destinations.length; offset += this.maxRouteBatchSize) {
      const chunk = destinations.slice(offset, offset + this.maxRouteBatchSize);
      const chunkResults = await this.computeTravelTimesChunk({
        origin,
        destinations: chunk,
        mode: normalizedMode,
        estimateContext,
        targetTime,
        targetTimeType,
      });
      results.push(...chunkResults);
    }

    return results;
  }

  async computeTravelTimesChunk({ origin, destinations, mode, estimateContext, targetTime, targetTimeType }) {
    const cacheKey = `routes:${stableJson({
      origin: routePointCacheKey(origin),
      destinations: destinations.map((destination) => routePointCacheKey(destination)),
      mode,
      estimateContext,
      targetTime: targetTime ?? null,
      targetTimeType: targetTimeType ?? null,
    })}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const body = {
      origins: [{
        waypoint: routeWaypoint(origin),
      }],
      destinations: destinations.map((destination) => ({
        waypoint: routeWaypoint(destination),
      })),
      travelMode: mode === TRAVEL_MODES.WALK ? 'WALK' : mode,
    };

    if (targetTime) {
      if (targetTimeType === 'departure') {
        body.departureTime = targetTime;
      } else {
        body.arrivalTime = targetTime;
      }
    }

    const response = await this.fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,status,condition,distanceMeters,duration,localizedValues',
      },
      body: JSON.stringify(body),
    });
    const rows = await parseGoogleNdjsonResponse(response, MAPS_ERROR_CODES.ROUTES_PROVIDER_ERROR);
    const byDestination = new Map(rows.map((row) => [row.destinationIndex, row]));
    const value = destinations.map((_, index) => normalizeRouteMatrixElement(byDestination.get(index)));

    return this.cache.set(cacheKey, value, GOOGLE_ROUTES_TTL_MS);
  }
}

function createGoogleMapsProvider(options = {}) {
  return new GoogleMapsProvider(options);
}

export {
  GOOGLE_GEOCODE_TTL_MS,
  GOOGLE_PLACES_TTL_MS,
  GOOGLE_ROUTES_TTL_MS,
  GoogleMapsProvider,
  createGoogleMapsProvider,
  getGoogleMapsApiKey,
  isOkRouteElementStatus,
  normalizeRouteMatrixElement,
  routePointCacheKey,
  routeWaypoint,
  selectReliableGeocodeResult,
};
