import { evaluateTransportThresholds } from './transport-preferences.mjs';
import { getSydneyLocalDateTime, matchesStartTimeRule } from './features.mjs';
import { candidateMatchesTemporalWindow } from './temporal.mjs';

function hardConstraints(profile) {
  return profile?.hardConstraints ?? [];
}

function hasHardConstraint(profile, feature) {
  return hardConstraints(profile).some((constraint) => constraint.feature === feature);
}

function weatherConstraints(profile) {
  return hardConstraints(profile).filter((constraint) => constraint.feature === 'weather');
}

const rainLikeWeatherCodes = new Set([
  '51',
  '53',
  '55',
  '56',
  '57',
  '61',
  '63',
  '65',
  '66',
  '67',
  '80',
  '81',
  '82',
  '95',
  '96',
  '99',
]);

function noPrecipitationConstraint(constraint) {
  return ['no_precipitation', 'no_rain'].includes(constraint.value)
    || ['no_precipitation', 'no_rain'].includes(constraint.rule?.condition)
    || (constraint.direction === 'avoid' && constraint.target === true);
}

function normalizedProbability(value) {
  if (!Number.isFinite(value)) return null;
  return value <= 1 ? value * 100 : value;
}

function normalizedWeatherCondition(weather = {}) {
  const condition = weather.condition ?? weather.weatherCondition ?? weather.summary ?? null;
  return typeof condition === 'string' ? condition.toLowerCase() : null;
}

function isRainLikeCondition(condition) {
  if (!condition) return false;
  return ['rain', 'storm', 'thunderstorm'].some((term) => condition.includes(term));
}

function isBadWeather(weather = {}) {
  if (!weather?.forecastAvailable) return false;
  const precipitationProbability = normalizedProbability(weather.precipitationProbability);
  const condition = normalizedWeatherCondition(weather);
  const weatherCode = weather.weatherCode == null ? null : String(weather.weatherCode);

  return (precipitationProbability !== null && precipitationProbability >= 50)
    || isRainLikeCondition(condition)
    || rainLikeWeatherCodes.has(weatherCode);
}

function weatherWarning(weather = {}) {
  return {
    active: true,
    badWeather: true,
    condition: weather.condition ?? weather.weatherCondition ?? weather.summary ?? null,
    precipitationProbability: weather.precipitationProbability ?? null,
    weatherCode: weather.weatherCode ?? null,
  };
}

function withWeatherMetadata(candidate, metadata) {
  return {
    ...candidate,
    features: {
      ...candidate.features,
      ...metadata,
    },
  };
}

function isOutdoorCourt(candidate) {
  const explicitOutdoor = candidate.features?.outdoor
    ?? candidate.features?.court?.outdoor
    ?? candidate.source?.canonicalAvailability?.court?.outdoor;
  const explicitIndoor = candidate.features?.indoor
    ?? candidate.features?.court?.indoor
    ?? candidate.source?.canonicalAvailability?.court?.indoor;

  if (explicitOutdoor === false || explicitIndoor === true) return false;
  return true;
}

function evaluateWeather(candidate, preferenceProfile) {
  const constraints = weatherConstraints(preferenceProfile);
  const weather = candidate.features?.weather;
  const failures = [];
  let warning = null;
  let weatherUnknown = false;

  for (const constraint of constraints) {
    if (!weather?.forecastAvailable) {
      if (noPrecipitationConstraint(constraint)) {
        failures.push({
          feature: 'weather',
          reason: 'weather_unknown',
        });
      }
      continue;
    }

    if (noPrecipitationConstraint(constraint) && weather.precipitationMm === null) {
      failures.push({
        feature: 'weather',
        reason: 'weather_precipitation_unknown',
      });
      continue;
    }

    if (noPrecipitationConstraint(constraint) && weather.precipitationMm > 0) {
      failures.push({
        feature: 'weather',
        reason: 'weather_precipitation',
      });
      continue;
    }

    if (noPrecipitationConstraint(constraint) && isBadWeather(weather)) {
      const warning = weatherWarning(weather);
      failures.push({
        feature: 'weather',
        reason: 'weather_bad_condition',
        badWeather: true,
        condition: warning.condition,
        precipitationProbability: warning.precipitationProbability,
        weatherCode: warning.weatherCode,
      });
    }
  }

  if (!weather?.forecastAvailable) {
    weatherUnknown = true;
  } else if (isOutdoorCourt(candidate) && isBadWeather(weather)) {
    warning = weatherWarning(weather);
  }

  return {
    accepted: failures.length === 0,
    failures,
    warning,
    weatherUnknown,
  };
}

function candidateStartDate(candidate) {
  const value = candidate?.startTime ?? candidate?.source?.canonicalAvailability?.slot?.start;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function evaluationNow(preferenceProfile, options = {}) {
  if (options.now instanceof Date) return options.now;
  if (typeof options.now === 'string') return new Date(options.now);
  if (preferenceProfile?.updatedAt) return new Date(preferenceProfile.updatedAt);
  return new Date();
}

function evaluateAvailabilityNotPast(candidate, preferenceProfile, options = {}) {
  const start = candidateStartDate(candidate);
  if (!start) {
    return {
      accepted: false,
      failures: [{
        feature: 'availability',
        reason: 'availability_start_time_unknown',
      }],
    };
  }

  const now = evaluationNow(preferenceProfile, options);
  if (Number.isNaN(now.valueOf())) return { accepted: true, failures: [] };
  if (start <= now) {
    return {
      accepted: false,
      failures: [{
        feature: 'availability',
        reason: 'availability_start_in_past',
        startTime: candidate.startTime,
        now: now.toISOString(),
      }],
    };
  }

  return { accepted: true, failures: [] };
}

function transportConstraints(profile) {
  return hardConstraints(profile).filter((constraint) => constraint.feature === 'travel_time');
}

function evaluateTransport(candidate, preferenceProfile) {
  const constraints = transportConstraints(preferenceProfile);
  const failures = [];

  for (const constraint of constraints) {
    const checks = evaluateTransportThresholds(candidate, constraint.rule ?? {});
    for (const check of checks) {
      if (check.accepted === false) {
        failures.push({
          feature: 'travel_time',
          mode: check.mode,
          reason: 'transport_time_exceeds_limit',
          durationMinutes: check.durationMinutes,
          maxMinutes: check.maxMinutes,
        });
      }
      if (check.accepted === null) {
        failures.push({
          feature: 'travel_time',
          mode: check.mode,
          reason: check.reason,
          factStatus: check.factStatus,
          maxMinutes: check.maxMinutes,
        });
      }
    }
  }

  return {
    accepted: failures.length === 0,
    failures,
  };
}

function startTimeConstraints(profile) {
  return hardConstraints(profile).filter((constraint) => constraint.feature === 'start_time');
}

function temporalWindow(profile) {
  return profile?.searchScope?.temporalWindow ?? null;
}

function evaluateStartTime(candidate, preferenceProfile) {
  const constraints = startTimeConstraints(preferenceProfile);
  const failures = [];
  const window = temporalWindow(preferenceProfile);
  if (window?.timeStart || window?.timeEnd || window?.timeWindows?.length) {
    if (!candidateMatchesTemporalWindow(candidate, {
      timeStart: window.timeStart ?? null,
      timeEnd: window.timeEnd ?? null,
      timeWindows: window.timeWindows ?? null,
    })) {
      failures.push({
        feature: 'start_time',
        reason: 'start_time_outside_temporal_window',
        localTime: candidate.features?.localTime ?? null,
        temporalWindow: window,
      });
    }
    return {
      accepted: failures.length === 0,
      failures,
    };
  }

  for (const constraint of constraints) {
    const localTime = candidate.features?.localTime;
    if (typeof localTime !== 'string') {
      failures.push({
        feature: 'start_time',
        reason: 'start_time_unknown',
      });
      continue;
    }

    const matches = matchesStartTimeRule(localTime, constraint.rule ?? {});
    if (matches === false) {
      failures.push({
        feature: 'start_time',
        reason: 'start_time_outside_hard_window',
        localTime,
        rule: constraint.rule ?? {},
      });
    }
  }

  return {
    accepted: failures.length === 0,
    failures,
  };
}

function dateConstraints(profile) {
  return hardConstraints(profile).filter((constraint) => constraint.feature === 'date');
}

function localDateForCandidate(candidate) {
  return candidate.features?.localDate ?? getSydneyLocalDateTime(candidate.startTime).localDate;
}

function weekdayForCandidate(candidate) {
  return candidate.features?.weekday ?? getSydneyLocalDateTime(candidate.startTime).weekday;
}

function dateForRelativeRange(type, now = new Date()) {
  const local = getSydneyLocalDateTime(now.toISOString()).localDate;
  const base = new Date(`${local}T00:00:00.000Z`);
  if (type === 'today') return local;
  if (type === 'tomorrow') {
    base.setUTCDate(base.getUTCDate() + 1);
    return base.toISOString().slice(0, 10);
  }
  return null;
}

function matchesDateRange(candidate, dateRange = {}, { now = new Date() } = {}) {
  const localDate = localDateForCandidate(candidate);
  const weekday = weekdayForCandidate(candidate);
  if (dateRange.type === 'specific_date') {
    const expected = dateRange.startDate ?? dateRange.value;
    if (expected === 'Saturday') return weekday === 'Sat';
    if (expected === 'Sunday') return weekday === 'Sun';
    return expected ? localDate === expected : null;
  }
  if (dateRange.type === 'date_range') {
    if (!dateRange.startDate || !dateRange.endDate) return null;
    return localDate >= dateRange.startDate && localDate <= dateRange.endDate;
  }
  if (dateRange.type === 'today' || dateRange.type === 'tomorrow') {
    const expected = dateForRelativeRange(dateRange.type, now);
    return expected ? localDate === expected : null;
  }
  if (dateRange.type === 'weekend') {
    return weekday === 'Sat' || weekday === 'Sun';
  }
  return null;
}

function evaluateDate(candidate, preferenceProfile) {
  const constraints = dateConstraints(preferenceProfile);
  const failures = [];
  const now = preferenceProfile?.updatedAt ? new Date(preferenceProfile.updatedAt) : new Date();
  const window = temporalWindow(preferenceProfile);

  if (window?.unresolved) {
    failures.push({
      feature: 'date',
      reason: 'temporal_window_unresolved',
      localDate: localDateForCandidate(candidate),
      temporalWindow: window,
    });
    return {
      accepted: false,
      failures,
    };
  } else if (window?.dateStart || window?.dateEnd) {
    if (!candidateMatchesTemporalWindow(candidate, {
      dateStart: window.dateStart ?? null,
      dateEnd: window.dateEnd ?? null,
    })) {
      failures.push({
        feature: 'date',
        reason: 'date_outside_temporal_window',
        localDate: localDateForCandidate(candidate),
        temporalWindow: window,
      });
    }
    return {
      accepted: failures.length === 0,
      failures,
    };
  }

  for (const constraint of constraints) {
    const dateRange = constraint.rule?.dateRange;
    const matches = dateRange ? matchesDateRange(candidate, dateRange, { now }) : null;
    const violates = constraint.direction === 'avoid' ? matches === true : matches === false;
    if (violates) {
      failures.push({
        feature: 'date',
        reason: constraint.direction === 'avoid' ? 'date_matches_hard_exclusion' : 'date_outside_hard_window',
        localDate: localDateForCandidate(candidate),
        rule: constraint.rule ?? {},
      });
    } else if (matches === null) {
      failures.push({
        feature: 'date',
        reason: 'date_rule_unresolved',
        localDate: localDateForCandidate(candidate),
        rule: constraint.rule ?? {},
      });
    }
  }

  return {
    accepted: failures.length === 0,
    failures,
  };
}

function consecutiveAvailabilityConstraints(profile) {
  return hardConstraints(profile).filter((constraint) => constraint.feature === 'consecutive_availability');
}

function continuousMinutes(candidate) {
  if (Number.isFinite(candidate.features?.continuousDurationMinutes)) return candidate.features.continuousDurationMinutes;
  if (Number.isFinite(candidate.continuousDurationMinutes)) return candidate.continuousDurationMinutes;
  if (Number.isFinite(candidate.durationMinutes) && candidate.durationMinutes >= 120) return candidate.durationMinutes;
  if (candidate.features?.nextHourFree === true) return Math.max(Number(candidate.durationMinutes) || 0, 120);
  if (candidate.features?.nextHourFree === false) return Number(candidate.durationMinutes) || 60;
  return null;
}

function evaluateConsecutiveAvailability(candidate, preferenceProfile) {
  const constraints = consecutiveAvailabilityConstraints(preferenceProfile);
  const failures = [];

  for (const constraint of constraints) {
    const requiredMinutes = constraint.rule?.minMinutes ?? constraint.rule?.preferredMinutes;
    if (!Number.isFinite(requiredMinutes)) continue;
    const availableMinutes = continuousMinutes(candidate);
    if (!Number.isFinite(availableMinutes)) {
      failures.push({
        feature: 'consecutive_availability',
        reason: 'consecutive_availability_unknown',
        requiredMinutes,
      });
      continue;
    }
    if (availableMinutes < requiredMinutes) {
      failures.push({
        feature: 'consecutive_availability',
        reason: 'consecutive_availability_insufficient',
        requiredMinutes,
        availableMinutes,
      });
    }
  }

  return {
    accepted: failures.length === 0,
    failures,
  };
}

function applyHardConstraints({
  candidates,
  preferenceProfile,
  now,
} = {}) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array');

  const accepted = [];
  const rejected = [];

  for (const candidate of candidates) {
    const weatherEvaluation = evaluateWeather(candidate, preferenceProfile);
    const reasons = [
      ...evaluateAvailabilityNotPast(candidate, preferenceProfile, { now }).failures,
      ...weatherEvaluation.failures,
      ...evaluateTransport(candidate, preferenceProfile).failures,
      ...evaluateStartTime(candidate, preferenceProfile).failures,
      ...evaluateDate(candidate, preferenceProfile).failures,
      ...evaluateConsecutiveAvailability(candidate, preferenceProfile).failures,
    ];

    if (reasons.length === 0) {
      accepted.push(withWeatherMetadata(candidate, {
        ...(weatherEvaluation.warning ? { weatherWarning: weatherEvaluation.warning } : {}),
        ...(weatherEvaluation.weatherUnknown ? { weatherUnknown: true } : {}),
      }));
    } else {
      rejected.push({ candidate, reasons });
    }
  }

  return { accepted, rejected };
}

export {
  applyHardConstraints,
  evaluateAvailabilityNotPast,
  evaluateConsecutiveAvailability,
  evaluateDate,
  evaluateStartTime,
  evaluateTransport,
  evaluateWeather,
  isBadWeather,
};
