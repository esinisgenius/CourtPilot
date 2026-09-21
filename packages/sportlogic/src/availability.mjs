import { chromium } from 'playwright';
import {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
} from '../../core/src/availability-schema.mjs';
import { DEFAULT_SPORTLOGIC_VENUES } from './venues.mjs';

const SYDNEY_TIME_ZONE = 'Australia/Sydney';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

class SportLogicAvailabilityError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'SportLogicAvailabilityError';
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

function compactDate(isoDate) {
  return String(isoDate).replaceAll('-', '');
}

function expandCompactDate(value) {
  const raw = String(value);
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeVenueConfig(config) {
  if (!config?.officialUrl) {
    throw new SportLogicAvailabilityError('SPORTLOGIC_INVALID_VENUE_CONFIG', 'SportLogic venue requires officialUrl');
  }
  const url = new URL(config.officialUrl);
  const match = url.pathname.match(/\/booking\/([^/?#]+)/i);
  const clientId = config.clientId ?? match?.[1];
  if (!clientId) {
    throw new SportLogicAvailabilityError('SPORTLOGIC_INVALID_VENUE_CONFIG', `SportLogic booking URL is not recognized: ${config.officialUrl}`);
  }

  return {
    id: config.id ?? `sportlogic-${clientId}`,
    name: config.name ?? clientId,
    suburb: config.suburb ?? null,
    provider: 'sportlogic',
    sport: config.sport ?? null,
    location: config.location ?? null,
    address: config.address ?? null,
    officialUrl: config.officialUrl,
    origin: url.origin,
    clientId,
    venueId: config.venueId == null ? null : String(config.venueId),
    enabled: config.enabled !== false,
    auditCourtCount: config.auditCourtCount ?? null,
    allowPartialCourtIdentity: config.allowPartialCourtIdentity === true,
  };
}

function discoverVenues({ venues = DEFAULT_SPORTLOGIC_VENUES } = {}) {
  return venues
    .filter((venue) => venue?.enabled !== false)
    .map(normalizeVenueConfig);
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

function parseBootstrapMetadata(html, venue) {
  const endpointPath = String(html).match(/url:\s*['"]([^'"]*fetch-booking-data)['"]/)?.[1]
    ?? `/booking/${venue.clientId}/fetch-booking-data`;
  const clientId = String(html).match(/client_id:\s*['"]([^'"]+)['"]/)?.[1] ?? venue.clientId;
  const venueId = String(html).match(/venue_id:\s*['"]([^'"]+)['"]/)?.[1] ?? venue.venueId;
  if (!venueId) {
    throw new SportLogicAvailabilityError('SPORTLOGIC_METADATA_MISSING', `Unable to discover SportLogic venue_id for ${venue.name}`);
  }

  const hourlyRate = String(html).match(/Court Hire rates[\s\S]{0,120}?\$([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  return {
    endpointUrl: new URL(endpointPath, venue.officialUrl).href,
    clientId,
    venueId,
    price: hourlyRate == null
      ? { amount: null, currency: 'AUD', confidence: 'unknown' }
      : { amount: Number(hourlyRate), currency: 'AUD', confidence: 'verified' },
  };
}

async function bootstrapAnonymousSession(venue, { signal = null } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  });
  const abortHandler = () => {
    browser.close().catch(() => {});
  };
  if (signal) signal.addEventListener('abort', abortHandler, { once: true });
  const context = await browser.newContext({
    storageState: undefined,
    userAgent: BROWSER_USER_AGENT,
  });

  try {
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      return ['image', 'font', 'media'].includes(type) ? route.abort() : route.continue();
    });
    await page.goto(venue.officialUrl, { waitUntil: 'networkidle', timeout: 60000 });
    const html = await page.content();
    const cookies = await context.cookies();
    const cookieHeader = cookies
      .filter((cookie) => cookie.domain && new URL(venue.officialUrl).hostname.endsWith(cookie.domain.replace(/^\./, '')))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    if (!cookieHeader) {
      throw new SportLogicAvailabilityError('SPORTLOGIC_BOOTSTRAP_FAILED', `Anonymous SportLogic bootstrap yielded no cookies for ${venue.name}`);
    }
    return { html, cookieHeader };
  } finally {
    if (signal) signal.removeEventListener('abort', abortHandler);
    await context.close();
    await browser.close().catch(() => {});
  }
}

function buildAvailabilityUrl({ endpointUrl, clientId, venueId, date }) {
  const params = new URLSearchParams({
    client_id: clientId,
    venue_id: String(venueId),
    resource_id: '',
    date: compactDate(date),
    view: 'v4',
    _: String(Date.now()),
  });
  return `${endpointUrl}?${params}`;
}

async function fetchAvailabilityFragment({ url, cookieHeader, fetchImpl = fetch, signal = null }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    signal,
    headers: {
      accept: 'text/html, */*; q=0.01',
      cookie: cookieHeader,
      'user-agent': BROWSER_USER_AGENT,
    },
  });
  if (response.status === 202) {
    throw new SportLogicAvailabilityError('SPORTLOGIC_BOOTSTRAP_REQUIRED', `SportLogic availability endpoint returned AWS WAF challenge HTTP 202: ${url}`);
  }
  if (!response.ok) {
    throw new SportLogicAvailabilityError('SPORTLOGIC_PROVIDER_ERROR', `SportLogic endpoint returned HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

function parseCourtHeaders(fragment) {
  return [...String(fragment).matchAll(/<th\b([^>]*)class=["'][^"']*\bv4-court-col\b[^"']*["']([^>]*)>([\s\S]*?)<\/th>/gi)]
    .map((match) => {
      const attrs = `${match[1]} ${match[2]}`;
      const index = attrs.match(/data-court-index=["']?(\d+)["']?/i)?.[1];
      return {
        index: index == null ? null : Number(index),
        name: stripTags(match[3]),
      };
    })
    .filter((court) => Number.isInteger(court.index) && court.name.length > 0);
}

function parseAvailableLinks(fragment) {
  const links = [];
  for (const cellMatch of String(fragment).matchAll(/<td\b([^>]*)class=["'][^"']*\bv4-slot-available\b[^"']*["']([^>]*)>([\s\S]*?)<\/td>/gi)) {
    const attrs = `${cellMatch[1]} ${cellMatch[2]}`;
    const index = attrs.match(/data-court-index=["']?(\d+)["']?/i)?.[1];
    if (index == null) continue;
    const anchorMatch = cellMatch[3].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchorMatch) continue;
    const href = decodeHtml(anchorMatch[1]);
    const url = new URL(href, 'https://www.tennisvenues.com.au');
    const courtId = url.searchParams.get('id');
    const date = url.searchParams.get('d');
    const time = url.searchParams.get('t');
    if (!courtId || !date || !time) continue;
    links.push({
      courtIndex: Number(index),
      courtId,
      date: expandCompactDate(date),
      time,
      label: stripTags(anchorMatch[2]),
      href,
    });
  }
  return links;
}

function parseGridFragment(fragment) {
  const courts = parseCourtHeaders(fragment);
  if (courts.length === 0) {
    throw new SportLogicAvailabilityError('SPORTLOGIC_MALFORMED_RESPONSE', 'SportLogic availability fragment did not contain v4 court headers');
  }
  return {
    courts,
    availableLinks: parseAvailableLinks(fragment),
  };
}

function mergeCourtIdentity(courtMap, grid) {
  for (const court of grid.courts) {
    const current = courtMap.get(court.index) ?? {};
    courtMap.set(court.index, {
      ...current,
      index: court.index,
      name: court.name,
    });
  }
  for (const link of grid.availableLinks) {
    const current = courtMap.get(link.courtIndex) ?? { index: link.courtIndex };
    courtMap.set(link.courtIndex, {
      ...current,
      providerCourtId: current.providerCourtId ?? link.courtId,
    });
  }
}

function incompleteCourtNames(courtMap) {
  return [...courtMap.values()]
    .filter((court) => !court.providerCourtId)
    .map((court) => court.name ?? `court index ${court.index}`);
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
  metadata,
  fragment,
  courtMap,
  date,
  durationMinutes,
  observedAt,
}) {
  const grid = parseGridFragment(fragment);
  mergeCourtIdentity(courtMap, grid);
  const missing = incompleteCourtNames(courtMap);
  if (missing.length > 0 && !venue.allowPartialCourtIdentity) {
    throw new SportLogicAvailabilityError(
      'SPORTLOGIC_COURT_ID_INCOMPLETE',
      `SportLogic court identity discovery incomplete for ${venue.name}: ${missing.join(', ')}`,
    );
  }

  return grid.availableLinks
    .filter((link) => link.date === date)
    .map((link) => {
      const court = courtMap.get(link.courtIndex);
      const canonical = canonicalAvailability({
        provider: 'sportlogic',
        venue: {
          id: venue.id,
          name: venue.name,
          providerVenueId: metadata.clientId,
          suburb: venue.suburb,
          ...(venue.location ? { location: venue.location } : {}),
          ...(venue.address ? { address: venue.address } : {}),
        },
        court: {
          id: `sportlogic-court-${metadata.clientId}-${court.providerCourtId}`,
          name: court.name,
          providerCourtId: court.providerCourtId,
          surface: null,
        },
        startTime: localDateTime(link.date, link.time),
        durationMinutes,
        price: metadata.price,
        ...(venue.sport === 'tennis' ? {
          eligibility: {
            sport: {
              type: 'tennis',
              proof: 'provider_venue',
            },
          },
        } : {}),
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
          bookingUrl: new URL(link.href, venue.origin).href,
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

async function discoverCourtIdentity({ venue, metadata, date, days, cookieHeader, fetchImpl, signal = null }) {
  const courtMap = new Map();
  const fragmentsByDate = new Map();
  for (let offset = 0; offset < days; offset += 1) {
    const probeDate = addDays(date, offset);
    const url = buildAvailabilityUrl({
      endpointUrl: metadata.endpointUrl,
      clientId: metadata.clientId,
      venueId: metadata.venueId,
      date: probeDate,
    });
    const fragment = await fetchAvailabilityFragment({ url, cookieHeader, fetchImpl, signal });
    fragmentsByDate.set(probeDate, fragment);
    mergeCourtIdentity(courtMap, parseGridFragment(fragment));
    if (courtMap.size > 0 && incompleteCourtNames(courtMap).length === 0) break;
  }

  const missing = incompleteCourtNames(courtMap);
  if (missing.length > 0 && !venue.allowPartialCourtIdentity) {
    throw new SportLogicAvailabilityError(
      'SPORTLOGIC_COURT_ID_INCOMPLETE',
      `SportLogic court identity discovery incomplete for ${venue.name} after ${days} day(s): ${missing.join(', ')}`,
    );
  }

  return { courtMap, fragmentsByDate };
}

async function readVenueAvailability(config, {
  date = todayIsoDate(),
  durationMinutes = 60,
  identityDiscoveryDays = 14,
  fetchImpl = fetch,
  bootstrapSessionImpl = bootstrapAnonymousSession,
  observedAt = new Date().toISOString(),
  signal = null,
} = {}) {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
    throw new Error('durationMinutes must be a positive integer');
  }
  if (!Number.isInteger(identityDiscoveryDays) || identityDiscoveryDays < 1) {
    throw new Error('identityDiscoveryDays must be a positive integer');
  }

  const venue = normalizeVenueConfig(config);
  const session = await bootstrapSessionImpl(venue, { signal });
  const metadata = parseBootstrapMetadata(session.html, venue);
  const { courtMap, fragmentsByDate } = await discoverCourtIdentity({
    venue,
    metadata,
    date,
    days: identityDiscoveryDays,
    cookieHeader: session.cookieHeader,
    fetchImpl,
    signal,
  });
  const fragment = fragmentsByDate.get(date) ?? await fetchAvailabilityFragment({
    url: buildAvailabilityUrl({
      endpointUrl: metadata.endpointUrl,
      clientId: metadata.clientId,
      venueId: metadata.venueId,
      date,
    }),
    cookieHeader: session.cookieHeader,
    fetchImpl,
    signal,
  });

  return withNextHourAvailability(normalizeAvailability({
    venue,
    metadata,
    fragment,
    courtMap,
    date,
    durationMinutes,
    observedAt,
  }));
}

async function readAvailability({
  venues = DEFAULT_SPORTLOGIC_VENUES,
  date = todayIsoDate(),
  days = 1,
  durationMinutes = 60,
  identityDiscoveryDays = 14,
  fetchImpl = fetch,
  bootstrapSessionImpl = bootstrapAnonymousSession,
  signal = null,
} = {}) {
  if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive integer');
  const observedAt = new Date().toISOString();
  const results = [];
  const failures = [];

  for (const config of venues) {
    const venue = normalizeVenueConfig(config);
    try {
      const session = await bootstrapSessionImpl(venue, { signal });
      const metadata = parseBootstrapMetadata(session.html, venue);
      const { courtMap, fragmentsByDate } = await discoverCourtIdentity({
        venue,
        metadata,
        date,
        days: Math.max(identityDiscoveryDays, days),
        cookieHeader: session.cookieHeader,
        fetchImpl,
        signal,
      });

      for (let offset = 0; offset < days; offset += 1) {
        const currentDate = addDays(date, offset);
        const fragment = fragmentsByDate.get(currentDate) ?? await fetchAvailabilityFragment({
          url: buildAvailabilityUrl({
            endpointUrl: metadata.endpointUrl,
            clientId: metadata.clientId,
            venueId: metadata.venueId,
            date: currentDate,
          }),
          cookieHeader: session.cookieHeader,
          fetchImpl,
          signal,
        });

        results.push(...withNextHourAvailability(normalizeAvailability({
          venue,
          metadata,
          fragment,
          courtMap,
          date: currentDate,
          durationMinutes,
          observedAt,
        })));
      }
    } catch (error) {
      failures.push({
        venue: venue.name ?? venue.officialUrl,
        url: venue.officialUrl,
        code: error.code ?? 'SPORTLOGIC_PROVIDER_ERROR',
        message: error.message,
      });
    }
  }

  if (failures.length > 0) {
    const error = new SportLogicAvailabilityError('SPORTLOGIC_PARTIAL_FAILURE', 'One or more SportLogic venues failed availability acquisition');
    error.failures = failures;
    error.availability = results;
    throw error;
  }

  return results;
}

async function readSingleDateAvailability({
  venues = DEFAULT_SPORTLOGIC_VENUES,
  date = todayIsoDate(),
  durationMinutes = 60,
  identityDiscoveryDays = 14,
  fetchImpl = fetch,
  bootstrapSessionImpl = bootstrapAnonymousSession,
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
        identityDiscoveryDays,
        fetchImpl,
        bootstrapSessionImpl,
        observedAt,
        signal,
      }));
    } catch (error) {
      failures.push({
        venue: venue.name ?? venue.officialUrl,
        url: venue.officialUrl,
        code: error.code ?? 'SPORTLOGIC_PROVIDER_ERROR',
        message: error.message,
      });
    }
  }

  if (failures.length > 0) {
    const error = new SportLogicAvailabilityError('SPORTLOGIC_PARTIAL_FAILURE', 'One or more SportLogic venues failed availability acquisition');
    error.failures = failures;
    error.availability = results;
    throw error;
  }

  return results;
}

async function getSportLogicAvailability(options = {}) {
  return readAvailability(options);
}

export {
  BROWSER_USER_AGENT,
  SportLogicAvailabilityError,
  buildAvailabilityUrl,
  bootstrapAnonymousSession,
  discoverCourtIdentity,
  discoverVenues,
  getSportLogicAvailability,
  normalizeAvailability,
  parseBootstrapMetadata,
  parseGridFragment,
  readAvailability,
  readVenueAvailability,
};
