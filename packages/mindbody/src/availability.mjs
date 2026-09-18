import {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
} from '../../core/src/availability-schema.mjs';
import { DEFAULT_MINDBODY_VENUES } from './venues.mjs';

class MindbodyAvailabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MindbodyAvailabilityError';
    this.code = code;
  }
}

function addDays(isoDate, days) {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function todaySydneyIsoDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function extractJson(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  if (start >= 0) {
    const valueStart = start + startMarker.length;
    const end = html.indexOf(endMarker, valueStart);
    if (end >= 0) return JSON.parse(html.slice(valueStart, end));
  }

  const escapedStartMarker = startMarker.replaceAll('"', '\\"');
  const escapedEndMarker = endMarker.replaceAll('"', '\\"');
  const escapedStart = html.indexOf(escapedStartMarker);
  if (escapedStart < 0) return null;
  const escapedValueStart = escapedStart + escapedStartMarker.length;
  const escapedEnd = html.indexOf(escapedEndMarker, escapedValueStart);
  if (escapedEnd < 0) return null;
  const decoded = JSON.parse(`"${html.slice(escapedValueStart, escapedEnd)}"`);
  return JSON.parse(decoded);
}

function parseSchedulePage(html) {
  const availability = extractJson(html, '"initialAvailabilityData":', ',"appointmentDetailsData"');
  const staffMembers = extractJson(html, '"staffMembers":', ',"displayStaffNameWhenChoosingAnyStaff"');
  if (!availability || !Array.isArray(staffMembers)) {
    throw new MindbodyAvailabilityError('MINDBODY_MALFORMED_RESPONSE', 'Mindbody schedule page did not contain availability metadata');
  }
  return { availability, staffMembers };
}

function bookingUrlForCourt(venue, providerCourtId) {
  const url = new URL(venue.officialUrl);
  url.searchParams.set('staffId', providerCourtId);
  return url.href;
}

function normalizeAvailability({ venue, schedule, date, days, observedAt }) {
  const staffById = new Map(schedule.staffMembers.map((staff) => [String(staff.id), staff]));
  const allowedDates = new Set(Array.from({ length: days }, (_, offset) => addDays(date, offset)));
  const records = [];

  for (const [slotDate, dayParts] of Object.entries(schedule.availability)) {
    if (!allowedDates.has(slotDate)) continue;
    for (const slots of Object.values(dayParts ?? {})) {
      for (const slot of slots ?? []) {
        for (const providerCourtId of slot.availableStaff ?? []) {
          const staff = staffById.get(String(providerCourtId));
          if (!staff) continue;
          const canonical = canonicalAvailability({
            provider: 'mindbody',
            venue: {
              id: venue.id,
              name: venue.name,
              providerVenueId: venue.widgetId,
              location: venue.location,
              address: venue.address,
              suburb: venue.suburb,
            },
            court: {
              id: `mindbody-court-${providerCourtId}`,
              name: staff.displayLabel,
              providerCourtId,
              surface: null,
            },
            startTime: slot.time,
            durationMinutes: venue.durationMinutes,
            price: { amount: null, currency: 'AUD', confidence: 'unknown' },
            eligibility: {
              sport: { type: 'tennis', proof: 'provider_resource' },
            },
            provenance: {
              source: 'live',
              auth: 'public',
              observedAt,
              availabilityMethod: 'mindbody_public_schedule',
            },
          });
          records.push(legacyAvailabilityFromCanonical(canonical, {
            sourceMetadata: {
              officialUrl: venue.officialUrl,
              bookingUrl: bookingUrlForCourt(venue, providerCourtId),
            },
          }));
        }
      }
    }
  }

  const starts = new Set(records.map((record) => `${record.court}|${Date.parse(record.startTime)}`));
  return records.map((record) => ({
    ...record,
    nextHourAlsoAvailable: starts.has(`${record.court}|${Date.parse(record.startTime) + venue.durationMinutes * 60000}`),
  }));
}

async function getMindbodyAvailability({
  venues = DEFAULT_MINDBODY_VENUES,
  date = todaySydneyIsoDate(),
  days = 1,
  durationMinutes = 60,
  fetchImpl = fetch,
  signal = null,
} = {}) {
  if (durationMinutes !== 60) return [];
  const observedAt = new Date().toISOString();
  const results = [];
  const failures = [];

  for (const venue of venues.filter((item) => item.enabled !== false)) {
    try {
      const response = await fetchImpl(venue.officialUrl, { signal });
      if (!response.ok) {
        throw new MindbodyAvailabilityError('MINDBODY_PROVIDER_ERROR', `Mindbody schedule returned HTTP ${response.status}`);
      }
      const schedule = parseSchedulePage(await response.text());
      results.push(...normalizeAvailability({ venue, schedule, date, days, observedAt }));
    } catch (error) {
      failures.push({
        venue: venue.name,
        url: venue.officialUrl,
        code: error.code ?? 'MINDBODY_PROVIDER_ERROR',
        message: error.message,
      });
    }
  }

  if (failures.length > 0) {
    const error = new MindbodyAvailabilityError('MINDBODY_PARTIAL_FAILURE', 'One or more Mindbody venues failed availability acquisition');
    error.failures = failures;
    error.availability = results;
    throw error;
  }
  return results;
}

export {
  MindbodyAvailabilityError,
  bookingUrlForCourt,
  getMindbodyAvailability,
  normalizeAvailability,
  parseSchedulePage,
};
