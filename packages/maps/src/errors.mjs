const MAPS_ERROR_CODES = Object.freeze({
  MAPS_NOT_CONFIGURED: 'MAPS_NOT_CONFIGURED',
  LOCATION_UNRESOLVED: 'LOCATION_UNRESOLVED',
  MAPS_PROVIDER_ERROR: 'MAPS_PROVIDER_ERROR',
  VENUE_SEARCH_FAILED: 'VENUE_SEARCH_FAILED',
  ROUTES_PROVIDER_ERROR: 'ROUTES_PROVIDER_ERROR',
  TRAVEL_TIME_UNAVAILABLE: 'TRAVEL_TIME_UNAVAILABLE',
});

class MapsError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message);
    this.name = 'MapsError';
    this.code = code;
    this.details = details ?? null;
    if (cause) this.cause = cause;
  }
}

function redactSecret(value) {
  if (!value || typeof value !== 'string') return value;
  return value.replace(/[A-Za-z0-9_\-]{20,}/g, '[redacted]');
}

function providerError(code, message, { cause, details } = {}) {
  return new MapsError(code, redactSecret(message), {
    cause,
    details: typeof details === 'string' ? redactSecret(details) : details,
  });
}

export {
  MAPS_ERROR_CODES,
  MapsError,
  providerError,
  redactSecret,
};
