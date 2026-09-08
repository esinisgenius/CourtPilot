import {
  DEFAULT_UNIFIED_BOOKINGS_VENUES,
  buildUnifiedBookingsUrls,
  discoverPublicApiConfig,
  discoverVenues,
  normalizeLocation,
  normalizeResources,
  readVenueAvailability,
} from '../packages/unified-bookings/src/index.mjs';

const date = process.env.UNIFIED_BOOKINGS_DATE ?? todaySydneyIsoDate();
const durationMinutes = Number(process.env.UNIFIED_BOOKINGS_DURATION ?? 60);
const venues = discoverVenues({ venues: DEFAULT_UNIFIED_BOOKINGS_VENUES });

function todaySydneyIsoDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

const successes = [];
const failures = [];
let total = 0;
let samples = [];

async function fetchJson(url, apiKey) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      'x-api-key': apiKey,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

for (const venue of venues) {
  try {
    const apiConfig = await discoverPublicApiConfig(venue);
    const baseUrls = buildUnifiedBookingsUrls({
      apiBaseUrl: apiConfig.apiBaseUrl,
      locationUuid: venue.locationUuid,
      date,
    });
    const [rawLocation, rawResources] = await Promise.all([
      fetchJson(baseUrls.location, apiConfig.apiKey),
      fetchJson(baseUrls.resources, apiConfig.apiKey),
    ]);
    const location = normalizeLocation(rawLocation, venue);
    const resources = normalizeResources(rawResources);
    const availability = await readVenueAvailability(venue, {
      date,
      durationMinutes,
    });
    total += availability.length;
    samples = samples.concat(availability.slice(0, Math.max(0, 5 - samples.length)));

    const courts = new Map();
    for (const slot of availability) {
      courts.set(slot.canonical.court.providerCourtId, slot.court);
    }

    successes.push({
      id: venue.id,
      name: venue.name,
      suburb: venue.suburb,
      officialUrl: venue.officialUrl,
      apiBaseUrl: apiConfig.apiBaseUrl,
      apiKeyDiscovered: true,
      providerVenueId: location.uuid,
      providerLocationId: location.id,
      dynamicCourtCount: resources.length,
      dynamicCourtCountWithAvailability: courts.size,
      slotCount: availability.length,
      auditCourtCount: venue.auditCourtCount,
      auditCountMatchesDynamic: venue.auditCourtCount === resources.length,
      courts: [...courts.values()],
      discoveredCourts: resources.map((resource) => resource.name),
    });
  } catch (error) {
    failures.push({
      id: venue.id,
      name: venue.name,
      officialUrl: venue.officialUrl,
      code: error.code ?? 'UNIFIED_PROVIDER_ERROR',
      message: error.message,
    });
  }
}

console.log(JSON.stringify({
  date,
  durationMinutes,
  venueCount: venues.length,
  successCount: successes.length,
  failureCount: failures.length,
  total,
  successes,
  failures,
  samples,
}, null, 2));

if (failures.length > 0) process.exitCode = 1;
