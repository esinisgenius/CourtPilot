import { getCalendarBusy, intervalEnd, isCalendarFree } from '../../calendar/src/index.mjs';
import { canonicalWeatherLocation, resolveCanonicalLocation } from '../../maps/src/index.mjs';
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

function weatherLocationFromVenue(candidate) {
  const venue = candidate.source?.canonicalAvailability?.venue ?? candidate.features?.venue;
  if (Number.isFinite(venue?.location?.lat) && Number.isFinite(venue?.location?.lng)) {
    return {
      id: venue.id ?? candidate.venue,
      label: venue.name ?? candidate.venue,
      latitude: venue.location.lat,
      longitude: venue.location.lng,
      timezone: SYDNEY_TIME_ZONE,
      source: 'venue_coordinates',
    };
  }
  return null;
}

function suburbWeatherLocations(candidate) {
  const venue = candidate.source?.canonicalAvailability?.venue ?? candidate.features?.venue;
  const suburb = venue?.suburb;
  if (!suburb) return [];

  const canonical = resolveCanonicalLocation(suburb);
  if (!canonical) return [];

  return [
    {
      level: 'suburb',
      location: {
        id: canonical.id,
        label: canonical.canonicalName,
        latitude: canonical.lat,
        longitude: canonical.lng,
        timezone: SYDNEY_TIME_ZONE,
        source: 'canonical_suburb',
      },
      confidence: 'medium',
    },
    ...(canonical.nearbyWeatherLocations ?? []).map((id) => {
      const location = canonicalWeatherLocation(id);
      return location ? {
        level: 'nearby',
        location,
        confidence: 'medium_low',
      } : null;
    }).filter(Boolean),
  ];
}

function weatherFallbackChain(candidate, defaultLocation) {
  const venueLocation = weatherLocationFromVenue(candidate);
  return [
    ...(venueLocation ? [{
      level: 'venue',
      location: venueLocation,
      confidence: 'high',
    }] : []),
    ...suburbWeatherLocations(candidate),
    {
      level: 'sydney',
      location: {
        id: 'sydney',
        label: 'Sydney',
        latitude: defaultLocation.latitude,
        longitude: defaultLocation.longitude,
        timezone: defaultLocation.timezone,
        source: 'sydney_default',
      },
      confidence: 'low',
    },
  ];
}

function weatherLocationKey(entry) {
  return [
    entry.level,
    Number(entry.location.latitude).toFixed(4),
    Number(entry.location.longitude).toFixed(4),
    entry.location.timezone,
  ].join('|');
}

function annotateWeatherRow(row, entry) {
  return {
    ...row,
    weatherSource: entry.location.label ?? entry.location.id ?? row.source ?? null,
    fallbackLevel: entry.level,
    confidence: entry.confidence,
  };
}

function unavailableWeatherRow(candidate, entry, reason) {
  return annotateWeatherRow({
    candidateId: candidate.id,
    startTime: candidate.startTime,
    temperatureC: null,
    feelsLikeC: null,
    precipitationProbability: null,
    precipitationMm: null,
    windKph: null,
    weatherCode: null,
    source: entry.location.source,
    forecastAvailable: false,
    unavailableReason: reason,
  }, entry);
}

async function weatherRowsWithFallback({
  candidates,
  defaultLocation,
  weatherAdapter,
}) {
  const rows = new Map();
  const pending = new Map();

  for (const candidate of candidates) {
    pending.set(candidate.id, {
      candidate,
      chain: weatherFallbackChain(candidate, defaultLocation),
      index: 0,
      lastRow: null,
    });
  }

  while (pending.size > 0) {
    const batches = new Map();
    for (const state of pending.values()) {
      const entry = state.chain[state.index];
      if (!entry) {
        rows.set(state.candidate.id, state.lastRow ?? unavailableWeatherRow(state.candidate, {
          level: 'unavailable',
          location: {
            id: 'none',
            label: null,
            latitude: defaultLocation.latitude,
            longitude: defaultLocation.longitude,
            timezone: defaultLocation.timezone,
            source: 'weather_unavailable',
          },
          confidence: 'none',
        }, 'all_weather_sources_unavailable'));
        pending.delete(state.candidate.id);
        continue;
      }
      const key = weatherLocationKey(entry);
      batches.set(key, batches.get(key) ?? { entry, candidates: [] });
      batches.get(key).candidates.push(state.candidate);
    }

    for (const batch of batches.values()) {
      const slots = candidateSlots(batch.candidates);
      const batchRows = await weatherAdapter({
        location: batch.entry.location,
        slots,
      });
      const byId = new Map(batchRows.map((row) => [row.candidateId, annotateWeatherRow(row, batch.entry)]));
      for (const candidate of batch.candidates) {
        const row = byId.get(candidate.id)
          ?? unavailableWeatherRow(candidate, batch.entry, 'weather_row_missing');
        if (row.forecastAvailable) {
          rows.set(candidate.id, row);
          pending.delete(candidate.id);
        } else {
          const state = pending.get(candidate.id);
          if (state) {
            state.lastRow = row;
            state.index += 1;
          }
        }
      }
    }
  }

  return candidates.map((candidate) => rows.get(candidate.id));
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

  const weatherRows = await weatherRowsWithFallback({
    candidates,
    defaultLocation: location,
    weatherAdapter,
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
