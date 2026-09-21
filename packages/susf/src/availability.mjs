import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
} from '../../core/src/availability-schema.mjs';
import {
  chooseCourtToTriggerAvailability,
  discoverTennisCourtsFromFacilities,
  findCourtFacilities,
  isAvailabilityTriggerText,
  isLoginPage,
  navigateToTennisFacilityList,
  normalizeConfiguredUrl,
} from './discovery.mjs';
import {
  createAvailabilityCapture,
  fetchAvailabilityJson,
  getVerificationToken,
  prepareAvailabilityRequest,
  sanitizeCapturedAvailabilityRequest,
} from './public-client.mjs';

const DEFAULT_BOOKING_URL = 'https://susf.perfectmind.com/39161/Clients/BookMe4FacilityList/List?calendarId=7cb1945d-e899-4e40-96c4-8ee784ccfc2d&widgetId=c5b8cc8a-09fe-48ae-a693-df5c09f81adb&embed=False';
const DEFAULT_CAPTURE_TIMEOUT_MS = 120_000;
const DEFAULT_METADATA_CACHE_PATH = resolve('.cache/susf-metadata.json');
const DEFAULT_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AVAILABILITY_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TARGET_COURT_NUMBERS = Object.freeze([4, 5, 6]);
const SUSF_METADATA_CACHE_VERSION = 1;
const availabilityCache = new Map();
const SUSF_CANONICAL_VENUE = Object.freeze({
  id: 'susf-tennis',
  name: 'Sydney Uni Sport Tennis Courts',
  providerVenueId: 'susf',
  suburb: 'Camperdown',
  location: { lat: -33.8886, lng: 151.1873 },
});

class SusfAvailabilityError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'SusfAvailabilityError';
    this.code = code;
  }
}

function defaultSearchHeadlessMode() {
  return process.env.HEADLESS !== '0';
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

function buildCourtBookingUrl(bookingUrl, facilityId) {
  const source = new URL(bookingUrl);
  const facilityPath = source.pathname.replace(
    /\/Clients\/BookMe4FacilityList\/List\/?$/i,
    '/Clients/BookMe4LandingPages/Facility',
  );
  if (facilityPath === source.pathname) return null;

  const target = new URL(facilityPath, source.origin);
  target.searchParams.set('facilityId', facilityId);
  for (const key of ['widgetId', 'calendarId']) {
    const value = source.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return target.href;
}

function cloneAvailability(availability) {
  const cloned = availability.map((item) => JSON.parse(JSON.stringify(item)));
  if (availability.discovery) cloned.discovery = JSON.parse(JSON.stringify(availability.discovery));
  return cloned;
}

function availabilityCacheKey({
  bookingUrl,
  date,
  days,
  durationMinutes,
  targetCourtNumbers,
}) {
  return JSON.stringify({
    bookingUrl,
    date,
    days: Number(days),
    durationMinutes: Number(durationMinutes),
    targetCourtNumbers: targetCourtNumbers.map(Number).sort((a, b) => a - b),
  });
}

function targetSusfCourts(courts, targetCourtNumbers = DEFAULT_TARGET_COURT_NUMBERS) {
  const targets = new Set(targetCourtNumbers.map(Number));
  return courts.filter((court) => targets.has(Number(String(court.court).match(/\d+/)?.[0])));
}

function readAvailabilityCache(key, ttlMs = DEFAULT_AVAILABILITY_CACHE_TTL_MS) {
  const cached = availabilityCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAtMs > ttlMs) {
    availabilityCache.delete(key);
    return null;
  }
  const availability = cloneAvailability(cached.availability);
  availability.discovery = {
    ...(availability.discovery ?? {}),
    cache: 'availability_memory',
    cachedAt: cached.createdAt,
  };
  return availability;
}

function writeAvailabilityCache(key, availability) {
  availabilityCache.set(key, {
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    availability: cloneAvailability(availability),
  });
}

function collectArraysByKey(value, keyName, out = []) {
  if (!value || typeof value !== 'object') return out;

  if (Array.isArray(value)) {
    for (const item of value) collectArraysByKey(item, keyName, out);
    return out;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === keyName.toLowerCase() && Array.isArray(child)) {
      out.push(child);
    }
    collectArraysByKey(child, keyName, out);
  }

  return out;
}

function firstValue(object, names) {
  if (!object || typeof object !== 'object') return undefined;
  const lowerNames = names.map((name) => name.toLowerCase());
  const key = Object.keys(object).find((candidate) => lowerNames.includes(candidate.toLowerCase()));
  return key ? object[key] : undefined;
}

function parseSpotDateTime(spot, fallbackDate) {
  const dateValue = firstValue(spot, ['date', 'startDate', 'StartDate', 'bookingDate', 'BookingDate']);
  const timeValue = firstValue(spot, ['start_time', 'startTime', 'StartTime', 'time', 'Time']);
  const dateTimeValue = firstValue(spot, [
    'startDateTime',
    'StartDateTime',
    'start',
    'Start',
    'from',
    'From',
    'availableStartTime',
    'AvailableStartTime',
  ]);

  if (typeof dateTimeValue === 'string') {
    const dotNetMatch = dateTimeValue.match(/\/Date\((\d+)/);
    if (dotNetMatch) {
      const date = new Date(Number(dotNetMatch[1]));
      if (!Number.isNaN(date.valueOf())) {
        const formatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Australia/Sydney',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
        const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
        return {
          date: `${parts.year}-${parts.month}-${parts.day}`,
          time: `${parts.hour}:${parts.minute}`,
        };
      }
    }

    const isoMatch = dateTimeValue.match(/(\d{4}-\d{2}-\d{2}).*?(\d{1,2}:\d{2})/);
    if (isoMatch) return { date: isoMatch[1], time: isoMatch[2].padStart(5, '0') };

    const auMatch = dateTimeValue.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}).*?(\d{1,2}:\d{2})/);
    if (auMatch) {
      return {
        date: `${auMatch[3]}-${auMatch[2].padStart(2, '0')}-${auMatch[1].padStart(2, '0')}`,
        time: auMatch[4].padStart(5, '0'),
      };
    }
  }

  if (timeValue && typeof timeValue === 'object') {
    const hours = firstValue(timeValue, ['hours', 'Hours']);
    const minutes = firstValue(timeValue, ['minutes', 'Minutes']);

    if (Number.isInteger(hours) && Number.isInteger(minutes) && fallbackDate) {
      return {
        date: fallbackDate,
        time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
      };
    }
  }

  if (typeof timeValue === 'string') {
    const timeMatch = timeValue.match(/(\d{1,2}:\d{2})/);
    if (timeMatch) {
      const rawDate = typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateValue)
        ? dateValue.slice(0, 10)
        : fallbackDate;
      return { date: rawDate, time: timeMatch[1].padStart(5, '0') };
    }
  }

  return null;
}

function parseDateOnly(value) {
  if (typeof value !== 'string') return null;

  const dotNetMatch = value.match(/\/Date\((\d+)/);
  if (dotNetMatch) {
    const date = new Date(Number(dotNetMatch[1]));
    if (!Number.isNaN(date.valueOf())) {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Australia/Sydney',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  }

  const isoMatch = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  const auMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (auMatch) {
    return `${auMatch[3]}-${auMatch[2].padStart(2, '0')}-${auMatch[1].padStart(2, '0')}`;
  }

  return null;
}

function extractSerializedPriceArrays(text) {
  const arrays = [];
  let index = 0;

  while (true) {
    const key = text.indexOf('"Prices"', index);
    if (key === -1) break;

    const colon = text.indexOf(':', key);
    const start = text.indexOf('[', colon);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let cursor = start; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === '[') depth += 1;
      else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          end = cursor + 1;
          break;
        }
      }
    }

    if (end !== -1) {
      try {
        arrays.push(JSON.parse(text.slice(start, end)));
      } catch {
        // Ignore malformed embedded data; another Prices array may still be usable.
      }
    }

    index = start + 1;
  }

  return arrays.filter((array) => Array.isArray(array) && array.length > 0);
}

function normalizeRateTableFromPriceArrays(priceArrays) {
  if (!Array.isArray(priceArrays)) return [];

  const rates = [];
  for (const [arrayIndex, priceArray] of priceArrays.entries()) {
    if (!Array.isArray(priceArray)) continue;
    const durationMinutes = 60 + arrayIndex * 15;

    for (const price of priceArray) {
      if (!price || typeof price !== 'object') continue;
      if (typeof price.Name !== 'string' || typeof price.Amount !== 'number') continue;

      rates.push({
        name: price.Name,
        amount: price.Amount,
        currency: 'AUD',
        durationMinutes,
      });
    }
  }

  const seen = new Set();
  return rates.filter((rate) => {
    const key = `${rate.name}|${rate.amount}|${rate.currency}|${rate.durationMinutes}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractRateTableFromHtml(html) {
  return normalizeRateTableFromPriceArrays(extractSerializedPriceArrays(html));
}

function selectSusfSlotPrice(date, priceOptions = []) {
  const weekday = new Date(`${date}T12:00:00+10:00`).getUTCDay();
  const rateName = weekday === 0 || weekday === 6 ? 'tennis peak fee' : 'tennis off-peak fee';
  const selected = priceOptions.find((option) => String(option?.name ?? '').trim().toLowerCase() === rateName
    && typeof option?.amount === 'number');
  if (!selected) {
    return { amount: null, currency: 'AUD', confidence: 'unknown' };
  }
  return {
    amount: selected.amount,
    currency: selected.currency ?? 'AUD',
    confidence: 'verified',
  };
}

async function extractCurrentCourtRateTable(page) {
  return extractRateTableFromHtml(await page.content());
}

function cacheFresh(cache, {
  bookingUrl,
  maxAgeMs,
} = {}) {
  if (!cache || cache.version !== SUSF_METADATA_CACHE_VERSION) return false;
  if (cache.bookingUrl !== bookingUrl) return false;
  if (!Array.isArray(cache.courts) || cache.courts.length === 0) return false;
  const createdAtMs = Date.parse(cache.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return Date.now() - createdAtMs <= maxAgeMs;
}

async function readMetadataCache(filePath, options) {
  if (!filePath) return null;
  try {
    const cache = JSON.parse(await readFile(filePath, 'utf8'));
    return cacheFresh(cache, options) ? cache : null;
  } catch {
    return null;
  }
}

async function writeMetadataCache(filePath, cache) {
  if (!filePath) return;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`);
}

function normalizeAvailability(responseJson, court, { durationMinutes }) {
  const rows = [];

  const availabilities = firstValue(responseJson, ['availabilities', 'Availabilities']);
  if (Array.isArray(availabilities)) {
    for (const availability of availabilities) {
      const fallbackDate = parseDateOnly(firstValue(availability, ['date', 'Date']));
      const bookingGroups = firstValue(availability, ['bookingGroups', 'BookingGroups']) ?? [];
      if (!Array.isArray(bookingGroups)) continue;

      for (const group of bookingGroups) {
        const spots = firstValue(group, ['availableSpots', 'AvailableSpots']) ?? [];
        if (!Array.isArray(spots)) continue;

        for (const spot of spots) {
          const parsed = parseSpotDateTime(spot, fallbackDate);
          if (parsed) {
            rows.push({
              court,
              date: parsed.date,
              start_time: parsed.time,
              duration_minutes: durationMinutes,
            });
          }
        }
      }
    }
  }

  const availableSpotArrays = collectArraysByKey(responseJson, 'AvailableSpots');
  const bookingGroupArrays = collectArraysByKey(responseJson, 'BookingGroups');

  for (const spots of availableSpotArrays) {
    for (const spot of spots) {
      const parsed = parseSpotDateTime(spot);
      if (parsed) {
        rows.push({
          court,
          date: parsed.date,
          start_time: parsed.time,
          duration_minutes: durationMinutes,
        });
      }
    }
  }

  for (const groups of bookingGroupArrays) {
    for (const group of groups) {
      const fallbackDate = parseDateOnly(firstValue(group, ['date', 'Date', 'bookingDate', 'BookingDate']));
      const spots = firstValue(group, ['AvailableSpots']) ?? [];
      if (!Array.isArray(spots)) continue;

      for (const spot of spots) {
        const parsed = parseSpotDateTime(spot, fallbackDate);
        if (parsed) {
          rows.push({
            court,
            date: parsed.date,
            start_time: parsed.time,
            duration_minutes: durationMinutes,
          });
        }
      }
    }
  }

  const seen = new Set();
  return rows
    .filter((row) => {
      const key = `${row.court}|${row.date}|${row.start_time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${a.date} ${a.start_time} ${a.court}`.localeCompare(`${b.date} ${b.start_time} ${b.court}`));
}

function addMinutesToTime(time, minutesToAdd) {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  const total = Number(match[1]) * 60 + Number(match[2]) + minutesToAdd;
  if (total >= 24 * 60) return null;

  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function buildRankedCandidates(rows, { durationMinutes }) {
  const availableKeys = new Set(rows.map((row) => `${row.court}|${row.date}|${row.start_time}`));

  return rows
    .map((row) => {
      const nextHour = addMinutesToTime(row.start_time, durationMinutes);
      return {
        court: row.court,
        facilityId: row.facilityId,
        date: row.date,
        start_time: row.start_time,
        duration_minutes: row.duration_minutes,
        next_hour_start_time: nextHour,
        next_hour_also_available: Boolean(nextHour && availableKeys.has(`${row.court}|${row.date}|${nextHour}`)),
        price_options: row.price_options ?? [],
        officialUrl: row.officialUrl,
        bookingUrl: row.bookingUrl,
        observedAt: row.observedAt,
      };
    })
    .sort((a, b) => {
      if (a.next_hour_also_available !== b.next_hour_also_available) {
        return a.next_hour_also_available ? -1 : 1;
      }
      return `${a.date} ${a.start_time} ${a.court}`.localeCompare(`${b.date} ${b.start_time} ${b.court}`);
    });
}

function toPublicAvailability(row) {
  const startTime = `${row.date}T${row.start_time}:00`;
  const courtNumber = String(row.court).match(/\d+/)?.[0];
  const canonical = canonicalAvailability({
    provider: 'susf',
    venue: SUSF_CANONICAL_VENUE,
    court: {
      id: courtNumber ? `susf-court-${courtNumber}` : `susf-court-${String(row.court).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: row.court,
      providerCourtId: row.facilityId,
      surface: null,
    },
    startTime,
    durationMinutes: row.duration_minutes,
    priceOptions: row.price_options,
    price: selectSusfSlotPrice(row.date, row.price_options),
    eligibility: {
      sport: {
        type: 'tennis',
        proof: 'verified_booking_page',
      },
    },
    provenance: {
      source: 'live',
      auth: 'public',
      observedAt: row.observedAt,
      availabilityMethod: 'direct',
    },
  });

  return legacyAvailabilityFromCanonical(canonical, {
    nextHourAlsoAvailable: row.next_hour_also_available,
    sourceMetadata: {
      officialUrl: row.officialUrl,
      bookingUrl: row.bookingUrl,
    },
  });
}

function availabilityFromRows(rows, {
  durationMinutes,
  discovery,
} = {}) {
  rows.sort((a, b) => `${a.date} ${a.start_time} ${a.court}`.localeCompare(`${b.date} ${b.start_time} ${b.court}`));
  const availability = buildRankedCandidates(rows, { durationMinutes }).map(toPublicAvailability);
  if (discovery) availability.discovery = discovery;
  return availability;
}

function partialAvailabilityError(signal, rows, {
  durationMinutes,
  discovery,
  fallbackCode = 'PROVIDER_CANCELLED',
  fallbackMessage = 'SUSF availability acquisition was cancelled.',
} = {}) {
  const code = signal?.reason?.code ?? fallbackCode;
  const message = signal?.reason?.message ?? fallbackMessage;
  const error = new SusfAvailabilityError(code, message);
  error.availability = availabilityFromRows(rows, {
    durationMinutes,
    discovery: {
      ...discovery,
      partial: true,
      partialReason: code,
    },
  });
  return error;
}

async function readSusfAvailabilityWithCachedMetadata({
  page,
  cache,
  date,
  days,
  durationMinutes,
  signal = null,
  targetCourtNumbers = DEFAULT_TARGET_COURT_NUMBERS,
}) {
  const token = await getVerificationToken(page);
  const rows = [];
  const cachedCourts = targetSusfCourts(cache.courts, targetCourtNumbers);
  if (cachedCourts.length === 0) {
    throw new SusfAvailabilityError('SUSF_METADATA_CACHE_MISS', 'SUSF metadata cache does not contain the requested courts.');
  }

  for (const court of cachedCourts) {
    if (signal?.aborted) {
      throw partialAvailabilityError(signal, rows, {
        durationMinutes,
        discovery: {
          facilityCount: cachedCourts.length,
          courtCount: cachedCourts.length,
          source: 'metadata_cache',
        },
      });
    }
    const request = prepareAvailabilityRequest(court.captured, {
      facilityId: court.facilityId,
      date,
      token,
      daysCount: days,
      durationMinutes,
    });
    let responseJson;
    try {
      responseJson = await fetchAvailabilityJson(page, request);
    } catch (error) {
      if (signal?.aborted) {
        throw partialAvailabilityError(signal, rows, {
          durationMinutes,
          discovery: {
            facilityCount: cachedCourts.length,
            courtCount: cachedCourts.length,
            source: 'metadata_cache',
          },
        });
      }
      throw error;
    }
    rows.push(...normalizeAvailability(responseJson, court.court, { durationMinutes })
      .map((row) => ({
        ...row,
        facilityId: court.facilityId,
        price_options: court.priceOptions ?? [],
        observedAt: new Date().toISOString(),
        officialUrl: cache.bookingUrl,
        bookingUrl: buildCourtBookingUrl(cache.bookingUrl, court.facilityId),
      })));
  }

  return availabilityFromRows(rows, {
    durationMinutes,
    discovery: {
      facilityCount: cachedCourts.length,
      courtCount: cachedCourts.length,
      source: 'metadata_cache',
    },
  });
}

async function readSusfAvailability({
  bookingUrl = process.env.SUSF_BOOKING_URL ?? DEFAULT_BOOKING_URL,
  date = todayIsoDate(),
  days = 7,
  durationMinutes = 60,
  captureTimeoutMs = Number(process.env.CAPTURE_TIMEOUT_MS ?? DEFAULT_CAPTURE_TIMEOUT_MS),
  headless = defaultSearchHeadlessMode(),
  signal = null,
  metadataCachePath = process.env.SUSF_METADATA_CACHE_PATH ?? DEFAULT_METADATA_CACHE_PATH,
  metadataCacheTtlMs = Number(process.env.SUSF_METADATA_CACHE_TTL_MS ?? DEFAULT_METADATA_CACHE_TTL_MS),
  availabilityCacheTtlMs = Number(process.env.SUSF_AVAILABILITY_CACHE_TTL_MS ?? DEFAULT_AVAILABILITY_CACHE_TTL_MS),
  forceDiscovery = process.env.SUSF_FORCE_DISCOVERY === '1',
  targetCourtNumbers = DEFAULT_TARGET_COURT_NUMBERS,
} = {}) {
  const normalizedBookingUrl = normalizeConfiguredUrl(bookingUrl);
  const cacheKey = availabilityCacheKey({
    bookingUrl: normalizedBookingUrl,
    date,
    days,
    durationMinutes,
    targetCourtNumbers,
  });
  const cachedAvailability = readAvailabilityCache(cacheKey, availabilityCacheTtlMs);
  if (cachedAvailability) return cachedAvailability;

  const metadataCache = forceDiscovery ? null : await readMetadataCache(metadataCachePath, {
    bookingUrl: normalizedBookingUrl,
    maxAgeMs: metadataCacheTtlMs,
  });

  const browser = await chromium.launch({ headless });
  const abortHandler = () => {
    browser.close().catch(() => {});
  };
  if (signal) signal.addEventListener('abort', abortHandler, { once: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const facilityListUrl = await navigateToTennisFacilityList(page, normalizedBookingUrl);

    if (await isLoginPage(page)) {
      throw new SusfAvailabilityError('SESSION_EXPIRED');
    }

    if (metadataCache) {
      try {
        const availability = await readSusfAvailabilityWithCachedMetadata({
          page,
          cache: metadataCache,
          date,
          days,
          durationMinutes,
          signal,
          targetCourtNumbers,
        });
        writeAvailabilityCache(cacheKey, availability);
        return availability;
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`SUSF metadata cache failed; falling back to discovery: ${error.message}`);
      }
    }

    const discoveredCourts = await findCourtFacilities(page);
    const courts = targetSusfCourts(discoveredCourts, targetCourtNumbers);

    if (courts.length === 0) {
      throw new Error(`Could not find target Tennis courts ${targetCourtNumbers.join(', ')} in the page data-facilityid values.`);
    }

    const rows = [];
    const cacheCourts = [];

    for (const court of courts) {
      if (signal?.aborted) {
        throw partialAvailabilityError(signal, rows, {
          durationMinutes,
          discovery: {
            facilityCount: courts.length,
            courtCount: courts.length,
            source: 'live_discovery',
          },
        });
      }
      await page.goto(facilityListUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      if (await isLoginPage(page)) {
        throw new SusfAvailabilityError('SESSION_EXPIRED');
      }

      const token = await getVerificationToken(page);
      const availabilityCapture = createAvailabilityCapture(page, court.facilityId, { captureTimeoutMs });
      const captured = await availabilityCapture.wait({
        initialDelayMs: 0,
        onNeedTrigger: () => chooseCourtToTriggerAvailability(page, court),
      });
      availabilityCapture.stop();
      const priceOptions = (await extractCurrentCourtRateTable(page))
        .filter((rate) => rate.durationMinutes === durationMinutes);

      if (!captured) {
        throw new Error(`Timed out after ${captureTimeoutMs}ms waiting for ${court.domLabel} FacilityAvailability request.`);
      }

      cacheCourts.push({
        court: court.court,
        domLabel: court.domLabel,
        facilityId: court.facilityId,
        captured: sanitizeCapturedAvailabilityRequest(captured),
        priceOptions,
      });

      await writeMetadataCache(metadataCachePath, {
        version: SUSF_METADATA_CACHE_VERSION,
        bookingUrl: normalizedBookingUrl,
        facilityListUrl,
        createdAt: new Date().toISOString(),
        courts: cacheCourts,
      }).catch((error) => {
        console.warn(`Unable to checkpoint SUSF metadata cache: ${error.message}`);
      });

      const requestOptions = {
        facilityId: court.facilityId,
        date,
        token,
        daysCount: days,
        durationMinutes,
      };
      const request = prepareAvailabilityRequest(captured, requestOptions);
      let responseJson;
      try {
        responseJson = await fetchAvailabilityJson(page, request);
      } catch (error) {
        if (signal?.aborted) {
          throw partialAvailabilityError(signal, rows, {
            durationMinutes,
            discovery: {
              facilityCount: courts.length,
              courtCount: courts.length,
              source: 'live_discovery',
            },
          });
        }
        throw error;
      }

      rows.push(...normalizeAvailability(responseJson, court.court, { durationMinutes })
        .map((row) => ({
          ...row,
          facilityId: court.facilityId,
          price_options: priceOptions,
          observedAt: new Date().toISOString(),
          officialUrl: normalizedBookingUrl,
          bookingUrl: buildCourtBookingUrl(normalizedBookingUrl, court.facilityId),
        })));
    }

    const availability = availabilityFromRows(rows, {
      durationMinutes,
      discovery: {
        facilityCount: courts.length,
        courtCount: courts.length,
        source: 'live_discovery',
      },
    });
    await writeMetadataCache(metadataCachePath, {
      version: SUSF_METADATA_CACHE_VERSION,
      bookingUrl: normalizedBookingUrl,
      facilityListUrl,
      createdAt: new Date().toISOString(),
      courts: cacheCourts,
    }).catch((error) => {
      console.warn(`Unable to write SUSF metadata cache: ${error.message}`);
    });
    writeAvailabilityCache(cacheKey, availability);
    return availability;
  } finally {
    if (signal) signal.removeEventListener('abort', abortHandler);
    await browser.close().catch(() => {});
  }
}

async function getSusfAvailability(options = {}) {
  try {
    return await readSusfAvailability(options);
  } catch (error) {
    if (error instanceof SusfAvailabilityError) throw error;
    throw new SusfAvailabilityError('SUSF_ADAPTER_ERROR', error.message, { cause: error });
  }
}

export {
  DEFAULT_BOOKING_URL,
  DEFAULT_CAPTURE_TIMEOUT_MS,
  DEFAULT_TARGET_COURT_NUMBERS,
  SusfAvailabilityError,
  buildCourtBookingUrl,
  buildRankedCandidates,
  defaultSearchHeadlessMode,
  discoverTennisCourtsFromFacilities,
  extractRateTableFromHtml,
  extractSerializedPriceArrays,
  findCourtFacilities,
  getSusfAvailability,
  isAvailabilityTriggerText,
  normalizeRateTableFromPriceArrays,
  selectSusfSlotPrice,
  targetSusfCourts,
  normalizeAvailability,
  readSusfAvailability,
  toPublicAvailability,
};
