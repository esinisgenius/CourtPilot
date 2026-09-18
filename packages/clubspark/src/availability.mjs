import {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
} from '../../core/src/availability-schema.mjs';
import { DEFAULT_CLUBSPARK_VENUES } from './venues.mjs';

const SYDNEY_TIME_ZONE = 'Australia/Sydney';

class ClubSparkAvailabilityError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'ClubSparkAvailabilityError';
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

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeVenueConfig(config) {
  if (!config?.officialUrl || !config?.venueSlug) {
    throw new ClubSparkAvailabilityError('CLUBSPARK_INVALID_VENUE_CONFIG', 'ClubSpark venue requires officialUrl and venueSlug');
  }
  return {
    ...config,
    provider: 'clubspark',
    apiUrl: `https://play.tennis.com.au/v0/VenueBooking/${encodeURIComponent(config.venueSlug)}/GetVenueSessions`,
  };
}

function discoverVenues({ venues = DEFAULT_CLUBSPARK_VENUES } = {}) {
  return venues.filter((venue) => venue?.enabled !== false).map(normalizeVenueConfig);
}

function buildAvailabilityUrl({ venue, date }) {
  const url = new URL(venue.apiUrl);
  url.searchParams.set('resourceID', '');
  url.searchParams.set('startDate', date);
  url.searchParams.set('endDate', date);
  url.searchParams.set('roleId', '');
  return url.href;
}

function buildBookingUrl({ venue, date, resourceIndex, startMinutes }) {
  const url = new URL(venue.officialUrl);
  url.hash = `?date=${date}&role=guest&resource=${resourceIndex}&start-time=${startMinutes}`;
  return url.href;
}

function localDateTime(date, minutes) {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return `${date}T${hour}:${minute}:00`;
}

function sessionCovers(session, start, end) {
  return Number(session.StartTime) <= start && Number(session.EndTime) >= end;
}

function priceForWindow(sessions, start, end) {
  let amount = 0;
  for (let cursor = start; cursor < end;) {
    const session = sessions.find((item) => Number(item.Capacity) > 0 && sessionCovers(item, cursor, cursor + 1));
    if (!session) return null;
    const interval = Number(session.Interval);
    if (!Number.isFinite(interval) || interval <= 0 || cursor + interval > end) return null;
    if (!Number.isFinite(Number(session.Cost))) return null;
    amount += Number(session.Cost);
    cursor += interval;
  }
  return amount;
}

function normalizeAvailability({ venue, payload, date, durationMinutes = 60, observedAt }) {
  if (!Array.isArray(payload?.Resources)) {
    throw new ClubSparkAvailabilityError('CLUBSPARK_MALFORMED_RESPONSE', 'ClubSpark response did not contain resources');
  }

  const slots = [];
  payload.Resources.forEach((resource, resourceIndex) => {
    const day = resource.Days?.find((entry) => String(entry.Date).slice(0, 10) === date);
    const sessions = day?.Sessions ?? [];
    const availableSessions = sessions.filter((session) => Number(session.Capacity) > 0);
    const blockedSessions = sessions.filter((session) => Number(session.Capacity) <= 0);
    const baseInterval = Number(payload.MinimumInterval) || 30;

    for (let start = Number(payload.EarliestStartTime); start + durationMinutes <= Number(payload.LatestEndTime); start += baseInterval) {
      const end = start + durationMinutes;
      const available = availableSessions.some((session) => sessionCovers(session, start, end))
        || Array.from({ length: durationMinutes / baseInterval }, (_, index) => start + index * baseInterval)
          .every((cursor) => availableSessions.some((session) => sessionCovers(session, cursor, cursor + baseInterval)));
      const blocked = blockedSessions.some((session) => start < Number(session.EndTime) && end > Number(session.StartTime));
      if (!available || blocked) continue;

      const price = priceForWindow(availableSessions, start, end);
      const canonical = canonicalAvailability({
        provider: 'clubspark',
        venue: {
          id: venue.id,
          name: venue.name,
          providerVenueId: venue.venueSlug,
          suburb: venue.suburb,
          location: venue.location,
          address: venue.address,
        },
        court: {
          id: `clubspark-court-${venue.venueSlug}-${resource.ID}`,
          name: resource.Name,
          providerCourtId: resource.ID,
          surface: typeof resource.Surface === 'string' ? resource.Surface : null,
        },
        startTime: localDateTime(date, start),
        durationMinutes,
        price: {
          amount: price,
          currency: 'AUD',
          confidence: price === null ? 'unknown' : 'verified',
        },
        eligibility: { sport: { type: 'tennis', proof: 'provider_resource' } },
        provenance: {
          source: 'live',
          auth: 'public',
          observedAt,
          availabilityMethod: 'direct_first_party_json',
        },
      });
      slots.push(legacyAvailabilityFromCanonical(canonical, {
        nextHourAlsoAvailable: false,
        sourceMetadata: {
          officialUrl: venue.officialUrl,
          bookingUrl: buildBookingUrl({ venue, date, resourceIndex, startMinutes: start }),
        },
      }));
    }
  });

  const keys = new Set(slots.map((slot) => `${slot.canonical.court.providerCourtId}|${slot.startTime.slice(0, 19)}`));
  return slots.map((slot) => ({
    ...slot,
    nextHourAlsoAvailable: keys.has(`${slot.canonical.court.providerCourtId}|${localDateTime(date, Number(slot.startTime.slice(11, 13)) * 60 + Number(slot.startTime.slice(14, 16)) + durationMinutes)}`),
  }));
}

async function readVenueAvailability(config, {
  date = todayIsoDate(),
  durationMinutes = 60,
  fetchImpl = fetch,
  observedAt = new Date().toISOString(),
  signal = null,
} = {}) {
  const venue = normalizeVenueConfig(config);
  const response = await fetchImpl(buildAvailabilityUrl({ venue, date }), {
    signal,
    headers: {
      accept: 'application/json',
      referer: venue.officialUrl,
    },
  });
  if (!response.ok) {
    throw new ClubSparkAvailabilityError('CLUBSPARK_PROVIDER_ERROR', `ClubSpark returned HTTP ${response.status}: ${venue.name}`);
  }
  return normalizeAvailability({ venue, payload: await response.json(), date, durationMinutes, observedAt });
}

async function readAvailability({ venues = DEFAULT_CLUBSPARK_VENUES, date = todayIsoDate(), days = 1, ...options } = {}) {
  const results = [];
  const failures = [];
  for (const config of venues.filter((venue) => venue?.enabled !== false)) {
    for (let offset = 0; offset < days; offset += 1) {
      const currentDate = addDays(date, offset);
      try {
        results.push(...await readVenueAvailability(config, { ...options, date: currentDate }));
      } catch (error) {
        failures.push({ venue: config.name, url: config.officialUrl, code: error.code ?? 'CLUBSPARK_PROVIDER_ERROR', message: error.message });
      }
    }
  }
  if (failures.length > 0) {
    const error = new ClubSparkAvailabilityError('CLUBSPARK_PARTIAL_FAILURE', 'One or more ClubSpark venues failed availability acquisition');
    error.failures = failures;
    error.availability = results;
    throw error;
  }
  return results;
}

const getClubSparkAvailability = readAvailability;

export {
  ClubSparkAvailabilityError,
  buildAvailabilityUrl,
  buildBookingUrl,
  discoverVenues,
  getClubSparkAvailability,
  normalizeAvailability,
  readAvailability,
  readVenueAvailability,
};
