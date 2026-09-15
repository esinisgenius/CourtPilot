const SYDNEY_TIME_ZONE = 'Australia/Sydney';

const CANONICAL_LOCATIONS = Object.freeze([
  {
    id: 'sydney-cbd',
    canonicalName: 'Sydney CBD',
    kind: 'area',
    aliases: ['city', 'cbd', 'downtown', '市中心', '悉尼市区', 'sydney city', 'sydney cbd'],
    center: { lat: -33.8688, lng: 151.2093 },
    radiusMeters: 3000,
    weatherRegion: 'sydney',
    confidence: 'high',
  },
  {
    id: 'strathfield',
    canonicalName: 'Strathfield',
    kind: 'suburb',
    aliases: ['strathfield', 'strathfield附近'],
    center: { lat: -33.8791, lng: 151.0836 },
    radiusMeters: 3000,
    weatherRegion: 'inner-west',
    nearbyWeatherLocations: ['burwood', 'sydney-cbd'],
    confidence: 'high',
  },
  {
    id: 'burwood',
    canonicalName: 'Burwood',
    kind: 'suburb',
    aliases: ['burwood', 'burwood附近'],
    center: { lat: -33.8775, lng: 151.1035 },
    radiusMeters: 3000,
    weatherRegion: 'inner-west',
    nearbyWeatherLocations: ['strathfield', 'sydney-cbd'],
    confidence: 'high',
  },
  {
    id: 'usyd',
    canonicalName: 'University of Sydney',
    kind: 'landmark',
    aliases: ['usyd', 'sydney uni', '悉尼大学', 'near usyd', 'usyd附近'],
    center: { lat: -33.8886, lng: 151.1873 },
    radiusMeters: 3000,
    weatherRegion: 'sydney',
    nearbyWeatherLocations: ['sydney-cbd'],
    confidence: 'high',
  },
  {
    id: 'central',
    canonicalName: 'Central Station',
    kind: 'landmark',
    aliases: ['central', 'central station', 'near central', 'central附近', '中央车站'],
    center: { lat: -33.883, lng: 151.207 },
    radiusMeters: 3000,
    weatherRegion: 'sydney',
    nearbyWeatherLocations: ['sydney-cbd'],
    confidence: 'high',
  },
]);

function normalizeLocationQuery(text = '') {
  return String(text)
    .toLowerCase()
    .replaceAll('附近', ' ')
    .replace(/\bnear\b/g, ' ')
    .replace(/\baround\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalLocationToTarget(location, { sourceText } = {}) {
  return {
    id: location.id,
    text: sourceText ?? location.canonicalName,
    canonicalName: location.canonicalName,
    kind: location.kind,
    center: location.center,
    lat: location.center.lat,
    lng: location.center.lng,
    radiusMeters: location.radiusMeters,
    timezone: SYDNEY_TIME_ZONE,
    weatherRegion: location.weatherRegion,
    nearbyWeatherLocations: location.nearbyWeatherLocations ?? [],
    source: 'static_location_alias',
    confidence: location.confidence,
  };
}

function resolveCanonicalLocation(text) {
  const normalized = normalizeLocationQuery(text);
  if (!normalized) return null;

  for (const location of CANONICAL_LOCATIONS) {
    const aliases = [location.canonicalName, ...(location.aliases ?? [])];
    if (aliases.some((alias) => normalizeLocationQuery(alias) === normalized)) {
      return canonicalLocationToTarget(location, { sourceText: text });
    }
  }

  return null;
}

function canonicalWeatherLocation(locationId) {
  const location = CANONICAL_LOCATIONS.find((entry) => entry.id === locationId);
  if (!location) return null;
  return {
    id: location.id,
    label: location.canonicalName,
    latitude: location.center.lat,
    longitude: location.center.lng,
    timezone: SYDNEY_TIME_ZONE,
    source: 'canonical_location',
    weatherRegion: location.weatherRegion,
  };
}

function allCanonicalWeatherLocations() {
  return CANONICAL_LOCATIONS.map((location) => canonicalWeatherLocation(location.id));
}

export {
  CANONICAL_LOCATIONS,
  SYDNEY_TIME_ZONE,
  allCanonicalWeatherLocations,
  canonicalLocationToTarget,
  canonicalWeatherLocation,
  normalizeLocationQuery,
  resolveCanonicalLocation,
};
