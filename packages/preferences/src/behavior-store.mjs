const LOCAL_BEHAVIOR_STORAGE_KEY = 'findmycourt.behavior.v1';
const LOCAL_BEHAVIOR_STORAGE_VERSION = 1;
const MAX_HISTORY_ITEMS = 20;

const emptyBehavior = Object.freeze({
  recentSearches: [],
  recentSelections: [],
  recentBookingClicks: [],
});

function storageAvailable(storage) {
  if (!storage) return false;
  try {
    const probeKey = `${LOCAL_BEHAVIOR_STORAGE_KEY}.probe`;
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function browserStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function behaviorEnvelope(behavior) {
  return {
    storageVersion: LOCAL_BEHAVIOR_STORAGE_VERSION,
    behavior,
  };
}

function boundedNewest(items = [], maxItems = MAX_HISTORY_ITEMS) {
  return [...items]
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .sort((a, b) => Date.parse(b.timestamp ?? 0) - Date.parse(a.timestamp ?? 0))
    .slice(0, maxItems);
}

function normalizeBehavior(behavior = {}) {
  return {
    recentSearches: boundedNewest(behavior.recentSearches),
    recentSelections: boundedNewest(behavior.recentSelections),
    recentBookingClicks: boundedNewest(behavior.recentBookingClicks),
  };
}

function parseEnvelope(raw) {
  if (!raw) return { ...emptyBehavior };
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...emptyBehavior };
  if (parsed.storageVersion !== LOCAL_BEHAVIOR_STORAGE_VERSION) return { ...emptyBehavior };
  return normalizeBehavior(parsed.behavior ?? {});
}

function loadBehaviorHistory({ storage = browserStorage() } = {}) {
  if (!storageAvailable(storage)) return { ...emptyBehavior };
  return parseEnvelope(storage.getItem(LOCAL_BEHAVIOR_STORAGE_KEY));
}

function saveBehaviorHistory(behavior, { storage = browserStorage() } = {}) {
  if (!storageAvailable(storage)) return normalizeBehavior(behavior);
  const normalized = normalizeBehavior(behavior);
  storage.setItem(LOCAL_BEHAVIOR_STORAGE_KEY, JSON.stringify(behaviorEnvelope(normalized)));
  return normalized;
}

function appendHistoryItem(behavior, listName, item) {
  return normalizeBehavior({
    ...behavior,
    [listName]: [
      {
        timestamp: item.timestamp ?? new Date().toISOString(),
        ...item,
      },
      ...(behavior[listName] ?? []),
    ],
  });
}

function recordSearch(search, { storage = browserStorage(), now = new Date() } = {}) {
  const current = loadBehaviorHistory({ storage });
  const next = appendHistoryItem(current, 'recentSearches', {
    timestamp: nowIso(now),
    rawRequest: search.rawRequest ?? '',
    resolvedLocation: search.resolvedLocation ?? null,
    allowedTimeWindow: search.allowedTimeWindow ?? null,
  });
  return saveBehaviorHistory(next, { storage });
}

function recordSelection(selection, { storage = browserStorage(), now = new Date() } = {}) {
  const current = loadBehaviorHistory({ storage });
  const next = appendHistoryItem(current, 'recentSelections', {
    timestamp: nowIso(now),
    venueId: selection.venueId ?? null,
    venue: selection.venue ?? null,
    court: selection.court ?? null,
    startTime: selection.startTime ?? null,
    durationMinutes: selection.durationMinutes ?? null,
  });
  return saveBehaviorHistory(next, { storage });
}

function recordBookingClick(click, { storage = browserStorage(), now = new Date() } = {}) {
  const current = loadBehaviorHistory({ storage });
  const next = appendHistoryItem(current, 'recentBookingClicks', {
    timestamp: nowIso(now),
    venueId: click.venueId ?? null,
    venue: click.venue ?? null,
    court: click.court ?? null,
    startTime: click.startTime ?? null,
    durationMinutes: click.durationMinutes ?? null,
    bookingProvider: click.bookingProvider ?? null,
  });
  return saveBehaviorHistory(next, { storage });
}

function clearBehaviorHistory({ storage = browserStorage() } = {}) {
  if (!storageAvailable(storage)) return false;
  storage.removeItem(LOCAL_BEHAVIOR_STORAGE_KEY);
  return true;
}

function localTimeFromStartTime(startTime) {
  const match = /T(\d{2}:\d{2})/.exec(String(startTime ?? ''));
  return match?.[1] ?? null;
}

function timeBucket(localTime) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(localTime ?? ''));
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < 12 * 60) return 'morning';
  if (minutes < 17 * 60) return 'daytime';
  return 'evening';
}

function summarizeBehavior(behavior = {}) {
  const normalized = normalizeBehavior(behavior);
  const bookingClicks = normalized.recentBookingClicks;
  const selections = normalized.recentSelections;
  const searches = normalized.recentSearches;
  const temporalRows = [...bookingClicks, ...selections]
    .map((item) => ({
      startTime: item.startTime ?? null,
      localTime: item.localTime ?? localTimeFromStartTime(item.startTime),
      evidenceType: bookingClicks.includes(item) ? 'booking_click' : 'selection',
    }))
    .filter((item) => item.localTime);
  const timeBuckets = { morning: 0, daytime: 0, evening: 0 };
  for (const row of temporalRows) {
    const bucket = timeBucket(row.localTime);
    if (bucket) timeBuckets[bucket] += 1;
  }
  const dominantTimeBucket = Object.entries(timeBuckets)
    .sort((a, b) => b[1] - a[1])
    .find(([, count]) => count > 0)?.[0] ?? null;
  const totalTemporal = temporalRows.length;
  const dominantCount = dominantTimeBucket ? timeBuckets[dominantTimeBucket] : 0;

  return {
    bookingClickCount: bookingClicks.length,
    selectionCount: selections.length,
    searchCount: searches.length,
    timeBuckets,
    recentStartTimes: temporalRows.slice(0, 10).map((item) => item.localTime),
    dominantTimeBucket,
    confidence: dominantCount >= 3 && dominantCount / Math.max(totalTemporal, 1) >= 0.6
      ? 'high'
      : dominantCount >= 2 ? 'medium' : 'low',
    recentBookingClicks: bookingClicks.slice(0, 10).map((item) => ({
      startTime: item.startTime ?? null,
      localTime: item.localTime ?? localTimeFromStartTime(item.startTime),
      venue: item.venue ?? null,
      court: item.court ?? null,
    })),
    recentSelections: selections.slice(0, 10).map((item) => ({
      startTime: item.startTime ?? null,
      localTime: item.localTime ?? localTimeFromStartTime(item.startTime),
      venue: item.venue ?? null,
      court: item.court ?? null,
    })),
  };
}

export {
  LOCAL_BEHAVIOR_STORAGE_KEY,
  LOCAL_BEHAVIOR_STORAGE_VERSION,
  MAX_HISTORY_ITEMS,
  clearBehaviorHistory,
  loadBehaviorHistory,
  recordBookingClick,
  recordSearch,
  recordSelection,
  saveBehaviorHistory,
  summarizeBehavior,
};
