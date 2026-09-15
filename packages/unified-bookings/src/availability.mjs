import {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
} from '../../core/src/availability-schema.mjs';
import { DEFAULT_UNIFIED_BOOKINGS_VENUES } from './venues.mjs';

const SYDNEY_TIME_ZONE = 'Australia/Sydney';

class UnifiedBookingsAvailabilityError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'UnifiedBookingsAvailabilityError';
    this.code = code;
  }
}

function todayIsoDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function normalizeVenueConfig(config) {
  if (!config?.officialUrl) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_INVALID_VENUE_CONFIG', 'Unified Bookings venue requires officialUrl');
  }
  const url = new URL(config.officialUrl);
  const locationUuid = config.locationUuid ?? url.searchParams.get('uuid');
  if (!locationUuid) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_INVALID_VENUE_CONFIG', `Unified Bookings venue URL has no uuid: ${config.officialUrl}`);
  }

  return {
    id: config.id ?? `unified-${locationUuid}`,
    name: config.name ?? 'Unified Bookings venue',
    suburb: config.suburb ?? null,
    provider: 'unified-bookings',
    sport: config.sport ?? null,
    location: config.location ?? null,
    address: config.address ?? null,
    officialUrl: config.officialUrl,
    origin: url.origin,
    locationUuid,
    enabled: config.enabled !== false,
    auditCourtCount: config.auditCourtCount ?? null,
  };
}

function discoverVenues({ venues = DEFAULT_UNIFIED_BOOKINGS_VENUES } = {}) {
  return venues
    .filter((venue) => venue?.enabled !== false)
    .map(normalizeVenueConfig);
}

function absoluteUrl(pathOrUrl, baseUrl) {
  return new URL(pathOrUrl, baseUrl).href;
}

function extractScriptUrls(html, baseUrl) {
  return [...String(html).matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => absoluteUrl(match[1], baseUrl));
}

function extractRuntimeApiConfig(text) {
  const apiBaseUrl = String(text).match(/REACT_APP_API_V1_URL:`([^`]+)`/)?.[1]
    ?? String(text).match(/REACT_APP_API_V1_URL["']?\s*[:=]\s*["']([^"',}]+)["']/)?.[1];
  const apiKey = String(text).match(/REACT_APP_API_V1_KEY:`([^`]+)`/)?.[1]
    ?? String(text).match(/REACT_APP_API_V1_KEY["']?\s*[:=]\s*["']([^"',}]+)["']/)?.[1];

  if (!apiBaseUrl || !apiKey) return null;
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    apiKey,
  };
}

async function fetchText(url, { fetchImpl = fetch, headers = {}, signal = null } = {}) {
  const response = await fetchImpl(url, {
    method: 'GET',
    signal,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...headers,
    },
  });
  if (!response.ok) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_PROVIDER_ERROR', `Unified Bookings endpoint returned HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

async function discoverPublicApiConfig(venue, { fetchImpl = fetch, signal = null } = {}) {
  const html = await fetchText(venue.officialUrl, { fetchImpl, signal });
  const inlineConfig = extractRuntimeApiConfig(html);
  if (inlineConfig) return inlineConfig;

  const scriptUrls = extractScriptUrls(html, venue.officialUrl);
  for (const scriptUrl of scriptUrls) {
    const script = await fetchText(scriptUrl, {
      fetchImpl,
      signal,
      headers: { accept: 'application/javascript,text/javascript,*/*' },
    });
    const config = extractRuntimeApiConfig(script);
    if (config) return config;
  }

  throw new UnifiedBookingsAvailabilityError('UNIFIED_API_CONFIG_MISSING', `Unable to discover public Unified Bookings API config for ${venue.name}`);
}

async function fetchJson(url, { apiKey, fetchImpl = fetch, signal = null } = {}) {
  const response = await fetchImpl(url, {
    method: 'GET',
    signal,
    headers: {
      accept: 'application/json, text/plain, */*',
      'x-api-key': apiKey,
    },
  });

  if (!response.ok) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_PROVIDER_ERROR', `Unified Bookings endpoint returned HTTP ${response.status}: ${url}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_MALFORMED_RESPONSE', `Unified Bookings endpoint returned malformed JSON: ${url}`, {
      cause: error,
    });
  }
}

function buildUnifiedBookingsUrls({ apiBaseUrl, locationUuid, date, locationId, resource }) {
  const base = apiBaseUrl.replace(/\/+$/, '');
  const urls = {
    location: `${base}/search/locations?q=${encodeURIComponent(locationUuid)}`,
    resources: `${base}/search/locations/${encodeURIComponent(locationUuid)}/resources?date=${encodeURIComponent(date)}&version=2`,
  };

  if (locationId !== undefined && resource) {
    const params = new URLSearchParams({
      locationId: String(locationId),
      locationUuid,
      date,
      resourceUuid: String(resource.uuid),
      resourceId: String(resource.id),
    });
    urls.bookingsPublic = `${base}/resource/bookingspublic?${params}`;
  }

  return urls;
}

function parseMinutes(value, fallback = null) {
  if (value == null) return fallback;
  const match = String(value).match(/^(\d+)\s*m?$/i);
  if (!match) return fallback;
  return Number(match[1]);
}

function timeToMinutes(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function localDateTime(date, minutes) {
  return `${date}T${minutesToTime(minutes)}:00`;
}

function sydneyLocalIsoFromInstant(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}:${byType.second}`;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function normalizeLocation(rawLocation, venue) {
  const location = rawLocation?.results?.[0];
  if (!location?.id || !location?.uuid) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_METADATA_MISSING', `No public Unified Bookings location found for ${venue.name}`);
  }
  return {
    id: String(location.id),
    uuid: String(location.uuid),
    name: location.name ?? venue.name,
    organisationId: location.organisation?.id == null ? null : String(location.organisation.id),
    organisationUuid: location.organisation?.uuid ?? null,
  };
}

function normalizeResources(rawResources) {
  if (!Array.isArray(rawResources?.results)) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_MALFORMED_RESPONSE', 'Unified Bookings resource response must contain results[]');
  }

  return rawResources.results
    .filter((resource) => resource?.id != null
      && resource?.uuid
      && resource?.is_active !== 0
      && resource?.display_online !== 0
      && /tennis court/i.test(String(resource?.attributes?.resource_type ?? resource?.name ?? '')))
    .map((resource) => ({
      id: String(resource.id),
      uuid: String(resource.uuid),
      name: resource.name ?? `Court ${resource.id}`,
      surface: resource.attributes?.surface_type ?? null,
      minDurationMinutes: parseMinutes(resource.attributes?.min_duration, 30),
      maxDurationMinutes: parseMinutes(resource.attributes?.max_duration, null),
      startMinutes: timeToMinutes(resource.attributes?.default_start_time ?? '07:00'),
      endMinutes: timeToMinutes(resource.attributes?.default_end_time ?? '22:30'),
      stepMinutes: parseMinutes(resource.attributes?.duration_per_chunk, 30),
      priceMetadata: {
        durationPerChunk: resource.attributes?.duration_per_chunk ?? null,
        peakPricePerChunk: resource.attributes?.peak_price_per_chunk ?? null,
        offPeakPricePerChunk: resource.attributes?.off_peak_price_per_chunk ?? null,
      },
    }));
}

function blockerTime(blocker, startKeys, endKeys) {
  const startRaw = startKeys.map((key) => blocker?.[key]).find(Boolean);
  const endRaw = endKeys.map((key) => blocker?.[key]).find(Boolean);
  const start = sydneyLocalIsoFromInstant(startRaw);
  const end = sydneyLocalIsoFromInstant(endRaw);
  if (!start || !end) return null;
  return { start, end };
}

function normalizeBlockers(rawBookingsPublic) {
  const results = rawBookingsPublic?.results;
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_MALFORMED_RESPONSE', 'Unified Bookings bookingspublic response must contain results object');
  }

  const sourceArrays = [
    results.bookings,
    results.recurrings,
    results.locked,
    results.booking_requests,
    results.pending_recurring_schedules,
    results.calendar_blockings,
  ].filter(Array.isArray);

  return sourceArrays.flatMap((rows) => rows)
    .map((row) => blockerTime(row, ['start_time', 'start', 'start_date'], ['end_time', 'end', 'end_date']))
    .filter(Boolean);
}

function blockerOverlapsSlot(blocker, date, startMinutes, endMinutes) {
  if (blocker.start.slice(0, 10) !== date && blocker.end.slice(0, 10) !== date) return false;
  return intervalsOverlap(
    startMinutes,
    endMinutes,
    timeToMinutes(blocker.start.slice(11, 16)),
    timeToMinutes(blocker.end.slice(11, 16)),
  );
}

function buildSlotsForResource({ venue, location, resource, blockers, date, durationMinutes, observedAt }) {
  if (resource.startMinutes == null || resource.endMinutes == null || resource.endMinutes <= resource.startMinutes) return [];
  if (durationMinutes < resource.minDurationMinutes) return [];
  if (resource.maxDurationMinutes != null && durationMinutes > resource.maxDurationMinutes) return [];

  const slots = [];
  for (let start = resource.startMinutes; start + durationMinutes <= resource.endMinutes; start += resource.stepMinutes) {
    const end = start + durationMinutes;
    if (blockers.some((blocker) => blockerOverlapsSlot(blocker, date, start, end))) continue;

    const canonical = canonicalAvailability({
      provider: 'unified-bookings',
      venue: {
        id: venue.id,
        name: venue.name,
        providerVenueId: location.uuid,
        suburb: venue.suburb,
        ...(venue.location ? { location: venue.location } : {}),
        ...(venue.address ? { address: venue.address } : {}),
      },
      court: {
        id: `unified-bookings-court-${resource.uuid}`,
        name: resource.name,
        providerCourtId: resource.uuid,
        surface: resource.surface,
      },
      startTime: localDateTime(date, start),
      durationMinutes,
      price: {
        amount: null,
        currency: 'AUD',
        confidence: 'unknown',
      },
      eligibility: {
        sport: {
          type: 'tennis',
          proof: 'provider_resource',
        },
      },
      provenance: {
        source: 'live',
        auth: 'public',
        observedAt,
        availabilityMethod: 'derived_first_party',
      },
    });

    slots.push(legacyAvailabilityFromCanonical(canonical, {
      nextHourAlsoAvailable: false,
      sourceMetadata: {
        officialUrl: venue.officialUrl,
        resourceId: resource.id,
        locationId: location.id,
        priceMetadata: resource.priceMetadata,
      },
    }));
  }

  return slots;
}

function withNextHourAvailability(slots) {
  const keys = new Set(slots.map((slot) => `${slot.canonical.court.providerCourtId}|${slot.startTime.slice(0, 19)}`));
  return slots.map((slot) => {
    const start = timeToMinutes(slot.startTime.slice(11, 16));
    const nextLocal = `${slot.startTime.slice(0, 10)}T${minutesToTime(start + slot.durationMinutes)}:00`;
    return {
      ...slot,
      nextHourAlsoAvailable: keys.has(`${slot.canonical.court.providerCourtId}|${nextLocal}`),
    };
  });
}

function normalizeAvailability({
  venue,
  location,
  resources,
  bookingsByResourceUuid,
  date,
  durationMinutes,
  observedAt,
}) {
  const normalizedResources = normalizeResources(resources);
  if (normalizedResources.length === 0) {
    throw new UnifiedBookingsAvailabilityError('UNIFIED_METADATA_MISSING', `No public tennis court resources found for ${venue.name}`);
  }

  const slots = [];
  for (const resource of normalizedResources) {
    slots.push(...buildSlotsForResource({
      venue,
      location,
      resource,
      blockers: bookingsByResourceUuid.get(resource.uuid) ?? [],
      date,
      durationMinutes,
      observedAt,
    }));
  }

  return withNextHourAvailability(slots)
    .sort((a, b) => `${a.startTime} ${a.venue} ${a.court}`.localeCompare(`${b.startTime} ${b.venue} ${b.court}`));
}

async function readVenueAvailability(config, {
  date = todayIsoDate(),
  durationMinutes = 60,
  fetchImpl = fetch,
  observedAt = new Date().toISOString(),
  signal = null,
} = {}) {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
    throw new Error('durationMinutes must be a positive integer');
  }

  const venue = normalizeVenueConfig(config);
  const apiConfig = await discoverPublicApiConfig(venue, { fetchImpl, signal });
  const baseUrls = buildUnifiedBookingsUrls({
    apiBaseUrl: apiConfig.apiBaseUrl,
    locationUuid: venue.locationUuid,
    date,
  });
  const [rawLocation, rawResources] = await Promise.all([
    fetchJson(baseUrls.location, { apiKey: apiConfig.apiKey, fetchImpl, signal }),
    fetchJson(baseUrls.resources, { apiKey: apiConfig.apiKey, fetchImpl, signal }),
  ]);
  const location = normalizeLocation(rawLocation, venue);
  const resources = normalizeResources(rawResources);

  const bookingsByResourceUuid = new Map();
  await Promise.all(resources.map(async (resource) => {
    const url = buildUnifiedBookingsUrls({
      apiBaseUrl: apiConfig.apiBaseUrl,
      locationUuid: location.uuid,
      locationId: location.id,
      resource,
      date,
    }).bookingsPublic;
    const rawBookings = await fetchJson(url, { apiKey: apiConfig.apiKey, fetchImpl, signal });
    bookingsByResourceUuid.set(resource.uuid, normalizeBlockers(rawBookings));
  }));

  return normalizeAvailability({
    venue,
    location,
    resources: rawResources,
    bookingsByResourceUuid,
    date,
    durationMinutes,
    observedAt,
  });
}

async function readAvailability({
  venues = DEFAULT_UNIFIED_BOOKINGS_VENUES,
  date = todayIsoDate(),
  durationMinutes = 60,
  fetchImpl = fetch,
  signal = null,
} = {}) {
  const observedAt = new Date().toISOString();
  const results = [];
  const failures = [];

  for (const venue of venues) {
    try {
      results.push(...await readVenueAvailability(venue, {
        date,
        durationMinutes,
        fetchImpl,
        observedAt,
        signal,
      }));
    } catch (error) {
      failures.push({
        venue: venue.name ?? venue.officialUrl,
        url: venue.officialUrl,
        code: error.code ?? 'UNIFIED_PROVIDER_ERROR',
        message: error.message,
      });
    }
  }

  if (failures.length > 0) {
    const error = new UnifiedBookingsAvailabilityError('UNIFIED_PARTIAL_FAILURE', 'One or more Unified Bookings venues failed availability acquisition');
    error.failures = failures;
    error.availability = results;
    throw error;
  }

  return results;
}

async function getUnifiedBookingsAvailability(options = {}) {
  return readAvailability(options);
}

export {
  UnifiedBookingsAvailabilityError,
  buildUnifiedBookingsUrls,
  discoverPublicApiConfig,
  discoverVenues,
  extractRuntimeApiConfig,
  normalizeAvailability,
  normalizeBlockers,
  normalizeLocation,
  normalizeResources,
  readAvailability,
  readVenueAvailability,
  getUnifiedBookingsAvailability,
};
