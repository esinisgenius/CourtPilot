function isValidCoordinate({ lat, lng } = {}) {
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180;
}

function assertValidCoordinate(point, label = 'coordinate') {
  if (!isValidCoordinate(point)) {
    throw new Error(`${label} must contain valid lat/lng`);
  }
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function haversineMeters(a, b) {
  assertValidCoordinate(a, 'origin');
  assertValidCoordinate(b, 'destination');

  const earthRadiusMeters = 6371000;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return Math.round(2 * earthRadiusMeters * Math.asin(Math.sqrt(h)));
}

function roundedPoint(point, precision = 5) {
  assertValidCoordinate(point);
  const factor = 10 ** precision;
  return {
    lat: Math.round(point.lat * factor) / factor,
    lng: Math.round(point.lng * factor) / factor,
  };
}

export {
  assertValidCoordinate,
  haversineMeters,
  isValidCoordinate,
  roundedPoint,
};
