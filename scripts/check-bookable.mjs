import {
  DEFAULT_BOOKABLE_VENUES,
  buildBookableUrls,
  discoverVenues,
  readVenueAvailability,
} from '../packages/bookable/src/index.mjs';

const days = Number(process.env.BOOKABLE_DAYS_COUNT ?? 1);
const durationMinutes = Number(process.env.BOOKABLE_DURATION ?? 60);
const date = process.env.BOOKABLE_DATE ?? todaySydneyIsoDate();
const venues = discoverVenues({ venues: DEFAULT_BOOKABLE_VENUES });
const successes = [];
const failures = [];
let total = 0;
let samples = [];

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

async function fetchJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function isTennisResource(bookable) {
  const name = String(bookable?.Name ?? '');
  if (/caretaker/i.test(name)) return false;

  if (Array.isArray(bookable?.ActivityTypes) && bookable.ActivityTypes.length > 0) {
    return bookable.ActivityTypes.some((activity) => String(activity?.name ?? activity?.Name ?? '')
      .toLowerCase()
      .includes('tennis'));
  }

  return /tennis|acrylic hard court|synthetic grass court/i.test(name);
}

for (const venue of venues) {
  try {
    const pageResponse = await fetch(venue.officialUrl, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    if (!pageResponse.ok) throw new Error(`Venue page returned HTTP ${pageResponse.status}`);

    const urls = buildBookableUrls({
      origin: venue.origin,
      venueId: venue.venueId,
      organisationId: venue.organisationId,
      fromDate: date,
      days,
    });
    const [rawBookables, rawOpeningHours, rawBookings, rawSettings] = await Promise.all([
      fetchJson(urls.bookables),
      fetchJson(urls.openingHours),
      fetchJson(urls.bookings),
      fetchJson(urls.settings),
    ]);
    const resources = rawBookables.filter((bookable) => bookable?.BookableID
      && bookable?.ExternalSearchable !== false
      && isTennisResource(bookable));

    const availability = await readVenueAvailability(venue, {
      date,
      days,
      durationMinutes,
    });
    total += availability.length;
    samples = samples.concat(availability.slice(0, Math.max(0, 5 - samples.length)));
    const courts = new Set(availability.map((slot) => slot.court));
    const resourcesWithAvailability = new Set(availability.map((slot) => slot.resourceId));
    successes.push({
      id: venue.id,
      name: venue.name,
      suburb: venue.suburb,
      officialUrl: venue.officialUrl,
      venueId: venue.venueId,
      organisationId: venue.organisationId,
      pageStatus: pageResponse.status,
      resourcesStatus: 'ok',
      openingHoursStatus: Array.isArray(rawOpeningHours) ? 'ok' : 'malformed',
      bookingsStatus: Array.isArray(rawBookings) ? 'ok' : 'malformed',
      settingsStatus: Array.isArray(rawSettings) ? 'ok' : 'malformed',
      dynamicCourtCount: resources.length,
      dynamicCourtsWithAvailability: resourcesWithAvailability.size,
      slotCount: availability.length,
      auditCourtCount: venue.auditCourtCount,
      auditCountMatchesDynamic: venue.auditCourtCount === resources.length,
      courts: resources.map((resource) => resource.Name),
    });
  } catch (error) {
    failures.push({
      id: venue.id,
      name: venue.name,
      officialUrl: venue.officialUrl,
      venueId: venue.venueId,
      organisationId: venue.organisationId,
      code: error.code ?? 'BOOKABLE_PROVIDER_ERROR',
      message: error.message,
    });
  }
}

const byVenue = {};
for (const success of successes) {
  byVenue[success.name] = {
    suburb: success.suburb,
    slotCount: success.slotCount,
    dynamicCourtsWithAvailability: success.dynamicCourtsWithAvailability,
  };
}

console.log(JSON.stringify({
  date,
  durationMinutes,
  venueCount: venues.length,
  successCount: successes.length,
  failureCount: failures.length,
  total,
  byVenue,
  successes,
  failures,
  samples,
}, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
