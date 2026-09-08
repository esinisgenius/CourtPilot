import { getCalendarBusy, intervalEnd, isCalendarFree } from '../../calendar/src/index.mjs';
import { getWeatherForSlots } from '../../weather/src/index.mjs';
import { enrichCandidateAccessibility } from './accessibility.mjs';
import { SYDNEY_TIME_ZONE } from './types.mjs';

const USYD_TENNIS_LOCATION = Object.freeze({
  latitude: -33.8886,
  longitude: 151.1873,
  timezone: SYDNEY_TIME_ZONE,
});

function candidateSlots(candidates) {
  return candidates.map((candidate) => ({
    id: candidate.id,
    startTime: candidate.startTime,
    durationMinutes: candidate.durationMinutes,
  }));
}

function candidateSearchWindow(candidates) {
  if (candidates.length === 0) return null;

  const starts = candidates.map((candidate) => new Date(candidate.startTime).getTime());
  const ends = candidates.map((candidate) => new Date(intervalEnd(candidate.startTime, candidate.durationMinutes)).getTime());

  return {
    start: new Date(Math.min(...starts)).toISOString(),
    end: new Date(Math.max(...ends)).toISOString(),
  };
}

function attachWeather(candidates, weatherRows) {
  const byCandidateId = new Map(weatherRows.map((row) => [row.candidateId, row]));
  return candidates.map((candidate) => ({
    ...candidate,
    features: {
      ...candidate.features,
      weather: byCandidateId.get(candidate.id) ?? {
        candidateId: candidate.id,
        startTime: candidate.startTime,
        temperatureC: null,
        feelsLikeC: null,
        precipitationProbability: null,
        precipitationMm: null,
        windKph: null,
        weatherCode: null,
        source: null,
        forecastAvailable: false,
        unavailableReason: 'weather_not_requested',
      },
    },
  }));
}

function attachCalendar(candidates, busyIntervals, {
  status = 'available',
  source = null,
  fallbackFrom,
  fallbackReason,
} = {}) {
  return candidates.map((candidate) => ({
    ...candidate,
    features: {
      ...candidate.features,
      calendar: {
        free: status === 'available' ? isCalendarFree(candidate, busyIntervals) : null,
        status,
        source,
        ...(fallbackFrom ? { fallbackFrom } : {}),
        ...(fallbackReason ? { fallbackReason } : {}),
      },
    },
  }));
}

async function enrichCandidates({
  candidates,
  location = USYD_TENNIS_LOCATION,
  weatherAdapter = getWeatherForSlots,
  calendarAdapter = getCalendarBusy,
  accessibilityAdapter = null,
  accessibilityOptions = null,
  timezone = location.timezone,
} = {}) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array');

  const weatherRows = await weatherAdapter({
    location,
    slots: candidateSlots(candidates),
  });

  let calendarStatus = 'available';
  let calendarSource = null;
  let calendarFallbackFrom;
  let calendarFallbackReason;
  let busyIntervals = [];
  const window = candidateSearchWindow(candidates);
  if (window) {
    try {
      const calendar = await calendarAdapter({
        start: window.start,
        end: window.end,
        timezone,
      });
      calendarStatus = calendar.status ?? 'available';
      calendarSource = calendar.source ?? null;
      calendarFallbackFrom = calendar.fallbackFrom;
      calendarFallbackReason = calendar.fallbackReason;
      busyIntervals = calendar.busy ?? [];
    } catch (error) {
      calendarStatus = error.code ?? 'calendar_error';
    }
  }

  let enriched = attachCalendar(attachWeather(candidates, weatherRows), busyIntervals, {
    status: calendarStatus,
    source: calendarSource,
    fallbackFrom: calendarFallbackFrom,
    fallbackReason: calendarFallbackReason,
  });

  if (accessibilityOptions) {
    const candidateAccessibilityOptions = {
      candidates: enriched,
      ...accessibilityOptions,
    };
    if (accessibilityAdapter) {
      candidateAccessibilityOptions.accessibilityAdapter = accessibilityAdapter;
    }
    enriched = await enrichCandidateAccessibility(candidateAccessibilityOptions);
  }

  return enriched;
}

export {
  USYD_TENNIS_LOCATION,
  attachCalendar,
  attachWeather,
  candidateSearchWindow,
  candidateSlots,
  enrichCandidates,
};
