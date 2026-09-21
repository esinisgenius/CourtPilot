import { SYDNEY_TIME_ZONE } from './types.mjs';
import { getSydneyLocalDateTime, timeToMinutes } from './features.mjs';

const WEEKDAYS = Object.freeze({
  sunday: 0,
  sun: 0,
  周日: 0,
  周天: 0,
  星期日: 0,
  星期天: 0,
  monday: 1,
  mon: 1,
  周一: 1,
  星期一: 1,
  tuesday: 2,
  tue: 2,
  周二: 2,
  星期二: 2,
  wednesday: 3,
  wed: 3,
  周三: 3,
  星期三: 3,
  thursday: 4,
  thu: 4,
  周四: 4,
  星期四: 4,
  friday: 5,
  fri: 5,
  周五: 5,
  星期五: 5,
  saturday: 6,
  sat: 6,
  周六: 6,
  星期六: 6,
});

const PERIOD_WINDOWS = Object.freeze({
  morning: { timeStart: '06:00', timeEnd: '12:00' },
  midday: { timeStart: '11:00', timeEnd: '14:00' },
  afternoon: { timeStart: '12:00', timeEnd: '18:00' },
  evening: { timeStart: '18:00', timeEnd: null },
  night: { timeStart: '18:00', timeEnd: null },
});

const RELATIVE_DAY_OFFSETS = Object.freeze({
  today: 0,
  今天: 0,
  tomorrow: 1,
  明天: 1,
  后天: 2,
});

function addDays(isoDate, days) {
  const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetweenInclusive(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 86400000) + 1;
}

function sydneyToday(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.valueOf())) return null;
  return getSydneyLocalDateTime(instant.toISOString()).localDate;
}

function weekdayIndex(isoDate) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return null;
  return date.getUTCDay();
}

function nextWeekdayDate(targetWeekday, today, { nextWeek = false } = {}) {
  const current = weekdayIndex(today);
  if (current === null || targetWeekday === null || targetWeekday === undefined) return null;
  if (nextWeek) {
    const currentWeekMonday = addDays(today, -((current + 6) % 7));
    return addDays(currentWeekMonday, 7 + targetWeekday - 1);
  }
  const delta = (targetWeekday - current + 7) % 7;
  return addDays(today, delta);
}

function weekdayFromText(text = '') {
  const normalized = String(text).toLowerCase();
  for (const [label, index] of Object.entries(WEEKDAYS)) {
    if (normalized.includes(label)) return index;
  }
  return null;
}

function explicitDateFromText(text = '') {
  const match = String(text).match(/\b\d{4}-\d{2}-\d{2}\b/);
  return match?.[0] ?? null;
}

function relativeDayOffsetFromText(text = '') {
  const normalized = String(text).toLowerCase();
  for (const [label, offset] of Object.entries(RELATIVE_DAY_OFFSETS)) {
    if (normalized.includes(label)) return offset;
  }
  return null;
}

function symbolicDateSemantic(text = '') {
  const explicitDate = explicitDateFromText(text);
  if (explicitDate) return { kind: 'explicit_date', date: explicitDate };

  const relativeDayOffset = relativeDayOffsetFromText(text);
  if (relativeDayOffset !== null) return { kind: 'relative_day_offset', offsetDays: relativeDayOffset };

  const weekday = weekdayFromText(text);
  if (weekday !== null) {
    return {
      kind: 'weekday',
      weekday,
      weekOffset: /下周|next\s+(?:week|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)/i.test(String(text)) ? 1 : 0,
    };
  }

  return null;
}

function inferDateRangeFromText(text = '') {
  const normalized = String(text).toLowerCase();
  if (/未来\s*三\s*天|未来\s*3\s*天|next\s+(few|three|3)\s+days/.test(normalized)
    || normalized.includes('最近几天') || normalized.includes('这几天')) {
    return { type: 'next_few_days', sourceText: text };
  }
  if (normalized.includes('周末') || normalized.includes('weekend')) return { type: 'weekend', sourceText: text };
  const symbolic = symbolicDateSemantic(normalized);
  if (symbolic?.kind === 'relative_day_offset') {
    return { type: 'relative_days', offsetDays: symbolic.offsetDays, sourceText: text };
  }
  if (symbolic?.kind === 'weekday') {
    return {
      type: 'weekday',
      weekday: symbolic.weekday,
      nextWeek: symbolic.weekOffset === 1,
      sourceText: text,
    };
  }
  const weekday = weekdayFromText(normalized);
  if (weekday !== null) {
    return {
      type: 'weekday',
      weekday,
      nextWeek: /下周|next\s+week/.test(normalized),
      sourceText: text,
    };
  }
  return null;
}

function canonicalDateSemantic(dateRange, sourceText = '') {
  if (!dateRange?.type) {
    const inferred = inferDateRangeFromText(sourceText);
    return inferred ? canonicalDateSemantic(inferred, '') : { kind: 'unspecified' };
  }

  if (dateRange.type === 'specific_date') {
    const symbolicValue = symbolicDateSemantic(dateRange.value);
    if (symbolicValue) return symbolicValue;
    const symbolicSourceText = symbolicDateSemantic(dateRange.sourceText);
    if (symbolicSourceText) return symbolicSourceText;
    if (dateRange.startDate) return symbolicDateSemantic(dateRange.startDate) ?? { kind: 'unresolved' };
    return { kind: 'unresolved' };
  }

  if (dateRange.type === 'date_range') {
    return dateRange.startDate && dateRange.endDate
      ? { kind: 'date_range', dateStart: dateRange.startDate, dateEnd: dateRange.endDate }
      : { kind: 'unresolved' };
  }

  if (dateRange.type === 'relative_days') {
    return Number.isInteger(Number(dateRange.offsetDays))
      ? { kind: 'relative_day_offset', offsetDays: Number(dateRange.offsetDays) }
      : { kind: 'unresolved' };
  }

  if (dateRange.type === 'today') return { kind: 'relative_day_offset', offsetDays: 0 };
  if (dateRange.type === 'tomorrow') return { kind: 'relative_day_offset', offsetDays: 1 };
  if (dateRange.type === 'weekday') {
    return Number.isInteger(Number(dateRange.weekday))
      ? { kind: 'weekday', weekday: Number(dateRange.weekday), weekOffset: dateRange.nextWeek ? 1 : 0 }
      : { kind: 'unresolved' };
  }
  if (dateRange.type === 'next_few_days') return { kind: 'relative_range', startOffsetDays: 0, endOffsetDays: 2 };
  if (dateRange.type === 'weekend') return { kind: 'weekend', weekOffset: 0 };
  if (dateRange.type === 'this_week') return { kind: 'relative_range', startOffsetDays: 0, endOffsetDays: 6 };
  if (dateRange.type === 'next_week') return { kind: 'week_range', weekOffset: 1 };

  return symbolicDateSemantic(dateRange.sourceText) ?? { kind: 'unresolved' };
}

function resolveDateWindow(dateRange, { now = new Date(), sourceText = '' } = {}) {
  const today = sydneyToday(now);
  if (!today) return { dateStart: null, dateEnd: null, source: 'unresolved' };
  const semantic = canonicalDateSemantic(dateRange, sourceText);

  if (semantic.kind === 'unspecified') return { dateStart: null, dateEnd: null, source: 'unspecified' };
  if (semantic.kind === 'explicit_date') return { dateStart: semantic.date, dateEnd: semantic.date, source: 'explicit' };
  if (semantic.kind === 'relative_day_offset') {
    const date = addDays(today, semantic.offsetDays);
    return { dateStart: date, dateEnd: date, source: 'relative' };
  }
  if (semantic.kind === 'weekday') {
    const date = nextWeekdayDate(semantic.weekday, today, { nextWeek: semantic.weekOffset === 1 });
    return date
      ? { dateStart: date, dateEnd: date, source: 'explicit' }
      : { dateStart: null, dateEnd: null, source: 'unresolved' };
  }
  if (semantic.kind === 'date_range') {
    return { dateStart: semantic.dateStart, dateEnd: semantic.dateEnd, source: 'range' };
  }
  if (semantic.kind === 'relative_range') {
    return {
      dateStart: addDays(today, semantic.startOffsetDays),
      dateEnd: addDays(today, semantic.endOffsetDays),
      source: 'range',
    };
  }
  if (semantic.kind === 'weekend') {
    const saturday = nextWeekdayDate(6, today);
    return { dateStart: saturday, dateEnd: addDays(saturday, 1), source: 'range' };
  }
  if (semantic.kind === 'week_range') {
    const start = nextWeekdayDate(1, today, { nextWeek: true });
    return { dateStart: start, dateEnd: addDays(start, 6), source: 'range' };
  }
  return { dateStart: null, dateEnd: null, source: 'unresolved' };
}

function normalizeHour(hour, meridiem) {
  let value = Number(hour);
  if (!Number.isInteger(value)) return null;
  if (/p/i.test(meridiem ?? '') && value < 12) value += 12;
  if (/a/i.test(meridiem ?? '') && value === 12) value = 0;
  if (value < 0 || value > 23) return null;
  return `${String(value).padStart(2, '0')}:00`;
}

function inferTimeWindowFromText(text = '') {
  const normalized = String(text).toLowerCase();
  if (hasDisjointBeforeAfterWindow(normalized)) return null;
  const after = normalized.match(/(?:after|以后|之后|点后)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:点)?\s*(?:以后|之后|点后)/);
  if (after) {
    const hour = after[1] ?? after[4];
    const minute = after[2] ?? after[5] ?? '00';
    const time = normalizeHour(hour, after[3] ?? after[6]);
    return time ? { timeStart: `${time.slice(0, 3)}${minute}`, timeEnd: null } : null;
  }
  const before = normalized.match(/(?:before|以前|之前|点前)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:点)?\s*(?:以前|之前|点前)/);
  if (before) {
    const hour = before[1] ?? before[4];
    const minute = before[2] ?? before[5] ?? '00';
    const time = normalizeHour(hour, before[3] ?? before[6]);
    return time ? { timeStart: null, timeEnd: `${time.slice(0, 3)}${minute}` } : null;
  }
  if (normalized.includes('下午') || normalized.includes('afternoon')) return PERIOD_WINDOWS.afternoon;
  if (normalized.includes('晚上') || normalized.includes('evening') || normalized.includes('night')) return PERIOD_WINDOWS.evening;
  if (normalized.includes('上午') || normalized.includes('早上') || normalized.includes('morning')) return PERIOD_WINDOWS.morning;
  return null;
}

function hasDisjointBeforeAfterWindow(text = '') {
  const beforeMatch = String(text).match(/(\d{1,2})(?::([0-5]\d))?\s*(?:点)?\s*(?:前|以前|之前)/);
  const afterMatch = String(text).match(/(\d{1,2})(?::([0-5]\d))?\s*(?:点)?\s*(?:后|以后|之后)/);
  if (!beforeMatch || !afterMatch) return false;
  const connector = String(text).slice(beforeMatch.index + beforeMatch[0].length, afterMatch.index);
  return /(?:或者|或|和|、|,|，|\/|\bor\b)/iu.test(connector);
}

function resolveTimeWindow(timeWindow, { sourceText = '' } = {}) {
  if (timeWindow?.after || timeWindow?.before || timeWindow?.period) {
    const period = PERIOD_WINDOWS[timeWindow.period] ?? {};
    if (timeWindow.before && timeWindow.after) {
      return {
        timeStart: null,
        timeEnd: null,
        timeWindows: [
          { start: '00:00', end: timeWindow.before },
          { start: timeWindow.after, end: '23:59' },
        ],
      };
    }
    return {
      timeStart: timeWindow.after ?? period.timeStart ?? null,
      timeEnd: timeWindow.before ?? period.timeEnd ?? null,
      timeWindows: null,
    };
  }
  const inferred = inferTimeWindowFromText(sourceText);
  return inferred ? { ...inferred, timeWindows: null } : { timeStart: null, timeEnd: null, timeWindows: null };
}

function resolveTemporalWindow({
  dateRange = null,
  timeWindow = null,
  sourceText = '',
  now = new Date(),
  timezone = SYDNEY_TIME_ZONE,
} = {}) {
  const date = resolveDateWindow(dateRange, { now, sourceText });
  const time = resolveTimeWindow(timeWindow, { sourceText });
  const hasRawTemporal = Boolean(dateRange || timeWindow || inferDateRangeFromText(sourceText) || inferTimeWindowFromText(sourceText));
  const unresolved = hasRawTemporal && date.source === 'unresolved';
  return {
    dateStart: date.dateStart,
    dateEnd: date.dateEnd,
    timeStart: time.timeStart,
    timeEnd: time.timeEnd,
    timeWindows: time.timeWindows,
    timezone,
    source: unresolved ? 'unresolved' : date.source === 'unspecified' && !time.timeStart && !time.timeEnd ? 'unspecified' : date.source,
    unresolved,
  };
}

function temporalWindowDays(temporalWindow) {
  if (!temporalWindow?.dateStart || !temporalWindow?.dateEnd) return null;
  return daysBetweenInclusive(temporalWindow.dateStart, temporalWindow.dateEnd);
}

function candidateMatchesTemporalWindow(candidate, temporalWindow = {}) {
  const localDate = candidate.features?.localDate ?? getSydneyLocalDateTime(candidate.startTime).localDate;
  const localTime = candidate.features?.localTime ?? getSydneyLocalDateTime(candidate.startTime).localTime;
  if (temporalWindow.dateStart && localDate < temporalWindow.dateStart) return false;
  if (temporalWindow.dateEnd && localDate > temporalWindow.dateEnd) return false;
  if (Array.isArray(temporalWindow.timeWindows) && temporalWindow.timeWindows.length > 0) {
    const candidateMinutes = timeToMinutes(localTime);
    const matches = temporalWindow.timeWindows.some((window) => {
      const start = window.start ? timeToMinutes(window.start) : 0;
      const end = window.end ? timeToMinutes(window.end) : 24 * 60;
      return start <= end && candidateMinutes >= start && candidateMinutes < end;
    });
    if (!matches) return false;
  } else {
    if (temporalWindow.timeStart && timeToMinutes(localTime) < timeToMinutes(temporalWindow.timeStart)) return false;
    if (temporalWindow.timeEnd && timeToMinutes(localTime) >= timeToMinutes(temporalWindow.timeEnd)) return false;
  }
  return true;
}

export {
  addDays,
  candidateMatchesTemporalWindow,
  inferDateRangeFromText,
  inferTimeWindowFromText,
  resolveTemporalWindow,
  temporalWindowDays,
};
