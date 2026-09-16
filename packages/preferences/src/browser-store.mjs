import {
  PREFERENCE_VERSION,
  normalizePreferenceProfile,
  validatePreferenceProfile,
} from './schema.mjs';

const LOCAL_PROFILE_STORAGE_KEY = 'findmycourt.profile.v1';
const LOCAL_PROFILE_STORAGE_VERSION = 1;

const persistentFeatures = new Set([
  'price',
  'next_hour_free',
  'start_time',
  'court',
  'venue',
  'area',
  'surface',
  'travel_time',
  'weather',
  'duration',
  'consecutive_availability',
]);

const sessionOnlyFeatures = new Set(['date', 'court_count', 'adjacency']);

const sessionTextPattern = new RegExp([
  'today',
  'tomorrow',
  'this\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)',
  'this\\s+week',
  'weekend',
  '\\d{4}-\\d{2}-\\d{2}',
  '今天',
  '明天',
  '这周',
  '本周',
  '周末',
  '星期[一二三四五六日天]',
  '周[一二三四五六日天]',
].join('|'), 'i');

class PreferenceBrowserStoreError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'PreferenceBrowserStoreError';
    this.code = code;
  }
}

function storageAvailable(storage) {
  if (!storage) return false;
  try {
    const probeKey = `${LOCAL_PROFILE_STORAGE_KEY}.probe`;
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

function createDefaultPreferenceProfile({ now = new Date() } = {}) {
  return normalizePreferenceProfile({
    version: PREFERENCE_VERSION,
    searchWindowDays: 7,
    searchScope: {
      days: 7,
      sourceText: '',
      source: 'default',
      isExplicit: false,
    },
    transportPreference: {},
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
    sourceText: '',
    updatedAt: now.toISOString(),
  }, {
    sourceText: '',
    updatedAt: now.toISOString(),
  });
}

function normalizeInputProfile(profile, { now = new Date() } = {}) {
  return validatePreferenceProfile(normalizePreferenceProfile(profile ?? createDefaultPreferenceProfile({ now }), {
    sourceText: profile?.sourceText ?? '',
    updatedAt: profile?.updatedAt ?? now.toISOString(),
  }));
}

function itemSourceText(item = {}) {
  return [item.sourceText, item.value, item.rule?.dateRange?.sourceText].filter(Boolean).join(' ');
}

function deterministicPersistence(item = {}) {
  if (item.persistence === 'persistent' && !sessionOnlyFeatures.has(item.feature) && !sessionTextPattern.test(itemSourceText(item))) {
    return 'persistent';
  }
  if (sessionOnlyFeatures.has(item.feature)) return 'session';
  if (!persistentFeatures.has(item.feature)) return 'session';
  if (sessionTextPattern.test(itemSourceText(item))) return 'session';
  return 'persistent';
}

function withPersistence(item = {}) {
  return {
    ...item,
    persistence: deterministicPersistence(item),
  };
}

function persistentItems(items = []) {
  return items.map(withPersistence).filter((item) => item.persistence === 'persistent');
}

function stripSessionFields(profile, { now = new Date() } = {}) {
  const normalized = normalizeInputProfile(profile, { now });
  return normalizeInputProfile({
    ...normalized,
    searchScope: {
      days: normalized.searchScope.days ?? 7,
      sourceText: '',
      source: 'default',
      isExplicit: false,
    },
    preferences: persistentItems(normalized.preferences),
    hardConstraints: persistentItems(normalized.hardConstraints),
    objectives: normalized.objectives.filter((objective) => {
      const text = [objective.sourceText].filter(Boolean).join(' ');
      return !sessionTextPattern.test(text);
    }),
    unresolvedPreferences: [],
    sourceText: normalized.sourceText,
  }, { now });
}

function normalizeUserProfileFields(fields = {}) {
  return {
    preferredDays: Array.isArray(fields.preferredDays) ? fields.preferredDays.filter((item) => typeof item === 'string') : [],
    preferredTimeWindows: Array.isArray(fields.preferredTimeWindows)
      ? fields.preferredTimeWindows
        .filter((window) => typeof window?.start === 'string' && typeof window?.end === 'string')
        .map((window) => ({ start: window.start, end: window.end }))
      : [],
    typicalDurationMinutes: Number.isFinite(Number(fields.typicalDurationMinutes))
      ? Number(fields.typicalDurationMinutes)
      : Number.isFinite(Number(fields.preferredDurationMinutes)) ? Number(fields.preferredDurationMinutes) : null,
    maxTravelMinutes: Number.isFinite(Number(fields.maxTravelMinutes)) ? Number(fields.maxTravelMinutes) : null,
    preferredVenues: Array.isArray(fields.preferredVenues) ? fields.preferredVenues.filter((item) => typeof item === 'string') : [],
  };
}

function envelopeForProfile(profile, userProfile = null) {
  return {
    storageVersion: LOCAL_PROFILE_STORAGE_VERSION,
    profileVersion: PREFERENCE_VERSION,
    profile,
    ...(userProfile ? { userProfile: normalizeUserProfileFields(userProfile) } : {}),
  };
}

function parseEnvelope(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PreferenceBrowserStoreError('PROFILE_JSON_CORRUPTED', 'Saved profile JSON is corrupted', { cause: error });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.storageVersion !== LOCAL_PROFILE_STORAGE_VERSION || parsed.profileVersion !== PREFERENCE_VERSION) {
    throw new PreferenceBrowserStoreError('PROFILE_VERSION_INCOMPATIBLE', 'Saved profile version is not compatible');
  }
  if (!parsed.profile || typeof parsed.profile !== 'object') return null;
  return parsed.profile;
}

function loadProfile({ storage = browserStorage(), now = new Date() } = {}) {
  if (!storageAvailable(storage)) return null;
  const raw = storage.getItem(LOCAL_PROFILE_STORAGE_KEY);
  const profile = parseEnvelope(raw);
  if (!profile) return null;
  return stripSessionFields(profile, { now });
}

function loadUserProfileFields({ storage = browserStorage(), now = new Date() } = {}) {
  if (!storageAvailable(storage)) return null;
  const raw = storage.getItem(LOCAL_PROFILE_STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) : null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.userProfile) return normalizeUserProfileFields(parsed.userProfile);
  const profile = parseEnvelope(raw);
  if (!profile) return null;
  return normalizeUserProfileFields(persistentFieldsFromProfile(profile, { now }));
}

function saveProfile(profile, { storage = browserStorage(), now = new Date() } = {}) {
  if (!storageAvailable(storage)) {
    throw new PreferenceBrowserStoreError('LOCAL_STORAGE_UNAVAILABLE', 'localStorage is not available');
  }
  const persistentProfile = stripSessionFields(profile, { now });
  storage.setItem(LOCAL_PROFILE_STORAGE_KEY, JSON.stringify(envelopeForProfile(persistentProfile)));
  return persistentProfile;
}

function saveUserProfileFields(fields, { storage = browserStorage(), now = new Date() } = {}) {
  if (!storageAvailable(storage)) {
    throw new PreferenceBrowserStoreError('LOCAL_STORAGE_UNAVAILABLE', 'localStorage is not available');
  }
  const userProfile = normalizeUserProfileFields(fields);
  const existing = loadProfile({ storage, now }) ?? createDefaultPreferenceProfile({ now });
  storage.setItem(LOCAL_PROFILE_STORAGE_KEY, JSON.stringify(envelopeForProfile(existing, userProfile)));
  return userProfile;
}

function clearProfile({ storage = browserStorage() } = {}) {
  if (!storageAvailable(storage)) return false;
  storage.removeItem(LOCAL_PROFILE_STORAGE_KEY);
  return true;
}

function explicitSearchScope(searchScope = {}) {
  return searchScope.isExplicit === true
    || Boolean(searchScope.dateRange)
    || Boolean(searchScope.timeWindow)
    || typeof searchScope.location === 'string';
}

function featureKey(item) {
  return item.feature;
}

function mergeItemLists(persistentItemsList = [], currentItemsList = []) {
  const currentKeys = new Set(currentItemsList.map(featureKey));
  return [
    ...persistentItemsList.filter((item) => !currentKeys.has(featureKey(item))),
    ...currentItemsList,
  ];
}

function mergeSearchScope(persistentScope = {}, currentScope = {}) {
  if (!explicitSearchScope(currentScope)) return persistentScope;
  return {
    ...persistentScope,
    ...currentScope,
    days: currentScope.days ?? persistentScope.days ?? 7,
  };
}

function mergeProfiles({
  persistentProfile,
  currentRequestProfile,
  now = new Date(),
} = {}) {
  const defaults = createDefaultPreferenceProfile({ now });
  const persistent = persistentProfile ? normalizeInputProfile(persistentProfile, { now }) : defaults;
  const current = currentRequestProfile ? normalizeInputProfile(currentRequestProfile, { now }) : defaults;

  return normalizeInputProfile({
    ...defaults,
    ...persistent,
    searchScope: mergeSearchScope(persistent.searchScope, current.searchScope),
    transportPreference: {
      ...persistent.transportPreference,
      ...current.transportPreference,
    },
    weatherPreference: current.weatherPreference?.source === 'user'
      ? current.weatherPreference
      : persistent.weatherPreference,
    preferences: mergeItemLists(persistent.preferences, current.preferences).map(withPersistence),
    hardConstraints: mergeItemLists(persistent.hardConstraints, current.hardConstraints).map(withPersistence),
    objectives: mergeItemLists(persistent.objectives, current.objectives),
    unresolvedPreferences: current.unresolvedPreferences?.length
      ? current.unresolvedPreferences
      : persistent.unresolvedPreferences,
    sourceText: current.sourceText || persistent.sourceText || '',
    updatedAt: now.toISOString(),
  }, { now });
}

function updateProfile(currentRequestProfile, { storage = browserStorage(), now = new Date() } = {}) {
  const persistentProfile = loadProfile({ storage, now });
  const merged = mergeProfiles({
    persistentProfile,
    currentRequestProfile,
    now,
  });
  const persistentUpdate = mergeProfiles({
    persistentProfile,
    currentRequestProfile: currentRequestProfile ? stripSessionFields(currentRequestProfile, { now }) : null,
    now,
  });
  saveProfile(persistentUpdate, { storage, now });
  return merged;
}

function valuesFromListRule(profile, feature, key) {
  const items = [...profile.preferences, ...profile.hardConstraints].filter((item) => item.feature === feature);
  return [...new Set(items.flatMap((item) => item.rule?.[key] ?? item.rule?.values ?? []))];
}

function timeWindowsFromProfile(profile) {
  return [...profile.preferences, ...profile.hardConstraints]
    .filter((item) => item.feature === 'start_time' && item.rule)
    .map((item) => item.rule);
}

function preferredDurationFromProfile(profile) {
  const duration = [...profile.preferences, ...profile.hardConstraints]
    .find((item) => item.feature === 'duration' && item.rule);
  return duration?.rule?.exactMinutes ?? duration?.rule?.preferredMinutes ?? duration?.rule?.minMinutes ?? null;
}

function priceSensitivityFromProfile(profile) {
  if (profile.objectives.some((objective) => objective.feature === 'price' && objective.direction === 'minimize')) return 'high';
  const price = profile.preferences.find((item) => item.feature === 'price');
  return price?.importance ?? null;
}

function persistentFieldsFromProfile(profile, { now = new Date() } = {}) {
  const normalized = stripSessionFields(profile, { now });
  return {
    preferredDays: [],
    preferredAreas: valuesFromListRule(normalized, 'area', 'include'),
    preferredCourts: valuesFromListRule(normalized, 'court', 'include'),
    preferredVenues: valuesFromListRule(normalized, 'venue', 'include'),
    avoidedCourts: valuesFromListRule(normalized, 'court', 'exclude'),
    preferredSurfaces: valuesFromListRule(normalized, 'surface', 'include'),
    priceSensitivity: priceSensitivityFromProfile(normalized),
    preferredTimeWindows: timeWindowsFromProfile(normalized),
    typicalDurationMinutes: preferredDurationFromProfile(normalized),
    preferredDurationMinutes: preferredDurationFromProfile(normalized),
    maxTravelMinutes: normalized.transportPreference?.maxTransitMinutes
      ?? normalized.transportPreference?.maxWalkMinutes
      ?? null,
  };
}

function listPreference(feature, rule, { importance = 'medium', sourceText = '', persistence = 'persistent' } = {}) {
  return {
    feature,
    type: 'soft',
    importance,
    priority: importance,
    relaxable: true,
    rule,
    sourceText,
    source: 'user',
    isExplicit: true,
    persistence,
  };
}

function profileFromPersistentFields(fields = {}, { now = new Date() } = {}) {
  const preferences = [];
  if (fields.preferredAreas?.length) preferences.push(listPreference('area', { include: fields.preferredAreas }, { sourceText: 'preferred areas' }));
  if (fields.preferredVenues?.length) preferences.push(listPreference('venue', { include: fields.preferredVenues }, { sourceText: 'preferred venues' }));
  if (fields.preferredCourts?.length || fields.avoidedCourts?.length) {
    preferences.push(listPreference('court', {
      ...(fields.preferredCourts?.length ? { include: fields.preferredCourts } : {}),
      ...(fields.avoidedCourts?.length ? { exclude: fields.avoidedCourts } : {}),
    }, { sourceText: 'court preferences' }));
  }
  if (fields.preferredSurfaces?.length) preferences.push(listPreference('surface', { include: fields.preferredSurfaces }, { sourceText: 'preferred surfaces' }));
  if (fields.priceSensitivity) {
    preferences.push({
      feature: 'price',
      type: 'soft',
      importance: fields.priceSensitivity,
      priority: fields.priceSensitivity,
      relaxable: true,
      direction: 'lower',
      sourceText: 'price sensitivity',
      source: 'user',
      isExplicit: true,
      persistence: 'persistent',
    });
  }
  for (const window of fields.preferredTimeWindows ?? []) {
    preferences.push(listPreference('start_time', window, { sourceText: 'preferred time window' }));
  }
  const preferredDuration = fields.typicalDurationMinutes ?? fields.preferredDurationMinutes;
  if (preferredDuration) {
    preferences.push(listPreference('duration', {
      exactMinutes: Number(preferredDuration),
    }, { sourceText: 'preferred duration' }));
  }

  return normalizeInputProfile({
    version: PREFERENCE_VERSION,
    searchWindowDays: 7,
    searchScope: {
      days: 7,
      sourceText: '',
      source: 'default',
      isExplicit: false,
    },
    transportPreference: fields.maxTravelMinutes ? {
      maxTransitMinutes: Number(fields.maxTravelMinutes),
    } : {},
    preferences,
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
    sourceText: '',
    updatedAt: now.toISOString(),
  }, { now });
}

export {
  LOCAL_PROFILE_STORAGE_KEY,
  LOCAL_PROFILE_STORAGE_VERSION,
  PreferenceBrowserStoreError,
  clearProfile,
  createDefaultPreferenceProfile,
  deterministicPersistence,
  loadUserProfileFields,
  loadProfile,
  mergeProfiles,
  persistentFieldsFromProfile,
  profileFromPersistentFields,
  saveUserProfileFields,
  saveProfile,
  updateProfile,
};
