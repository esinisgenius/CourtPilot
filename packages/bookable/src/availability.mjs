import { DEFAULT_BOOKABLE_VENUES } from './venues.mjs';
import {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
} from '../../core/src/availability-schema.mjs';

class BookableAvailabilityError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'BookableAvailabilityError';
    this.code = code;
  }
}

function todayIsoDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
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

function parseBookableVenueUrl(rawUrl) {
  const url = new URL(rawUrl);
  const match = url.pathname.match(/\/venues\/(\d+)(?:\/([^/?#]+))?/i);
  if (!match) {
    throw new BookableAvailabilityError('BOOKABLE_INVALID_VENUE_URL', `Bookable venue URL is not recognized: ${rawUrl}`);
  }

  return {
    origin: url.origin,
    venueId: Number(match[1]),
    slug: match[2] ?? null,
    officialUrl: `${url.origin}${url.pathname}`,
  };
}

async function fetchJson(url, { fetchImpl = fetch, signal = null } = {}) {
  const response = await fetchImpl(url, {
    method: 'GET',
    signal,
    headers: {
      accept: 'application/json, text/plain, */*',
    },
  });

  if (!response.ok) {
    throw new BookableAvailabilityError('BOOKABLE_PROVIDER_ERROR', `Bookable endpoint returned HTTP ${response.status}: ${url}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new BookableAvailabilityError('BOOKABLE_MALFORMED_RESPONSE', `Bookable endpoint returned malformed JSON: ${url}`, {
      cause: error,
    });
  }
}

function buildBookableUrls({ origin, venueId, organisationId, fromDate, days }) {
  const toDateExclusive = addDays(fromDate, days);
  const openingToDate = addDays(fromDate, days - 1);
  const bookingParams = new URLSearchParams({
    fromDate,
    toDate: toDateExclusive,
    hideCancelledBooking: 'true',
    hideClosure: 'false',
    hideWorkBooking: 'false',
    hideBookableWorkBooking: 'true',
    excludeResource: 'true',
    hideRequestOrApplication: 'true',
    applyOnlyShowConfirmedBooking: 'true',
  });
  const bookableParams = new URLSearchParams({
    externalOnly: 'true',
    excludeResource: 'true',
    hideNotInSeason: 'true',
    date: fromDate,
    capacity: 'null',
  });
  const openingParams = new URLSearchParams({
    fromDate,
    toDate: openingToDate,
    excludeResource: 'true',
  });

  return {
    bookables: `${origin}/api/v2/venues/${venueId}/bookables?${bookableParams}`,
    bookings: `${origin}/api/v2/venues/${venueId}/bookingbookablesinperiod?${bookingParams}`,
    openingHours: `${origin}/api/v2/organisations/${organisationId}/venues/${venueId}/getopeninghours?${openingParams}`,
    settings: `${origin}/api/v2/organisations/${organisationId}/getsettings?keysstr=StepMinutes,MaxItemsPerBooking,SeasonalSeasonalLabelText&asDictionary=false`,
  };
}

function normalizeVenueConfig(config) {
  const officialUrl = config.officialUrl ?? config.url;
  const parsed = parseBookableVenueUrl(officialUrl);
  return {
    id: config.id ?? `bookable-${parsed.venueId}`,
    provider: 'bookable',
    suburb: config.suburb ?? null,
    council: config.council ?? null,
    location: config.location ?? null,
    address: config.address ?? null,
    name: config.name ?? parsed.slug ?? `Bookable venue ${parsed.venueId}`,
    organisationId: config.organisationId ?? 1,
    enabled: config.enabled !== false,
    auditCourtCount: config.auditCourtCount ?? null,
    url: officialUrl,
    ...parsed,
    venueId: config.venueId ?? parsed.venueId,
  };
}

function discoverVenues({ venues = DEFAULT_BOOKABLE_VENUES } = {}) {
  return venues
    .filter((venue) => venue?.enabled !== false)
    .map(normalizeVenueConfig);
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

function normalizeResources(rawBookables, venue) {
  if (!Array.isArray(rawBookables)) {
    throw new BookableAvailabilityError('BOOKABLE_MALFORMED_RESPONSE', 'Bookable resource response is not an array');
  }

  return rawBookables
    .filter((bookable) => bookable?.BookableID && bookable?.ExternalSearchable !== false && isTennisResource(bookable))
    .map((bookable) => ({
      provider: 'bookable',
      venue: venue.name,
      venueRecordId: venue.id,
      council: venue.council,
      suburb: venue.suburb,
      location: venue.location,
      address: venue.address,
      venueId: venue.venueId,
      resourceId: bookable.BookableID,
      itemId: bookable.ItemID ?? null,
      court: bookable.Name ?? bookable.BookableID,
      officialUrl: venue.officialUrl,
      leadDateTime: bookable.LeadDateTime ?? null,
      minDurationMinutes: Number(bookable.BookingMinDuration ?? 30),
      maxDurationMinutes: bookable.BookingMaxDuration == null ? null : Number(bookable.BookingMaxDuration),
      priceOptions: normalizePriceOptions(bookable),
    }));
}

function normalizePriceOptions(bookable) {
  const options = [];
  if (typeof bookable?.HourlyRate === 'number') {
    options.push({
      name: 'Hourly Rate',
      amount: bookable.HourlyRate,
      currency: 'AUD',
      durationMinutes: 60,
    });
  }
  return options;
}

function normalizeOpeningHours(rawOpeningHours) {
  if (!Array.isArray(rawOpeningHours)) {
    throw new BookableAvailabilityError('BOOKABLE_MALFORMED_RESPONSE', 'Bookable opening-hours response is not an array');
  }

  const byResource = new Map();
  for (const entry of rawOpeningHours) {
    if (!entry?.Key || !Array.isArray(entry.Value)) continue;
    byResource.set(entry.Key, entry.Value
      .filter((hours) => hours?.Available !== false && hours?.IsOpen !== false)
      .map((hours) => ({
        date: String(hours.Date ?? '').slice(0, 10),
        openTime: String(hours.OpenTime ?? '').slice(0, 8),
        closeTime: String(hours.CloseTime ?? '').slice(0, 8),
      }))
      .filter((hours) => /^\d{4}-\d{2}-\d{2}$/.test(hours.date)
        && /^\d{2}:\d{2}:\d{2}$/.test(hours.openTime)
        && /^\d{2}:\d{2}:\d{2}$/.test(hours.closeTime)));
  }
  return byResource;
}

function normalizeBookings(rawBookings) {
  if (!Array.isArray(rawBookings)) {
    throw new BookableAvailabilityError('BOOKABLE_MALFORMED_RESPONSE', 'Bookable bookings response is not an array');
  }

  const byResource = new Map();
  for (const booking of rawBookings) {
    if (!booking?.BookableID || !booking.Start_Date || !booking.End_Date) continue;
    const rows = byResource.get(booking.BookableID) ?? [];
    rows.push({
      start: booking.Buffer_Start ?? booking.Start_Date,
      end: booking.Buffer_End ?? booking.End_Date,
      status: booking.BookingStatusName ?? null,
    });
    byResource.set(booking.BookableID, rows);
  }
  return byResource;
}

function normalizeStepMinutes(rawSettings, resources) {
  const fallback = Math.min(...resources.map((resource) => resource.minDurationMinutes || 30), 30);
  if (!Array.isArray(rawSettings)) return fallback;

  const stepSetting = rawSettings.find((setting) => setting?.key === 'StepMinutes');
  const stepMinutes = Number(stepSetting?.value);
  if (!Number.isInteger(stepMinutes) || stepMinutes < 1) return fallback;
  return stepMinutes;
}

function timeToMinutes(time) {
  const match = String(time).match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function localDateTime(date, minutes) {
  return `${date}T${minutesToTime(minutes)}:00`;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function bookingOverlapsSlot(booking, date, startMinutes, endMinutes) {
  const bookingDate = String(booking.start).slice(0, 10);
  if (bookingDate !== date) return false;
  return intervalsOverlap(
    startMinutes,
    endMinutes,
    timeToMinutes(String(booking.start).slice(11, 16)),
    timeToMinutes(String(booking.end).slice(11, 16)),
  );
}

function isAtOrAfterLeadTime(date, startMinutes, leadDateTime) {
  if (!leadDateTime) return true;
  return localDateTime(date, startMinutes) >= String(leadDateTime).slice(0, 19);
}

function buildSlotsForResource(resource, openingHours, bookings, {
  durationMinutes,
  observedAt,
  slotStepMinutes,
}) {
  if (resource.maxDurationMinutes != null && durationMinutes > resource.maxDurationMinutes) return [];

  const slots = [];
  for (const hours of openingHours) {
    const open = timeToMinutes(hours.openTime);
    const close = timeToMinutes(hours.closeTime);
    if (open == null || close == null || close <= open) continue;

    for (let start = open; start + durationMinutes <= close; start += slotStepMinutes) {
      const end = start + durationMinutes;
      if (!isAtOrAfterLeadTime(hours.date, start, resource.leadDateTime)) continue;
      if (bookings.some((booking) => bookingOverlapsSlot(booking, hours.date, start, end))) continue;

      const canonical = canonicalAvailability({
        provider: 'bookable',
        venue: {
          id: resource.venueRecordId ?? `bookable-venue-${resource.venueId}`,
          name: resource.venue,
          providerVenueId: resource.venueId,
          suburb: resource.suburb,
          ...(resource.location ? { location: resource.location } : {}),
          ...(resource.address ? { address: resource.address } : {}),
        },
        court: {
          id: `bookable-court-${resource.resourceId}`,
          name: resource.court,
          providerCourtId: resource.resourceId,
          surface: null,
        },
        startTime: localDateTime(hours.date, start),
        durationMinutes,
        priceOptions: resource.priceOptions,
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
          itemId: resource.itemId,
          officialUrl: resource.officialUrl,
        },
      }));
    }
  }
  return slots;
}

function withNextHourAvailability(slots) {
  const keys = new Set(slots.map((slot) => `${slot.resourceId}|${slot.startTime.slice(0, 19)}`));
  return slots.map((slot) => {
    const localStart = slot.startTime.slice(0, 19);
    const nextLocal = `${localStart.slice(0, 10)}T${minutesToTime(timeToMinutes(localStart.slice(11, 16)) + slot.durationMinutes)}:00`;
    return {
      ...slot,
      nextHourAlsoAvailable: keys.has(`${slot.resourceId}|${nextLocal}`),
    };
  });
}

function normalizeAvailability({ venue, rawBookables, rawOpeningHours, rawBookings, rawSettings = [], durationMinutes, observedAt }) {
  const resources = normalizeResources(rawBookables, venue);
  if (resources.length === 0) {
    throw new BookableAvailabilityError('BOOKABLE_METADATA_MISSING', `No public Bookable resources found for ${venue.name}`);
  }

  const openingByResource = normalizeOpeningHours(rawOpeningHours);
  const bookingsByResource = normalizeBookings(rawBookings);
  const slotStepMinutes = normalizeStepMinutes(rawSettings, resources);
  const slots = [];

  for (const resource of resources) {
    const openingHours = openingByResource.get(resource.resourceId) ?? [];
    const bookings = bookingsByResource.get(resource.resourceId) ?? [];
    slots.push(...buildSlotsForResource(resource, openingHours, bookings, {
      durationMinutes,
      observedAt,
      slotStepMinutes,
    }));
  }

  return withNextHourAvailability(slots)
    .sort((a, b) => `${a.startTime} ${a.venue} ${a.court}`.localeCompare(`${b.startTime} ${b.venue} ${b.court}`));
}

async function readVenueAvailability(config, {
  date = todayIsoDate(),
  days = 7,
  durationMinutes = 60,
  fetchImpl = fetch,
  observedAt = new Date().toISOString(),
  signal = null,
} = {}) {
  if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive integer');
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) throw new Error('durationMinutes must be a positive integer');

  const venue = normalizeVenueConfig(config);
  const urls = buildBookableUrls({
    origin: venue.origin,
    venueId: venue.venueId,
    organisationId: venue.organisationId,
    fromDate: date,
    days,
  });

  const [rawBookables, rawBookings, rawOpeningHours, rawSettings] = await Promise.all([
    fetchJson(urls.bookables, { fetchImpl, signal }),
    fetchJson(urls.bookings, { fetchImpl, signal }),
    fetchJson(urls.openingHours, { fetchImpl, signal }),
    fetchJson(urls.settings, { fetchImpl, signal }),
  ]);

  return normalizeAvailability({
    venue,
    rawBookables,
    rawOpeningHours,
    rawBookings,
    rawSettings,
    durationMinutes,
    observedAt,
  });
}

async function readAvailability({
  venues = DEFAULT_BOOKABLE_VENUES,
  date = todayIsoDate(),
  days = 7,
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
        days,
        durationMinutes,
        fetchImpl,
        observedAt,
        signal,
      }));
    } catch (error) {
      failures.push({
        venue: venue.name ?? venue.url,
        url: venue.url,
        code: error.code ?? 'BOOKABLE_PROVIDER_ERROR',
        message: error.message,
      });
    }
  }

  if (failures.length > 0) {
    const error = new BookableAvailabilityError('BOOKABLE_PARTIAL_FAILURE', 'One or more Bookable venues failed availability acquisition');
    error.failures = failures;
    error.availability = results;
    throw error;
  }

  return results;
}

async function getBookableAvailability(options = {}) {
  const availability = await readAvailability(options);
  return availability;
}

export {
  BookableAvailabilityError,
  DEFAULT_BOOKABLE_VENUES,
  buildBookableUrls,
  discoverVenues,
  getBookableAvailability,
  normalizeAvailability,
  parseBookableVenueUrl,
  readAvailability,
  readVenueAvailability,
};
