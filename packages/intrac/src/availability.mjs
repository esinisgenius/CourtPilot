import {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
} from '../../core/src/availability-schema.mjs';
import { DEFAULT_INTRAC_VENUES } from './venues.mjs';

const SYDNEY_TIME_ZONE = 'Australia/Sydney';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

class IntracAvailabilityError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'IntracAvailabilityError';
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
  if (!config?.officialUrl) {
    throw new IntracAvailabilityError('INTRAC_INVALID_VENUE_CONFIG', 'Intrac venue requires officialUrl');
  }
  const url = new URL(config.officialUrl);
  const locationId = config.locationId ?? url.searchParams.get('location');
  if (!locationId) {
    throw new IntracAvailabilityError('INTRAC_INVALID_VENUE_CONFIG', `Intrac schedule URL has no location: ${config.officialUrl}`);
  }
  return {
    id: config.id ?? `intrac-${locationId}`,
    name: config.name ?? 'Intrac venue',
    suburb: config.suburb ?? null,
    provider: 'intrac',
    officialUrl: config.officialUrl,
    origin: url.origin,
    schedulePath: url.pathname,
    locationId: String(locationId),
    referer: config.referer ?? null,
    enabled: config.enabled !== false,
    auditCourtCount: config.auditCourtCount ?? null,
  };
}

function discoverVenues({ venues = DEFAULT_INTRAC_VENUES } = {}) {
  return venues
    .filter((venue) => venue?.enabled !== false)
    .map(normalizeVenueConfig);
}

function buildScheduleUrl({ venue, date }) {
  const url = new URL(venue.schedulePath, venue.origin);
  url.searchParams.set('location', venue.locationId);
  url.searchParams.set('date', date);
  return url.href;
}

async function fetchScheduleHtml({ url, fetchImpl = fetch, referer = null }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': BROWSER_USER_AGENT,
      ...(referer ? { referer } : {}),
    },
  });
  if (response.status === 403) {
    throw new IntracAvailabilityError('INTRAC_BROWSER_UA_REQUIRED', `Intrac schedule returned HTTP 403: ${url}`);
  }
  if (!response.ok) {
    throw new IntracAvailabilityError('INTRAC_PROVIDER_ERROR', `Intrac schedule returned HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

function decodeHtml(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function stripTags(value) {
  return decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseAttrs(rawAttrs) {
  const attrs = {};
  for (const match of String(rawAttrs).matchAll(/([a-zA-Z:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function extractRows(html) {
  return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
}

function extractCells(rowHtml) {
  return [...String(rowHtml).matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((match) => {
    const attrs = parseAttrs(match[1]);
    return {
      attrs,
      html: match[2],
      text: stripTags(match[2]),
      colspan: Math.max(1, Number(attrs.colspan ?? 1) || 1),
    };
  });
}

function parseTimeTo24Hour(value) {
  const match = String(value).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const period = match[3].toLowerCase();
  if (period === 'pm' && hour !== 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

function parseBookingLink(cellHtml, fallbackLocationId) {
  const hrefMatch = String(cellHtml).match(/href="([^"]*(?:book|reserve)\.cfm[^"]*)"/i)
    ?? String(cellHtml).match(/href='([^']*(?:book|reserve)\.cfm[^']*)'/i);
  const href = decodeHtml(hrefMatch?.[1] ?? '');
  const inner = href.match(/(?:book|reserve)\.cfm\?([^')]+)/i)?.[1];
  if (!inner) return null;
  const params = new URLSearchParams(inner.replace(/%27$/i, ''));
  const court = String(params.get('court') ?? '').replace(/[^0-9A-Za-z_-]/g, '');
  const date = params.get('date');
  const start = params.get('start');
  if (!court || !date || !start) return null;
  return {
    locationId: params.get('location') ?? fallbackLocationId,
    date,
    start,
    providerCourtId: court,
    href,
  };
}

function normalizeCellStatus(cell, fallbackLocationId) {
  const booking = parseBookingLink(cell.html, fallbackLocationId);
  if (booking) return { status: 'available', booking };

  const bgcolor = String(cell.attrs.bgcolor ?? '').toLowerCase();
  if (bgcolor === '#f6891f') return { status: 'booked', booking: null };
  if (['#dddddd', '#cccccc'].includes(bgcolor)) return { status: 'unavailable', booking: null };
  if (bgcolor === '#99cc66') return { status: 'selected', booking: null };
  if (['#ff9900', '#ffff99', '#ff3300'].includes(bgcolor)) return { status: 'booked', booking: null };
  return { status: cell.text ? 'booked' : 'available_without_link', booking: null };
}

function parseScheduleHtml(html, { locationId }) {
  const rows = extractRows(html);
  let courtNames = null;
  const slotStates = [];

  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 2) continue;
    const firstText = cells[0].text;

    if (/^time$/i.test(firstText) && cells.slice(1).some((cell) => /^court\b/i.test(cell.text))) {
      courtNames = cells.slice(1).flatMap((cell) => Array.from({ length: cell.colspan }, () => cell.text));
      continue;
    }

    const time = parseTimeTo24Hour(firstText);
    if (!time || !courtNames) continue;

    let courtIndex = 0;
    for (const cell of cells.slice(1)) {
      const normalized = normalizeCellStatus(cell, locationId);
      for (let offset = 0; offset < cell.colspan && courtIndex < courtNames.length; offset += 1) {
        slotStates.push({
          courtIndex,
          courtName: courtNames[courtIndex],
          time,
          status: normalized.status,
          booking: normalized.booking,
        });
        courtIndex += 1;
      }
    }
  }

  if (!courtNames || courtNames.length === 0) {
    throw new IntracAvailabilityError('INTRAC_MALFORMED_RESPONSE', 'Intrac schedule did not contain court headers');
  }

  return {
    courts: courtNames.map((name, index) => ({ index, name })),
    slotStates,
    availableLinks: slotStates
      .filter((state) => state.status === 'available' && state.booking)
      .map((state) => ({
        courtIndex: state.courtIndex,
        courtName: state.courtName,
        providerCourtId: state.booking.providerCourtId,
        date: state.booking.date,
        time: state.booking.start.replace(':', ''),
        href: state.booking.href,
      })),
  };
}

function mergeCourtIdentity(courtMap, schedule) {
  for (const court of schedule.courts) {
    const current = courtMap.get(court.index) ?? {};
    courtMap.set(court.index, {
      ...current,
      index: court.index,
      name: court.name,
    });
  }
  for (const link of schedule.availableLinks) {
    const current = courtMap.get(link.courtIndex) ?? { index: link.courtIndex };
    courtMap.set(link.courtIndex, {
      ...current,
      providerCourtId: current.providerCourtId ?? link.providerCourtId,
    });
  }
}

function incompleteCourtNames(courtMap) {
  return [...courtMap.values()]
    .filter((court) => !court.providerCourtId)
    .map((court) => court.name ?? `court index ${court.index}`);
}

async function discoverCourtIdentity({
  venue,
  date,
  days,
  fetchImpl = fetch,
}) {
  const courtMap = new Map();
  const schedulesByDate = new Map();

  for (let offset = 0; offset < days; offset += 1) {
    const probeDate = addDays(date, offset);
    const html = await fetchScheduleHtml({
      url: buildScheduleUrl({ venue, date: probeDate }),
      fetchImpl,
      referer: venue.referer,
    });
    const schedule = parseScheduleHtml(html, { locationId: venue.locationId });
    schedulesByDate.set(probeDate, { html, schedule });
    mergeCourtIdentity(courtMap, schedule);
    if (courtMap.size > 0 && incompleteCourtNames(courtMap).length === 0) break;
  }

  const missing = incompleteCourtNames(courtMap);
  if (missing.length > 0) {
    throw new IntracAvailabilityError(
      'INTRAC_COURT_ID_INCOMPLETE',
      `Intrac court identity discovery incomplete for ${venue.name} after ${days} day(s): ${missing.join(', ')}`,
    );
  }

  return { courtMap, schedulesByDate };
}

function localDateTime(date, hhmm) {
  return `${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00`;
}

function addMinutesToTime(hhmm, durationMinutes) {
  const minutes = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4)) + durationMinutes;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
}

function normalizeAvailability({
  venue,
  schedule,
  courtMap,
  date,
  durationMinutes,
  observedAt,
}) {
  mergeCourtIdentity(courtMap, schedule);
  const missing = incompleteCourtNames(courtMap);
  if (missing.length > 0) {
    throw new IntracAvailabilityError(
      'INTRAC_COURT_ID_INCOMPLETE',
      `Intrac court identity discovery incomplete for ${venue.name}: ${missing.join(', ')}`,
    );
  }

  return schedule.availableLinks
    .filter((link) => link.date === date)
    .map((link) => {
      const court = courtMap.get(link.courtIndex);
      const canonical = canonicalAvailability({
        provider: 'intrac',
        venue: {
          id: venue.id,
          name: venue.name,
          providerVenueId: venue.locationId,
        },
        court: {
          id: `intrac-court-${venue.locationId}-${court.providerCourtId}`,
          name: court.name,
          providerCourtId: court.providerCourtId,
          surface: null,
        },
        startTime: localDateTime(link.date, link.time),
        durationMinutes,
        price: {
          amount: null,
          currency: 'AUD',
          confidence: 'unknown',
        },
        provenance: {
          source: 'live',
          auth: 'public',
          observedAt,
          availabilityMethod: 'direct_first_party_html',
        },
      });

      return legacyAvailabilityFromCanonical(canonical, {
        nextHourAlsoAvailable: false,
        sourceMetadata: {
          officialUrl: venue.officialUrl,
          bookingUrl: new URL(link.href.match(/(?:book|reserve)\.cfm\?[^')]+/i)?.[0] ?? '', venue.origin).href,
        },
      });
    })
    .sort((a, b) => `${a.startTime} ${a.court}`.localeCompare(`${b.startTime} ${b.court}`));
}

function withNextHourAvailability(slots) {
  const keys = new Set(slots.map((slot) => `${slot.canonical.court.providerCourtId}|${slot.startTime.slice(0, 19)}`));
  return slots.map((slot) => {
    const time = slot.startTime.slice(11, 16).replace(':', '');
    const nextTime = addMinutesToTime(time, slot.durationMinutes);
    const nextLocal = localDateTime(slot.startTime.slice(0, 10), nextTime);
    return {
      ...slot,
      nextHourAlsoAvailable: keys.has(`${slot.canonical.court.providerCourtId}|${nextLocal}`),
    };
  });
}

async function readVenueAvailability(config, {
  date = todayIsoDate(),
  durationMinutes = 60,
  identityDiscoveryDays = 14,
  fetchImpl = fetch,
  observedAt = new Date().toISOString(),
  discovery = null,
} = {}) {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
    throw new Error('durationMinutes must be a positive integer');
  }
  if (!Number.isInteger(identityDiscoveryDays) || identityDiscoveryDays < 1) {
    throw new Error('identityDiscoveryDays must be a positive integer');
  }

  const venue = normalizeVenueConfig(config);
  const { courtMap, schedulesByDate } = discovery ?? await discoverCourtIdentity({
    venue,
    date,
    days: identityDiscoveryDays,
    fetchImpl,
  });
  const current = schedulesByDate.get(date) ?? {
    html: await fetchScheduleHtml({
      url: buildScheduleUrl({ venue, date }),
      fetchImpl,
      referer: venue.referer,
    }),
  };
  const schedule = current.schedule ?? parseScheduleHtml(current.html, { locationId: venue.locationId });

  return withNextHourAvailability(normalizeAvailability({
    venue,
    schedule,
    courtMap,
    date,
    durationMinutes,
    observedAt,
  }));
}

async function readAvailability({
  venues = DEFAULT_INTRAC_VENUES,
  date = todayIsoDate(),
  durationMinutes = 60,
  identityDiscoveryDays = 14,
  fetchImpl = fetch,
} = {}) {
  const observedAt = new Date().toISOString();
  const results = [];
  const failures = [];

  for (const venue of venues) {
    try {
      results.push(...await readVenueAvailability(venue, {
        date,
        durationMinutes,
        identityDiscoveryDays,
        fetchImpl,
        observedAt,
      }));
    } catch (error) {
      failures.push({
        venue: venue.name ?? venue.officialUrl,
        url: venue.officialUrl,
        code: error.code ?? 'INTRAC_PROVIDER_ERROR',
        message: error.message,
      });
    }
  }

  if (failures.length > 0) {
    const error = new IntracAvailabilityError('INTRAC_PARTIAL_FAILURE', 'One or more Intrac venues failed availability acquisition');
    error.failures = failures;
    error.availability = results;
    throw error;
  }

  return results;
}

async function getIntracAvailability(options = {}) {
  return readAvailability(options);
}

export {
  BROWSER_USER_AGENT,
  IntracAvailabilityError,
  buildScheduleUrl,
  discoverCourtIdentity,
  discoverVenues,
  fetchScheduleHtml,
  getIntracAvailability,
  normalizeAvailability,
  parseScheduleHtml,
  readAvailability,
  readVenueAvailability,
};
