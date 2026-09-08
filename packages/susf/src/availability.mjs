import { chromium } from 'playwright';
import {
  canonicalAvailability,
  legacyAvailabilityFromCanonical,
} from '../../core/src/availability-schema.mjs';
import {
  chooseCourtToTriggerAvailability,
  discoverTennisCourtsFromFacilities,
  findCourtFacilities,
  isLoginPage,
  navigateToTennisFacilityList,
  normalizeConfiguredUrl,
} from './discovery.mjs';
import {
  createAvailabilityCapture,
  fetchAvailabilityJson,
  getVerificationToken,
  prepareAvailabilityRequest,
} from './public-client.mjs';

const DEFAULT_BOOKING_URL = 'https://susf.perfectmind.com/39161/Clients/BookMe4FacilityList/List?calendarId=7cb1945d-e899-4e40-96c4-8ee784ccfc2d&widgetId=c5b8cc8a-09fe-48ae-a693-df5c09f81adb&embed=False';
const DEFAULT_CAPTURE_TIMEOUT_MS = 120_000;

class SusfAvailabilityError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'SusfAvailabilityError';
    this.code = code;
  }
}

function todayIsoDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

async function extractCurrentCourtRateTable(page) {
  return extractRateTableFromHtml(await page.content());
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
  const venue = 'SUSF';
  const courtNumber = String(row.court).match(/\d+/)?.[0];
  const canonical = canonicalAvailability({
    provider: 'susf',
    venue: {
      id: 'susf',
      name: venue,
      providerVenueId: 'susf',
    },
    court: {
      id: courtNumber ? `susf-court-${courtNumber}` : `susf-court-${String(row.court).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: row.court,
      providerCourtId: row.facilityId,
      surface: null,
    },
    startTime,
    durationMinutes: row.duration_minutes,
    priceOptions: row.price_options,
    provenance: {
      source: 'live',
      auth: 'public',
      observedAt: row.observedAt,
      availabilityMethod: 'direct',
    },
  });

  return legacyAvailabilityFromCanonical(canonical, {
    nextHourAlsoAvailable: row.next_hour_also_available,
  });
}

async function readSusfAvailability({
  bookingUrl = process.env.SUSF_BOOKING_URL ?? DEFAULT_BOOKING_URL,
  days = 7,
  durationMinutes = 60,
  captureTimeoutMs = Number(process.env.CAPTURE_TIMEOUT_MS ?? DEFAULT_CAPTURE_TIMEOUT_MS),
  headless = process.env.HEADLESS === '1',
} = {}) {
  const normalizedBookingUrl = normalizeConfiguredUrl(bookingUrl);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const facilityListUrl = await navigateToTennisFacilityList(page, normalizedBookingUrl);

    if (await isLoginPage(page)) {
      throw new SusfAvailabilityError('SESSION_EXPIRED');
    }

    const courts = await findCourtFacilities(page);

    if (courts.length === 0) {
      throw new Error('Could not find any Tennis court data-facilityid values.');
    }

    const date = todayIsoDate();
    const rows = [];

    for (const court of courts) {
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

      const requestOptions = {
        facilityId: court.facilityId,
        date,
        token,
        daysCount: days,
        durationMinutes,
      };
      const request = prepareAvailabilityRequest(captured, requestOptions);
      const responseJson = await fetchAvailabilityJson(page, request);

      rows.push(...normalizeAvailability(responseJson, court.court, { durationMinutes })
        .map((row) => ({
          ...row,
          facilityId: court.facilityId,
          price_options: priceOptions,
          observedAt: new Date().toISOString(),
        })));
    }

    rows.sort((a, b) => `${a.date} ${a.start_time} ${a.court}`.localeCompare(`${b.date} ${b.start_time} ${b.court}`));
    const rankedCandidates = buildRankedCandidates(rows, { durationMinutes });

    const availability = rankedCandidates.map(toPublicAvailability);
    availability.discovery = {
      facilityCount: courts.length,
      courtCount: courts.length,
    };
    return availability;
  } finally {
    await browser.close();
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
  SusfAvailabilityError,
  buildRankedCandidates,
  discoverTennisCourtsFromFacilities,
  extractRateTableFromHtml,
  extractSerializedPriceArrays,
  findCourtFacilities,
  getSusfAvailability,
  normalizeRateTableFromPriceArrays,
  normalizeAvailability,
  readSusfAvailability,
  toPublicAvailability,
};
