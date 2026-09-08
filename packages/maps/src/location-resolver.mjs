import { MAPS_ERROR_CODES, MapsError } from './errors.mjs';
import { assertValidCoordinate, isValidCoordinate } from './geo.mjs';
import { getSavedPlayArea } from './saved-areas.mjs';

const LOCATION_SOURCES = Object.freeze({
  USER_EXPLICIT: 'user_explicit',
  SAVED_AREA: 'saved_area',
  DEVICE_GEOLOCATION: 'device_geolocation',
});

function normalizeDeviceLocation(input) {
  if (!isValidCoordinate(input)) {
    throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, 'Device location has malformed coordinates');
  }
  return {
    label: input.label ?? 'Current location',
    lat: input.lat,
    lng: input.lng,
    source: LOCATION_SOURCES.DEVICE_GEOLOCATION,
  };
}

function normalizeSavedAreaLocation(area) {
  assertValidCoordinate(area.center, 'saved area center');
  return {
    label: area.label,
    lat: area.center.lat,
    lng: area.center.lng,
    source: LOCATION_SOURCES.SAVED_AREA,
    areaId: area.id,
    defaultRadiusMeters: area.defaultRadiusMeters,
  };
}

async function resolveUserTextLocation(input, { provider } = {}) {
  if (!provider?.geocode) {
    throw new MapsError(MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED, 'Maps provider is not configured for geocoding');
  }
  const query = input.query?.trim();
  if (!query) {
    throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, 'Location text is empty');
  }

  const resolved = await provider.geocode({ query });
  if (!resolved || !isValidCoordinate(resolved)) {
    throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, `Could not reliably resolve location: ${query}`);
  }

  return {
    label: resolved.label ?? resolved.address ?? query,
    lat: resolved.lat,
    lng: resolved.lng,
    source: LOCATION_SOURCES.USER_EXPLICIT,
    placeId: resolved.placeId ?? null,
    providerMetadata: resolved.providerMetadata ?? null,
  };
}

async function resolveLocation(input, {
  provider,
  savedAreasPath,
} = {}) {
  if (!input || typeof input !== 'object') {
    throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, 'Location input is required');
  }

  if (input.type === 'user_text') {
    return resolveUserTextLocation(input, { provider });
  }

  if (input.type === 'saved_area') {
    const area = await getSavedPlayArea(input.areaId, { filePath: savedAreasPath });
    if (!area) {
      throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, `Saved play area not found: ${input.areaId}`);
    }
    return normalizeSavedAreaLocation(area);
  }

  if (input.type === 'device') {
    return normalizeDeviceLocation(input);
  }

  throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, `Unsupported location input type: ${input.type}`);
}

async function resolveLocationFromContext({
  explicitLocation,
  savedAreaId,
  deviceLocation,
  defaultSavedAreaId,
} = {}, options = {}) {
  if (explicitLocation) {
    return resolveLocation(explicitLocation, options);
  }

  const areaId = savedAreaId ?? defaultSavedAreaId;
  if (areaId) {
    return resolveLocation({ type: 'saved_area', areaId }, options);
  }

  if (deviceLocation) {
    return resolveLocation({ type: 'device', ...deviceLocation }, options);
  }

  throw new MapsError(MAPS_ERROR_CODES.LOCATION_UNRESOLVED, 'No reliable location source is available');
}

export {
  LOCATION_SOURCES,
  normalizeDeviceLocation,
  normalizeSavedAreaLocation,
  resolveLocation,
  resolveLocationFromContext,
  resolveUserTextLocation,
};
