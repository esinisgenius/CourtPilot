import { SYDNEY_TIME_ZONE } from './types.mjs';

function getDateTimeParts(startTime, { timeZone = SYDNEY_TIME_ZONE } = {}) {
  const date = new Date(startTime);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid startTime: ${startTime}`);
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });

  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function getSydneyLocalDateTime(startTime) {
  const parts = getDateTimeParts(startTime);
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday,
  };
}

function timeToMinutes(time) {
  const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`Invalid HH:mm time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function matchesStartTimeRule(localTime, rule = {}) {
  const minutes = timeToMinutes(localTime);

  if (rule.equals !== undefined && minutes !== timeToMinutes(rule.equals)) {
    return false;
  }

  const hasBefore = rule.before !== undefined;
  const hasAfter = rule.after !== undefined;
  if (!hasBefore && !hasAfter) return null;

  const beforeMatches = hasBefore ? minutes < timeToMinutes(rule.before) : false;
  const afterMatches = hasAfter ? minutes >= timeToMinutes(rule.after) : false;
  return beforeMatches || afterMatches;
}

function annotateCandidateWithPreferences(candidate, profile) {
  const matches = {};

  for (const preference of profile.preferences ?? []) {
    if (preference.feature === 'start_time' && preference.rule) {
      matches.start_time = matchesStartTimeRule(candidate.features.localTime, preference.rule);
    }

    if (preference.feature === 'next_hour_free') {
      matches.next_hour_free = candidate.features.nextHourFree === preference.target;
    }

    if (preference.feature === 'consecutive_availability') {
      const requiredMinutes = preference.rule?.minMinutes ?? preference.rule?.preferredMinutes;
      matches.consecutive_availability = requiredMinutes === 120
        ? candidate.features.nextHourFree === true
        : null;
    }

    if (preference.feature === 'price') {
      matches.price = candidate.features.price === null
        ? (candidate.features.priceOptions?.length > 0 ? 'options_available' : 'unknown')
        : null;
    }
  }

  return {
    ...candidate,
    matches,
  };
}

export {
  annotateCandidateWithPreferences,
  getSydneyLocalDateTime,
  matchesStartTimeRule,
  timeToMinutes,
};
