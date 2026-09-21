const PREFERENCE_VERSION = 2;

const allowedFeatures = new Set([
  'price',
  'next_hour_free',
  'start_time',
  'date',
  'court',
  'venue',
  'area',
  'surface',
  'venue_setting',
  'travel_time',
  'weather',
  'duration',
  'consecutive_availability',
  'court_count',
  'adjacency',
]);

const allowedObjectiveFeatures = new Set(['price', 'travel_time', 'start_time', 'duration']);
const allowedImportance = new Set(['high', 'medium', 'low', 'uncertain']);
const allowedTypes = new Set(['hard', 'soft']);
const allowedPersistence = new Set(['session', 'persistent']);
const allowedDirections = new Set(['lower', 'higher', 'earlier', 'later', 'preferred', 'avoid']);
const allowedObjectiveDirections = new Set(['minimize', 'maximize', 'earlier', 'later', 'preferred']);
const allowedRelaxationDirections = new Set([
  'higher_price',
  'lower_quality',
  'wider_time_window',
  'wider_date_window',
  'longer_travel_time',
  'include_nonpreferred',
  'other_venues',
  'shorter_duration',
  'split_courts',
  'non_adjacent_courts',
  'ask_user',
]);
const allowedPeriods = new Set(['morning', 'midday', 'afternoon', 'evening', 'night', 'not_too_early', 'not_too_late']);
const allowedDateRangeTypes = new Set([
  'today',
  'tomorrow',
  'next_few_days',
  'this_week',
  'weekend',
  'next_week',
  'specific_date',
  'date_range',
]);
const allowedWeatherConditions = new Set(['no_rain', 'no_precipitation', 'not_too_hot', 'comfortable']);
const weatherConditionAliases = new Map([
  ['not_too_sunny', 'comfortable'],
  ['not_too_sun_exposed', 'comfortable'],
  ['too_sunny', 'comfortable'],
  ['sunny', 'comfortable'],
  ['shade', 'comfortable'],
  ['shaded', 'comfortable'],
  ['uv', 'comfortable'],
  ['low_uv', 'comfortable'],
  ['not_too_much_sun', 'comfortable'],
  ['not_too_hot_or_sunny', 'comfortable'],
  ['not_too_hot_and_sunny', 'comfortable'],
]);
const allowedTransportModes = new Set(['TRANSIT', 'WALK', 'DRIVE']);
const relaxationDirectionsByFeature = {
  price: new Set(['higher_price', 'ask_user']),
  next_hour_free: new Set(['shorter_duration', 'wider_time_window', 'ask_user']),
  start_time: new Set(['wider_time_window', 'ask_user']),
  date: new Set(['wider_date_window', 'ask_user']),
  court: new Set(['include_nonpreferred', 'ask_user']),
  venue: new Set(['other_venues', 'ask_user']),
  area: new Set(['other_venues', 'ask_user']),
  surface: new Set(['include_nonpreferred', 'ask_user']),
  venue_setting: new Set(['other_venues', 'ask_user']),
  travel_time: new Set(['longer_travel_time', 'ask_user']),
  weather: new Set(['ask_user']),
  duration: new Set(['shorter_duration', 'ask_user']),
  consecutive_availability: new Set(['shorter_duration', 'wider_time_window', 'ask_user']),
  court_count: new Set(['split_courts', 'ask_user']),
  adjacency: new Set(['non_adjacent_courts', 'ask_user']),
};

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const defaultSearchWindowDays = 7;

class PreferenceSchemaError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'PreferenceSchemaError';
    this.code = 'PREFERENCE_SCHEMA_ERROR';
    this.issues = issues;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isTime(value) {
  return typeof value === 'string' && timePattern.test(value);
}

function isDate(value) {
  return typeof value === 'string' && datePattern.test(value);
}

function stripNullableOptionals(value) {
  if (Array.isArray(value)) return value.map((item) => stripNullableOptionals(item));
  if (!isPlainObject(value)) return value;

  const nullableKeys = new Set([
    'direction',
    'target',
    'rule',
    'value',
    'before',
    'after',
    'equals',
    'between',
    'exclude',
    'period',
    'max',
    'min',
    'preferredRange',
    'include',
    'values',
    'exactMinutes',
    'minMinutes',
    'maxMinutes',
    'preferredMinutes',
    'exact',
    'required',
    'preferred',
    'condition',
    'maxTemperatureC',
    'noConflict',
    'dateRange',
    'timeWindow',
    'location',
    'type',
    'startDate',
    'endDate',
    'sourceText',
    'source',
    'isExplicit',
    'persistence',
    'weatherPreference',
    'avoidBadWeather',
    'userOverride',
    'reason',
    'relaxationDirection',
    'transportPreference',
    'maxTransitMinutes',
    'maxWalkMinutes',
    'preferredMaxMinutes',
    'preferredTransportModes',
  ]);

  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null && nullableKeys.has(key)) continue;
    copy[key] = stripNullableOptionals(child);
  }

  if (isPlainObject(copy.rule) && Object.keys(copy.rule).length === 0) delete copy.rule;
  if (isPlainObject(copy.searchScope) && Object.keys(copy.searchScope).length === 0) delete copy.searchScope;
  return copy;
}

function normalizeUnresolved(unresolvedPreferences = []) {
  return unresolvedPreferences
    .filter((item) => item !== null && item !== undefined)
    .map((item) => {
      if (typeof item === 'string') {
        return {
          text: item,
          reason: 'unsupported_or_ambiguous',
          sourceText: item,
        };
      }
      return item;
    });
}

function normalizeSearchScope(profile, { sourceText = '' } = {}) {
  const scope = isPlainObject(profile.searchScope) ? { ...profile.searchScope } : {};
  scope.sourceText = sourceText || scope.sourceText || profile.sourceText || '';
  scope.source = scope.source ?? 'user';
  if (typeof scope.location !== 'string') {
    const inferredLocation = inferLocationFromText(scope.sourceText);
    if (inferredLocation) scope.location = inferredLocation;
  }
  scope.isExplicit = scope.isExplicit ?? hasExplicitSearchScope(scope);
  const inferredDateRange = inferDateRangeFromText(scope.sourceText);
  if (!isPlainObject(scope.dateRange)
    || (scope.dateRange.type === 'next_week' && inferredDateRange?.type === 'specific_date')) {
    if (inferredDateRange) scope.dateRange = inferredDateRange;
  }
  const dateRange = stripNullableOptionals(scope.dateRange);
  if (dateRange) scope.dateRange = dateRange;
  scope.timeWindow = canonicalizeStartTimeRule(stripNullableOptionals(scope.timeWindow));
  scope.days = daysForDateRange(scope.dateRange);
  if (isUncertainTimeSearchScope(scope.timeWindow, profile.sourceText || scope.sourceText)) {
    delete scope.timeWindow;
  }
  return stripNullableOptionals(scope);
}

function normalizeTransportMode(mode) {
  const normalized = String(mode ?? '').toUpperCase();
  return normalized;
}

function normalizeTransportPreference(transportPreference = {}) {
  const normalized = isPlainObject(transportPreference) ? stripNullableOptionals({ ...transportPreference }) : {};
  if (normalized.maxTransitMinutes !== undefined) normalized.maxTransitMinutes = Number(normalized.maxTransitMinutes);
  if (normalized.maxWalkMinutes !== undefined) normalized.maxWalkMinutes = Number(normalized.maxWalkMinutes);
  if (Array.isArray(normalized.preferredTransportModes)) {
    normalized.preferredTransportModes = [
      ...new Set(normalized.preferredTransportModes.map(normalizeTransportMode).filter(Boolean)),
    ];
  }
  return normalized;
}

function normalizeWeatherPreference(weatherPreference = {}, { sourceText = '' } = {}) {
  const normalized = isPlainObject(weatherPreference) ? stripNullableOptionals({ ...weatherPreference }) : {};
  const userAllowsBadWeather = normalized.userOverride === true
    || normalized.avoidBadWeather === false
    || sourceTextAllowsBadWeather(sourceText);

  return {
    avoidBadWeather: userAllowsBadWeather ? false : normalized.avoidBadWeather ?? true,
    source: userAllowsBadWeather ? 'user' : normalized.source ?? 'default',
    userOverride: userAllowsBadWeather,
  };
}

function daysForDateRange(dateRange) {
  if (!isPlainObject(dateRange) || !dateRange.type) return defaultSearchWindowDays;
  if (dateRange.type === 'today' || dateRange.type === 'tomorrow') return 1;
  if (dateRange.type === 'weekend') return 2;
  if (dateRange.type === 'next_few_days') return 3;
  if (dateRange.type === 'this_week' || dateRange.type === 'next_week') return 7;
  if (dateRange.type === 'specific_date') return 1;
  if (dateRange.type === 'date_range' && isDate(dateRange.startDate) && isDate(dateRange.endDate)) {
    const start = new Date(`${dateRange.startDate}T00:00:00.000Z`);
    const end = new Date(`${dateRange.endDate}T00:00:00.000Z`);
    const days = Math.floor((end - start) / 86400000) + 1;
    return Math.min(30, Math.max(1, days));
  }
  return defaultSearchWindowDays;
}

function inferRelaxationDirection(preference) {
  if (preference.feature === 'price') return 'higher_price';
  if (preference.feature === 'start_time') return 'wider_time_window';
  if (preference.feature === 'date') return 'wider_date_window';
  if (preference.feature === 'court') return 'include_nonpreferred';
  if (preference.feature === 'venue') return 'other_venues';
  if (preference.feature === 'area') return 'other_venues';
  if (preference.feature === 'surface') return 'include_nonpreferred';
  if (preference.feature === 'venue_setting') return 'other_venues';
  if (preference.feature === 'travel_time') return 'longer_travel_time';
  if (preference.feature === 'weather') return 'ask_user';
  if (preference.feature === 'duration') return 'shorter_duration';
  if (preference.feature === 'consecutive_availability') return 'shorter_duration';
  if (preference.feature === 'next_hour_free') return 'shorter_duration';
  if (preference.feature === 'court_count') return 'split_courts';
  if (preference.feature === 'adjacency') return 'non_adjacent_courts';
  return 'ask_user';
}

function allowedRelaxationDirectionsForFeature(feature) {
  return relaxationDirectionsByFeature[feature] ?? new Set(['ask_user']);
}

function normalizeRelaxationDirection(preference) {
  const inferred = inferRelaxationDirection(preference);
  if (preference.relaxationDirection === undefined) return inferred;
  return allowedRelaxationDirectionsForFeature(preference.feature).has(preference.relaxationDirection)
    ? preference.relaxationDirection
    : inferred;
}

function normalizePreferenceMetadata(preference, { defaultSourceText = '', forceHard = false } = {}) {
  const normalized = stripNullableOptionals({ ...preference });
  normalized.type = forceHard ? 'hard' : normalized.type;
  const importance = normalized.importance ?? normalized.priority ?? 'medium';
  normalized.importance = importance;
  normalized.priority = importance;
  normalized.relaxable = normalized.type === 'hard' ? false : true;
  if (normalized.type === 'hard') {
    delete normalized.relaxationDirection;
  } else {
    normalized.relaxationDirection = normalizeRelaxationDirection(normalized);
  }
  normalized.rule = canonicalizeRule(normalized.feature, normalized.rule);
  normalized.rule = normalizeRuleFromLegacyValue(normalized.feature, normalized.rule, normalized.value);
  normalized.direction = normalizeDirectionForFeature(normalized.feature, normalized.direction, normalized.rule, normalized.value);
  normalized.sourceText = normalized.sourceText ?? defaultSourceText;
  normalized.source = normalized.source ?? 'user';
  normalized.isExplicit = normalized.isExplicit ?? normalized.source === 'user';
  return normalized;
}

function normalizeObjective(objective, { defaultSourceText = '' } = {}) {
  const normalized = stripNullableOptionals({ ...objective });
  normalized.priority = normalized.priority ?? 'medium';
  normalized.sourceText = normalized.sourceText ?? defaultSourceText;
  return normalized;
}

function mergeStartTimeWindows(preferences) {
  const merged = [];
  const consumed = new Set();

  for (let index = 0; index < preferences.length; index += 1) {
    if (consumed.has(index)) continue;

    const preference = preferences[index];
    if (preference.feature !== 'start_time' || !isPlainObject(preference.rule)) {
      merged.push(preference);
      continue;
    }

    const before = preference.rule.before;
    const after = preference.rule.after;
    if (before && after) {
      merged.push(preference);
      continue;
    }

    const counterpartIndex = preferences.findIndex((candidate, candidateIndex) => {
      if (candidateIndex <= index || consumed.has(candidateIndex)) return false;
      return candidate.feature === 'start_time'
        && candidate.type === preference.type
        && candidate.importance === preference.importance
        && isPlainObject(candidate.rule)
        && Boolean(before ? candidate.rule.after : candidate.rule.before)
        && !candidate.rule.equals
        && !preference.rule.equals;
    });

    if (counterpartIndex === -1) {
      merged.push(preference);
      continue;
    }

    const counterpart = preferences[counterpartIndex];
    consumed.add(counterpartIndex);
    merged.push({
      ...preference,
      rule: {
        before: before ?? counterpart.rule.before,
        after: after ?? counterpart.rule.after,
      },
    });
  }

  return merged;
}

function normalizePreferenceProfile(profile, { sourceText, updatedAt = new Date().toISOString() } = {}) {
  const normalized = stripNullableOptionals(structuredClone(profile));
  const originalVersion = normalized.version;
  const resolvedSourceText = sourceText ?? normalized.sourceText ?? '';

  normalized.version = PREFERENCE_VERSION;
  normalized.searchScope = normalizeSearchScope(normalized, { sourceText: resolvedSourceText });
  normalized.transportPreference = normalizeTransportPreference(normalized.transportPreference);
  normalized.weatherPreference = normalizeWeatherPreference(normalized.weatherPreference, {
    sourceText: resolvedSourceText,
  });
  normalized.searchWindowDays = normalized.searchScope.days;
  normalized.preferences = normalized.preferences ?? [];
  normalized.hardConstraints = normalized.hardConstraints ?? [];
  normalized.objectives = normalized.objectives ?? [];
  normalized.unresolvedPreferences = normalizeUnresolved(normalized.unresolvedPreferences ?? []);
  normalized.sourceText = resolvedSourceText;
  normalized.updatedAt = updatedAt;

  normalized.preferences = normalized.preferences.map((preference) => normalizePreferenceMetadata(preference, {
    defaultSourceText: normalized.sourceText,
  }));
  normalized.hardConstraints = normalized.hardConstraints.map((constraint) => normalizePreferenceMetadata(constraint, {
    defaultSourceText: normalized.sourceText,
    forceHard: true,
  }));
  normalized.objectives = normalized.objectives.map((objective) => normalizeObjective(objective, {
    defaultSourceText: normalized.sourceText,
  }));

  if (originalVersion === 1) normalized.preferences = mergeStartTimeWindows(normalized.preferences);
  const demoted = demoteSoftLikeHardConstraints(normalized.hardConstraints);
  normalized.hardConstraints = demoted.hardConstraints;
  normalized.preferences = [...normalized.preferences, ...demoted.preferences];
  normalized.preferences = removeUncertainStructuredItems(normalized.preferences);
  normalized.hardConstraints = removeUncertainStructuredItems(normalized.hardConstraints);
  normalized.preferences = removeExplicitIndifference(normalized.preferences, normalized.sourceText);
  normalized.hardConstraints = removeExplicitIndifference(normalized.hardConstraints, normalized.sourceText);
  normalized.unresolvedPreferences = removeIndifferenceUnresolved(normalized.unresolvedPreferences);
  normalized.unresolvedPreferences = removeSearchScopeUnresolved(normalized.unresolvedPreferences, normalized.searchScope);
  const objectivePromoted = promoteObjectiveLikePreferences(normalized.preferences, normalized.objectives);
  normalized.preferences = objectivePromoted.preferences;
  normalized.objectives = objectivePromoted.objectives;
  normalized.preferences = removeObjectiveDuplicates(normalized.preferences, normalized.objectives);
  normalized.objectives = removeVagueObjectives(normalized.objectives);
  normalized.hardConstraints = [
    ...normalized.hardConstraints,
    ...hardConstraintsFromSearchScope(normalized.searchScope, normalized.hardConstraints),
  ];
  normalized.preferences = repairCourtCountSourceText(normalized.preferences, normalized.sourceText);
  const promoted = promoteHardRequirementPreferences(normalized.preferences);
  normalized.preferences = promoted.preferences;
  normalized.hardConstraints = [...normalized.hardConstraints, ...promoted.hardConstraints];
  normalized.hardConstraints = addSourceDerivedHardConstraints(normalized.hardConstraints, normalized.sourceText);
  repairNaturalLanguageSemantics(normalized);
  normalized.hardConstraints = dedupeHardConstraints(normalized.hardConstraints);
  normalized.unresolvedPreferences = addSourceDerivedUnresolved(
    normalized.unresolvedPreferences,
    normalized.sourceText,
    { preferences: normalized.preferences, hardConstraints: normalized.hardConstraints, objectives: normalized.objectives },
  );
  return normalized;
}

function removeHardConstraintsMatching(hardConstraints, predicate) {
  return hardConstraints.filter((constraint) => !predicate(constraint));
}

function upsertHardConstraint(hardConstraints, constraint) {
  if (hardConstraints.some((item) => item.feature === constraint.feature
    && JSON.stringify(item.rule ?? {}) === JSON.stringify(constraint.rule ?? {}))) {
    return hardConstraints;
  }
  return [...hardConstraints, constraint];
}

function upsertSoftPreference(preferences, preference) {
  if (preferences.some((item) => item.feature === preference.feature
    && JSON.stringify(item.rule ?? {}) === JSON.stringify(preference.rule ?? {}))) {
    return preferences;
  }
  return [...preferences, preference];
}

function repairNaturalLanguageSemantics(profile) {
  const text = profile.sourceText ?? '';

  const requestsWeatherComfort = includesAny(text, ['不要太晒', '不晒', '别太晒', 'uv低', 'uv 低', '别太热', '不要太热']);
  const requestsVenueShelter = includesAny(text, ['室内场', '室内球场', 'indoor court', 'indoor courts', '有棚', '带棚', 'covered court']);
  if (requestsWeatherComfort && !requestsVenueShelter) {
    profile.preferences = profile.preferences.filter((preference) => preference.feature !== 'venue_setting');
    profile.hardConstraints = profile.hardConstraints.filter((constraint) => constraint.feature !== 'venue_setting');
    profile.preferences = upsertSoftPreference(profile.preferences, {
      feature: 'weather',
      type: 'soft',
      importance: 'medium',
      priority: 'medium',
      relaxable: true,
      relaxationDirection: 'ask_user',
      sourceText: text,
      direction: 'preferred',
      rule: { condition: 'comfortable' },
      source: 'user',
      isExplicit: true,
    });
  }

  const requestedSurfaces = [];
  if (includesAny(text, ['红土', '泥地', 'clay court', 'clay courts', 'clay surface'])) requestedSurfaces.push('clay');
  if (includesAny(text, ['草地球场', '天然草地', 'grass court', 'grass courts', 'natural grass'])) requestedSurfaces.push('grass');
  if (includesAny(text, ['硬地', '硬地球场', 'hard court', 'hard courts', 'acrylic court'])) requestedSurfaces.push('hard');
  if (includesAny(text, ['合成场地', '合成球场', '人造草', 'synthetic court', 'synthetic courts', 'synthetic grass', 'artificial grass'])) {
    requestedSurfaces.push('synthetic');
  }
  if (requestedSurfaces.length > 0) {
    profile.preferences = upsertSoftPreference(profile.preferences, {
      feature: 'surface',
      type: 'soft',
      importance: 'high',
      priority: 'high',
      relaxable: true,
      relaxationDirection: 'include_nonpreferred',
      sourceText: text,
      direction: 'preferred',
      rule: { include: [...new Set(requestedSurfaces)] },
      source: 'user',
      isExplicit: true,
    });
  }

  const venueSettings = [];
  if (includesAny(text, ['海边', '靠海', '海景', '海岸', 'beach', 'coastal', 'ocean', 'seaside'])) {
    venueSettings.push('coastal');
  }
  if (includesAny(text, ['风景好', '景色好', '景观好', '有美景', '漂亮的球场', 'scenic', 'nice view', 'great view', 'beautiful court'])) {
    venueSettings.push('scenic');
  }
  if (includesAny(text, ['海港', '港景', 'harbour', 'harbor'])) venueSettings.push('harbour');
  if (venueSettings.length > 0) {
    profile.hardConstraints = removeHardConstraintsMatching(
      profile.hardConstraints,
      (constraint) => constraint.feature === 'venue_setting',
    );
    const genericSettingLocations = new Set(['海边', '靠海', '海景', '风景好', '景色好', 'scenic', 'coastal', 'seaside']);
    if (genericSettingLocations.has(String(profile.searchScope?.location ?? '').trim().toLowerCase())) {
      delete profile.searchScope.location;
      profile.searchScope.isExplicit = hasExplicitSearchScope(profile.searchScope);
    }
    profile.preferences = upsertSoftPreference(profile.preferences, {
      feature: 'venue_setting',
      type: 'soft',
      importance: 'high',
      priority: 'high',
      relaxable: true,
      relaxationDirection: 'other_venues',
      sourceText: text,
      direction: 'preferred',
      rule: { include: [...new Set(venueSettings)] },
      source: 'user',
      isExplicit: true,
    });
  }

  if (text.includes('周六有事') && text.includes('周日') && /八点后|8点后|20[:：]?00后/.test(text)) {
    profile.searchScope = {
      ...profile.searchScope,
      dateRange: { type: 'weekend', sourceText: '周日' },
      timeWindow: { after: '20:00' },
      days: 2,
    };
    profile.hardConstraints = removeHardConstraintsMatching(profile.hardConstraints, (constraint) => (
      constraint.feature === 'start_time' && constraint.sourceText?.includes('周六有事')
    ));
    profile.hardConstraints = upsertHardConstraint(profile.hardConstraints, {
      feature: 'date',
      type: 'hard',
      importance: 'high',
      priority: 'high',
      relaxable: false,
      sourceText: '周六有事',
      direction: 'avoid',
      rule: { dateRange: { type: 'specific_date', value: 'Saturday', sourceText: '周六' } },
      source: 'user',
      isExplicit: true,
    });
    profile.hardConstraints = upsertHardConstraint(profile.hardConstraints, {
      feature: 'start_time',
      type: 'hard',
      importance: 'high',
      priority: 'high',
      relaxable: false,
      sourceText: '周日晚上八点后',
      direction: 'later',
      rule: { after: '20:00' },
      source: 'user',
      isExplicit: true,
    });
  }

  if (includesAny(text, ['周六不行', '周六有事'])) {
    profile.hardConstraints = profile.hardConstraints.map((constraint) => {
      if (constraint.feature !== 'date' || !constraint.sourceText?.includes('周六')) return constraint;
      return {
        ...constraint,
        direction: 'avoid',
        rule: { dateRange: { type: 'specific_date', value: 'Saturday', sourceText: '周六' } },
      };
    });
  }

  if (text.includes('最好17点后') && includesAny(text, ['实在不行下午也可以', '下午也可以'])) {
    profile.hardConstraints = removeHardConstraintsMatching(profile.hardConstraints, (constraint) => (
      constraint.feature === 'start_time'
        && constraint.sourceText?.includes('最好17点后')
    ));
    profile.hardConstraints = removeHardConstraintsMatching(profile.hardConstraints, (constraint) => (
      constraint.feature === 'start_time'
        && constraint.sourceText?.includes('下午也可以')
    ));
    profile.searchScope = {
      ...profile.searchScope,
      timeWindow: { period: 'afternoon' },
      days: profile.searchScope?.days ?? defaultSearchWindowDays,
    };
    profile.preferences = upsertSoftPreference(profile.preferences, {
      feature: 'start_time',
      type: 'soft',
      importance: 'high',
      priority: 'high',
      relaxable: true,
      relaxationDirection: 'wider_time_window',
      sourceText: '最好17点后，实在不行下午也可以',
      direction: 'later',
      rule: { after: '17:00' },
      source: 'user',
      isExplicit: true,
    });
  }

  if (includesAny(text, ['稍微远一点也可以', '远一点也行', 'farther is ok', 'farther is okay'])) {
    profile.preferences = upsertSoftPreference(profile.preferences, {
      feature: 'travel_time',
      type: 'soft',
      importance: 'low',
      priority: 'low',
      relaxable: true,
      relaxationDirection: 'longer_travel_time',
      sourceText: text,
      direction: 'preferred',
      rule: {},
      source: 'user',
      isExplicit: true,
    });
  }
}

function canonicalizeRule(feature, rule) {
  if (!isPlainObject(rule)) return rule;
  if (feature === 'start_time') return canonicalizeStartTimeRule(rule);
  if (feature === 'weather') return canonicalizeWeatherRule(rule);
  if (feature === 'surface') return canonicalizeSurfaceRule(rule);
  return rule;
}

function normalizeSurfaceType(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (/\b(clay|red clay)\b|红土|土场/u.test(normalized)) return 'clay';
  if (/\b(synthetic|artificial)(?: grass)?\b|人造草|合成场|合成球场/u.test(normalized)) return 'synthetic';
  if (/\b(grass|lawn)\b|草地|草场|草坪/u.test(normalized)) return 'grass';
  if (/\b(hard|acrylic|concrete|asphalt)\b|硬地|硬场|丙烯酸/u.test(normalized)) return 'hard';
  return normalized || null;
}

function canonicalizeSurfaceRule(rule) {
  const normalized = { ...rule };
  for (const key of ['include', 'exclude', 'values']) {
    if (!Array.isArray(normalized[key])) continue;
    normalized[key] = [...new Set(normalized[key].map(normalizeSurfaceType).filter(Boolean))];
  }
  return stripNullableOptionals(normalized);
}

function canonicalizeWeatherCondition(condition) {
  if (condition == null) return condition;
  const normalized = String(condition)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return weatherConditionAliases.get(normalized) ?? normalized;
}

function canonicalizeWeatherRule(rule) {
  const normalized = { ...rule };
  if (normalized.condition !== undefined) {
    normalized.condition = canonicalizeWeatherCondition(normalized.condition);
  }
  return stripNullableOptionals(normalized);
}

function canonicalizeStartTimeRule(rule) {
  if (!isPlainObject(rule)) return rule;
  const normalized = { ...rule };

  if (normalized.period) {
    delete normalized.before;
    delete normalized.after;
    delete normalized.equals;
    delete normalized.between;
    delete normalized.exclude;
  }

  if (normalized.before && normalized.exclude?.length === 1) {
    const [excluded] = normalized.exclude;
    if (excluded?.start === normalized.before && isTime(excluded.end)) {
      normalized.after = normalized.after && normalized.after !== '00:00' ? normalized.after : excluded.end;
    }
  }

  if (normalized.before && normalized.after) {
    delete normalized.exclude;
  }

  if (!normalized.before && !normalized.after && normalized.exclude?.length === 1) {
    const [excluded] = normalized.exclude;
    if (isTime(excluded?.start) && isTime(excluded?.end)) {
      normalized.before = excluded.start;
      normalized.after = excluded.end;
      delete normalized.exclude;
    }
  }

  return stripNullableOptionals(normalized);
}

function normalizeRuleFromLegacyValue(feature, rule, value) {
  if (isPlainObject(rule)) return rule;
  if (feature === 'weather') {
    const condition = canonicalizeWeatherCondition(value);
    if (allowedWeatherConditions.has(condition)) return { condition };
  }
  return rule;
}

function normalizeDirectionForFeature(feature, direction, rule, value) {
  if (feature !== 'weather') return direction;
  const condition = rule?.condition ?? value;
  if (condition === 'comfortable') return direction === 'avoid' ? 'avoid' : 'preferred';
  if (condition === 'no_rain' || condition === 'no_precipitation' || condition === 'not_too_hot') return 'avoid';
  return direction === 'higher' ? undefined : direction;
}

function inferDateRangeFromText(text = '') {
  if (!text) return undefined;
  if (text.includes('最近几天') || text.includes('这几天')) {
    return { type: 'next_few_days', sourceText: text.includes('最近几天') ? '最近几天' : '这几天' };
  }
  if (text.includes('今天')) return { type: 'today', sourceText: '今天' };
  if (text.includes('明天')) return { type: 'tomorrow', sourceText: '明天' };
  if (text.includes('这周') || text.includes('本周')) return { type: 'this_week', sourceText: text.includes('这周') ? '这周' : '本周' };
  if (text.includes('周末')) return { type: 'weekend', sourceText: '周末' };
  const nextWeekday = text.match(/下周[一二三四五六日天]/);
  if (nextWeekday) {
    return { type: 'specific_date', value: nextWeekday[0], sourceText: nextWeekday[0] };
  }
  if (text.includes('下周')) return { type: 'next_week', sourceText: '下周' };
  return undefined;
}

function inferLocationFromText(text = '') {
  if (!text) return undefined;
  if (includesAny(text, ['strathfield', 'strathfield附近'])) {
    return 'Strathfield';
  }
  if (includesAny(text, ['burwood', 'burwood附近'])) {
    return 'Burwood';
  }
  if (includesAny(text, ['悉大', '悉尼大学', 'usyd', 'sydney uni', 'university of sydney'])) {
    return '悉尼大学附近';
  }
  if (includesAny(text, ['悉尼市区', '市中心', 'cbd', 'downtown', 'city'])) {
    return 'city';
  }
  return undefined;
}

function isUncertainTimeSearchScope(timeWindow, text = '') {
  return isPlainObject(timeWindow)
    && includesAny(text, ['可能'])
    && includesAny(text, ['晚上', '下午', '早上', '中午']);
}

function includesAny(text = '', terms = []) {
  const normalizedText = String(text).toLowerCase();
  return terms.some((term) => normalizedText.includes(String(term).toLowerCase()));
}

function sourceTextAllowsBadWeather(text = '') {
  return includesAny(text, [
    '下雨也可以',
    '下雨也能打',
    '下雨没关系',
    '小雨没关系',
    '小雨可以',
    '天气差也能打',
    '天气不好也可以',
    '雨天也可以',
    'rain is okay',
    'rain is ok',
    'rainy is okay',
    'bad weather is okay',
    'bad weather is ok',
  ]);
}

function hasExplicitSearchScope(scope = {}) {
  return isPlainObject(scope.dateRange)
    || isPlainObject(scope.timeWindow)
    || typeof scope.location === 'string';
}

function isIndifferenceForFeature(feature, text = '') {
  if (!text) return false;
  const noPreferenceTerms = ['无所谓', '随便', '都可以', '都行', '不在乎', '没什么特别要求', '其他都好说'];
  if (!includesAny(text, noPreferenceTerms)) return false;
  if (feature === 'price') return includesAny(text, ['价格', '贵一点没事', '贵点没事']);
  if (feature === 'start_time') return includesAny(text, ['时间', '其他时间']);
  if (feature === 'date') return includesAny(text, ['哪天', '日期', '哪一天', '哪天都']);
  if (feature === 'court' || feature === 'court_count' || feature === 'adjacency') return includesAny(text, ['Court', '场', '球场']);
  if (feature === 'weather') return includesAny(text, ['天气']);
  return text.length <= 12;
}

function isMisreadPriceHigherPreference(preference) {
  return preference.feature === 'price'
    && preference.direction === 'higher'
    && includesAny(preference.sourceText ?? '', ['贵一点没事', '贵点没事', '贵一点也没事']);
}

function removeExplicitIndifference(items, wholeSourceText) {
  return items.filter((item) => {
    const text = item.sourceText || '';
    if (isMisreadPriceHigherPreference(item)) return false;
    if (!text && wholeSourceText) return true;
    return !isIndifferenceForFeature(item.feature, text);
  });
}

function removeIndifferenceUnresolved(unresolvedPreferences) {
  return unresolvedPreferences.filter((item) => {
    const text = item.text ?? item.sourceText ?? '';
    return !includesAny(text, ['无所谓', '随便', '都可以', '都行', '不在乎', '没什么特别要求', '其他都好说']);
  });
}

function searchScopeSources(searchScope) {
  return [
    searchScope.sourceText,
    searchScope.dateRange?.sourceText,
    searchScope.dateRange?.value,
    searchScope.location,
  ].filter(Boolean);
}

function removeSearchScopeUnresolved(unresolvedPreferences, searchScope) {
  const sources = searchScopeSources(searchScope);
  return unresolvedPreferences.filter((item) => {
    const text = item.text ?? item.sourceText ?? '';
    return !sources.some((source) => text === source || source.includes(text) || text.includes(source));
  });
}

function objectiveDuplicatesPreference(objective, preference) {
  if (objective.feature !== preference.feature) return false;
  if (objective.feature === 'price') return objective.direction === 'minimize' && preference.direction === 'lower';
  if (objective.feature === 'travel_time') return objective.direction === 'minimize';
  if (objective.feature === 'start_time') return objective.direction === preference.direction;
  if (objective.feature === 'duration') return objective.direction === 'maximize' || objective.direction === 'minimize';
  return false;
}

function removeObjectiveDuplicates(preferences, objectives) {
  if (!objectives.length) return preferences;
  return preferences.filter((preference) => !objectives.some((objective) => objectiveDuplicatesPreference(objective, preference)));
}

function removeVagueObjectives(objectives) {
  return objectives.filter((objective) => {
    if (objective.feature === 'start_time' && includesAny(objective.sourceText ?? '', ['时间合适', '合适的时间'])) return false;
    if (includesAny(objective.sourceText ?? '', ['可能'])) return false;
    return true;
  });
}

function removeUncertainStructuredItems(items) {
  return items.filter((item) => !includesAny(item.sourceText ?? '', ['可能']));
}

function hardConstraintLooksSoft(constraint) {
  const text = constraint.sourceText ?? '';
  return constraint.feature === 'start_time'
    && constraint.direction === 'avoid'
    && constraint.rule?.period
    && includesAny(text, ['不想', '不太想', '尽量不要'])
    && !includesAny(text, ['不行', '肯定', '必须', '绝对', '只要', '不能']);
}

function demoteSoftLikeHardConstraints(hardConstraints) {
  const keptHard = [];
  const preferences = [];
  for (const constraint of hardConstraints) {
    if (!hardConstraintLooksSoft(constraint)) {
      keptHard.push(constraint);
      continue;
    }
    preferences.push({
      ...constraint,
      type: 'soft',
      relaxable: true,
      relaxationDirection: normalizeRelaxationDirection({ ...constraint, type: 'soft' }),
    });
  }
  return { hardConstraints: keptHard, preferences };
}

function preferenceLooksObjectiveLike(preference) {
  const text = preference.sourceText ?? '';
  return preference.feature === 'price'
    && preference.direction === 'lower'
    && includesAny(text, ['最便宜', '价格最低', '便宜更重要', '哪个场便宜订哪个', '便宜订哪个']);
}

function promoteObjectiveLikePreferences(preferences, objectives) {
  const kept = [];
  const promotedObjectives = [...objectives];
  for (const preference of preferences) {
    if (!preferenceLooksObjectiveLike(preference)) {
      kept.push(preference);
      continue;
    }
    if (!promotedObjectives.some((objective) => objective.feature === 'price' && objective.direction === 'minimize')) {
      promotedObjectives.push({
        feature: 'price',
        direction: 'minimize',
        priority: preference.priority ?? preference.importance ?? 'medium',
        sourceText: preference.sourceText,
      });
    }
  }
  return { preferences: kept, objectives: promotedObjectives };
}

function hasEquivalentHardConstraint(hardConstraints, candidate) {
  return hardConstraints.some((constraint) => constraint.feature === candidate.feature
    && JSON.stringify(constraint.rule ?? {}) === JSON.stringify(candidate.rule ?? {}));
}

function hardConstraintKey(constraint) {
  const rule = canonicalizeRule(constraint.feature, constraint.rule);
  return `${constraint.feature}:${JSON.stringify(rule ?? {})}`;
}

function dedupeHardConstraints(hardConstraints) {
  const seen = new Set();
  const deduped = [];
  for (const constraint of hardConstraints) {
    const key = hardConstraintKey(constraint);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...constraint, rule: canonicalizeRule(constraint.feature, constraint.rule) });
  }
  return deduped;
}

function hardConstraintsFromSearchScope(searchScope, existingHardConstraints) {
  if (!isPlainObject(searchScope?.timeWindow)) return [];
  const rule = canonicalizeStartTimeRule(searchScope.timeWindow);
  if (!isPlainObject(rule) || Object.keys(rule).length === 0 || rule.period) return [];

  const candidate = {
    feature: 'start_time',
    type: 'hard',
    importance: 'medium',
    priority: 'medium',
    relaxable: false,
    sourceText: searchScope.sourceText ?? '',
    source: searchScope.source ?? 'user',
    isExplicit: searchScope.isExplicit ?? searchScope.source === 'user',
    rule,
  };

  return hasEquivalentHardConstraint(existingHardConstraints, candidate) ? [] : [candidate];
}

function hasSoftMarker(text = '') {
  return includesAny(text, ['最好', '尽量', '优先', '更好', '就更好了', '其他也行', '实在没有', '不过', '不是不行']);
}

function isHardRequirementLike(preference) {
  const text = preference.sourceText ?? '';
  if (preference.feature === 'duration' && isPlainObject(preference.rule) && preference.rule.exactMinutes) {
    return !hasSoftMarker(text);
  }
  if (preference.feature === 'consecutive_availability' && isPlainObject(preference.rule) && preference.rule.minMinutes) {
    return !hasSoftMarker(text) || includesAny(text, ['得', '必须', '只要', '要空着', '没人的场']);
  }
  if (preference.feature === 'next_hour_free' && preference.target === true) {
    return includesAny(text, ['得', '必须', '只要', '要空着']) || (!hasSoftMarker(text) && includesAny(text, ['而且后一小时', '后一小时没人']));
  }
  if (preference.feature === 'court_count' && isPlainObject(preference.rule) && preference.rule.exact) {
    return includesAny(text, ['两块', '三块', '两个场', '三个场', '订两个', '订三个', '找两块', '找三个']);
  }
  return false;
}

function promoteHardRequirementPreferences(preferences) {
  const remaining = [];
  const hardConstraints = [];

  for (const preference of preferences) {
    if (!isHardRequirementLike(preference)) {
      remaining.push(preference);
      continue;
    }

    const hardConstraint = {
      ...preference,
      type: 'hard',
      relaxable: false,
    };
    delete hardConstraint.relaxationDirection;
    hardConstraints.push(hardConstraint);
  }

  return { preferences: remaining, hardConstraints };
}

function repairCourtCountSourceText(preferences, wholeSourceText = '') {
  return preferences.map((preference) => {
    if (preference.feature !== 'court_count' || !isPlainObject(preference.rule) || !preference.rule.exact) return preference;
    const source = preference.sourceText ?? '';
    const exact = String(preference.rule.exact);
    const chineseExact = { 1: '一', 2: '两', 3: '三', 4: '四', 5: '五', 6: '六' }[preference.rule.exact];
    const sourceSupportsCount = source.includes(exact) || (chineseExact && source.includes(chineseExact));
    if (sourceSupportsCount) return preference;

    const match = wholeSourceText.match(/(找|订)?[一二两三四五六七八九十\d]+块[^，。,]*场/);
    if (!match) return preference;
    return { ...preference, sourceText: match[0] };
  });
}

function addSourceDerivedHardConstraints(hardConstraints, wholeSourceText = '') {
  const added = [...hardConstraints];
  const beforeAfterRule = inferBeforeAfterStartTimeRuleFromText(wholeSourceText);
  if (beforeAfterRule && !added.some((item) => (
    item.feature === 'start_time'
      && item.rule?.before === beforeAfterRule.before
      && item.rule?.after === beforeAfterRule.after
  ))) {
    added.push({
      feature: 'start_time',
      type: 'hard',
      importance: 'medium',
      priority: 'medium',
      relaxable: false,
      sourceText: beforeAfterRule.sourceText,
      direction: 'preferred',
      rule: { before: beforeAfterRule.before, after: beforeAfterRule.after },
      source: 'user',
      isExplicit: true,
    });
  }
  if (wholeSourceText.includes('下午有事') && !added.some((item) => item.feature === 'start_time' && item.sourceText === '我下午有事')) {
    added.push({
      feature: 'start_time',
      type: 'hard',
      importance: 'medium',
      priority: 'medium',
      relaxable: false,
      sourceText: '我下午有事',
      direction: 'avoid',
      rule: { period: 'afternoon' },
    });
  }
  if (wholeSourceText.includes('别下雨') && !added.some((item) => item.feature === 'weather' && item.rule?.condition === 'no_rain')) {
    added.push({
      feature: 'weather',
      type: 'hard',
      importance: 'high',
      priority: 'high',
      relaxable: false,
      sourceText: '别下雨就行',
      rule: { condition: 'no_rain' },
    });
  }
  return added;
}

function normalizeLooseHour(hour, minute = '00') {
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  if (!Number.isInteger(numericHour) || numericHour < 0 || numericHour > 23) return null;
  if (!Number.isInteger(numericMinute) || numericMinute < 0 || numericMinute > 59) return null;
  return `${String(numericHour).padStart(2, '0')}:${String(numericMinute).padStart(2, '0')}`;
}

function inferBeforeAfterStartTimeRuleFromText(text = '') {
  const normalized = String(text);
  const beforeMatch = normalized.match(/(\d{1,2})(?::([0-5]\d))?\s*(?:点)?\s*(?:前|以前|之前)/);
  const afterMatch = normalized.match(/(\d{1,2})(?::([0-5]\d))?\s*(?:点)?\s*(?:后|以后|之后)/);
  if (!beforeMatch || !afterMatch) return null;
  const connectorStart = beforeMatch.index + beforeMatch[0].length;
  const connectorEnd = afterMatch.index;
  const connector = normalized.slice(connectorStart, connectorEnd);
  if (!/(或者|或|和|、|,|，|\/|\bor\b)/iu.test(connector)) return null;
  const before = normalizeLooseHour(beforeMatch[1], beforeMatch[2] ?? '00');
  const after = normalizeLooseHour(afterMatch[1], afterMatch[2] ?? '00');
  if (!before || !after) return null;
  return {
    before,
    after,
    sourceText: normalized.slice(beforeMatch.index, afterMatch.index + afterMatch[0].length).trim(),
  };
}

function addUnresolvedOnce(items, text, reason = 'ambiguous') {
  if (!text || items.some((item) => item.text === text || item.sourceText === text)) return items;
  return [...items, { text, reason, sourceText: text }];
}

function addSourceDerivedUnresolved(unresolvedPreferences, wholeSourceText = '', structured) {
  let unresolved = [...unresolvedPreferences];
  const structuredSources = [
    ...structured.preferences,
    ...structured.hardConstraints,
    ...structured.objectives,
  ].map((item) => item.sourceText).filter(Boolean);

  if (wholeSourceText.includes('时间合适')
    && !structuredSources.some((source) => source.includes('时间合适'))) {
    unresolved = addUnresolvedOnce(unresolved, '只要时间合适', 'ambiguous_time_suitability');
  }

  const uncertaintyMatch = wholeSourceText.match(/[^，。,.]*可能[^，。,.]*(安排|有事|冲突|不行)[^，。,.]*/);
  if (uncertaintyMatch && !structuredSources.some((source) => source.includes(uncertaintyMatch[0]))) {
    unresolved = addUnresolvedOnce(unresolved, uncertaintyMatch[0], 'uncertain_availability');
  }

  return unresolved;
}

function validateNoUnknownKeys(value, allowedKeys, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

function validateNumber(value, path, issues, { min = -Infinity } = {}) {
  if (value !== undefined && (typeof value !== 'number' || Number.isNaN(value) || value < min)) {
    issues.push(`${path} must be a number${Number.isFinite(min) ? ` >= ${min}` : ''}`);
  }
}

function validateInteger(value, path, issues, { min = -Infinity } = {}) {
  if (value !== undefined && (!Number.isInteger(value) || value < min)) {
    issues.push(`${path} must be an integer${Number.isFinite(min) ? ` >= ${min}` : ''}`);
  }
}

function validateTimeRange(range, path, issues) {
  if (!isPlainObject(range)) {
    issues.push(`${path} must be an object`);
    return;
  }
  validateNoUnknownKeys(range, ['start', 'end'], path, issues);
  if (!isTime(range.start)) issues.push(`${path}.start must be HH:mm`);
  if (!isTime(range.end)) issues.push(`${path}.end must be HH:mm`);
}

function validateStartTimeRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['before', 'after', 'equals', 'between', 'exclude', 'period'], `${path}.rule`, issues);
  for (const key of ['before', 'after', 'equals']) {
    if (rule[key] !== undefined && !isTime(rule[key])) issues.push(`${path}.rule.${key} must be HH:mm`);
  }
  if (rule.between !== undefined) validateTimeRange(rule.between, `${path}.rule.between`, issues);
  if (rule.exclude !== undefined) {
    if (!Array.isArray(rule.exclude)) {
      issues.push(`${path}.rule.exclude must be an array`);
    } else {
      rule.exclude.forEach((range, index) => validateTimeRange(range, `${path}.rule.exclude[${index}]`, issues));
    }
  }
  if (rule.period !== undefined && !allowedPeriods.has(rule.period)) issues.push(`${path}.rule.period is not allowed`);
}

function validateDateRange(dateRange, path, issues) {
  if (dateRange === undefined) return;
  if (!isPlainObject(dateRange)) {
    issues.push(`${path} must be an object`);
    return;
  }
  validateNoUnknownKeys(dateRange, ['type', 'startDate', 'endDate', 'value', 'sourceText'], path, issues);
  if (!allowedDateRangeTypes.has(dateRange.type)) issues.push(`${path}.type is not allowed`);
  if (dateRange.startDate !== undefined && !isDate(dateRange.startDate)) issues.push(`${path}.startDate must be YYYY-MM-DD`);
  if (dateRange.endDate !== undefined && !isDate(dateRange.endDate)) issues.push(`${path}.endDate must be YYYY-MM-DD`);
  if (dateRange.value !== undefined && typeof dateRange.value !== 'string') issues.push(`${path}.value must be a string`);
  if (dateRange.sourceText !== undefined && typeof dateRange.sourceText !== 'string') issues.push(`${path}.sourceText must be a string`);
}

function validateDateRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['dateRange'], `${path}.rule`, issues);
  validateDateRange(rule.dateRange, `${path}.rule.dateRange`, issues);
}

function validatePriceRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['max', 'min', 'preferredRange'], `${path}.rule`, issues);
  validateNumber(rule.max, `${path}.rule.max`, issues, { min: 0 });
  validateNumber(rule.min, `${path}.rule.min`, issues, { min: 0 });
  if (rule.preferredRange !== undefined) {
    if (!isPlainObject(rule.preferredRange)) {
      issues.push(`${path}.rule.preferredRange must be an object`);
    } else {
      validateNoUnknownKeys(rule.preferredRange, ['min', 'max'], `${path}.rule.preferredRange`, issues);
      validateNumber(rule.preferredRange.min, `${path}.rule.preferredRange.min`, issues, { min: 0 });
      validateNumber(rule.preferredRange.max, `${path}.rule.preferredRange.max`, issues, { min: 0 });
    }
  }
}

function validateListRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['include', 'exclude', 'values'], `${path}.rule`, issues);
  for (const key of ['include', 'exclude', 'values']) {
    if (rule[key] !== undefined && (!Array.isArray(rule[key]) || rule[key].some((item) => typeof item !== 'string'))) {
      issues.push(`${path}.rule.${key} must be an array of strings`);
    }
  }
}

function validateDurationRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['exactMinutes', 'minMinutes', 'maxMinutes'], `${path}.rule`, issues);
  validateInteger(rule.exactMinutes, `${path}.rule.exactMinutes`, issues, { min: 1 });
  validateInteger(rule.minMinutes, `${path}.rule.minMinutes`, issues, { min: 1 });
  validateInteger(rule.maxMinutes, `${path}.rule.maxMinutes`, issues, { min: 1 });
}

function validateConsecutiveAvailabilityRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['minMinutes', 'preferredMinutes'], `${path}.rule`, issues);
  validateInteger(rule.minMinutes, `${path}.rule.minMinutes`, issues, { min: 1 });
  validateInteger(rule.preferredMinutes, `${path}.rule.preferredMinutes`, issues, { min: 1 });
}

function validateCourtCountRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['exact', 'min', 'max'], `${path}.rule`, issues);
  validateInteger(rule.exact, `${path}.rule.exact`, issues, { min: 1 });
  validateInteger(rule.min, `${path}.rule.min`, issues, { min: 1 });
  validateInteger(rule.max, `${path}.rule.max`, issues, { min: 1 });
}

function validateAdjacencyRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['required', 'preferred'], `${path}.rule`, issues);
  if (rule.required !== undefined && typeof rule.required !== 'boolean') issues.push(`${path}.rule.required must be boolean`);
  if (rule.preferred !== undefined && typeof rule.preferred !== 'boolean') issues.push(`${path}.rule.preferred must be boolean`);
}

function validateTransportModes(modes, path, issues) {
  if (modes === undefined) return;
  if (!Array.isArray(modes)) {
    issues.push(`${path} must be an array`);
    return;
  }
  for (const mode of modes) {
    if (!allowedTransportModes.has(mode)) {
      issues.push(`${path} must contain only ${[...allowedTransportModes].join(', ')}`);
      return;
    }
  }
}

function validateTravelTimeRule(rule, path, issues) {
  validateNoUnknownKeys(rule, [
    'maxMinutes',
    'preferredMaxMinutes',
    'maxTransitMinutes',
    'maxWalkMinutes',
    'preferredTransportModes',
  ], `${path}.rule`, issues);
  validateInteger(rule.maxMinutes, `${path}.rule.maxMinutes`, issues, { min: 1 });
  validateInteger(rule.preferredMaxMinutes, `${path}.rule.preferredMaxMinutes`, issues, { min: 1 });
  validateInteger(rule.maxTransitMinutes, `${path}.rule.maxTransitMinutes`, issues, { min: 1 });
  validateInteger(rule.maxWalkMinutes, `${path}.rule.maxWalkMinutes`, issues, { min: 1 });
  validateTransportModes(rule.preferredTransportModes, `${path}.rule.preferredTransportModes`, issues);
}

function validateTransportPreference(transportPreference, issues) {
  if (!isPlainObject(transportPreference)) {
    issues.push('transportPreference must be an object');
    return;
  }
  validateNoUnknownKeys(
    transportPreference,
    ['maxTransitMinutes', 'maxWalkMinutes', 'preferredTransportModes'],
    'transportPreference',
    issues,
  );
  validateInteger(transportPreference.maxTransitMinutes, 'transportPreference.maxTransitMinutes', issues, { min: 1 });
  validateInteger(transportPreference.maxWalkMinutes, 'transportPreference.maxWalkMinutes', issues, { min: 1 });
  validateTransportModes(transportPreference.preferredTransportModes, 'transportPreference.preferredTransportModes', issues);
}

function validateWeatherRule(rule, path, issues) {
  validateNoUnknownKeys(rule, ['condition', 'maxTemperatureC'], `${path}.rule`, issues);
  if (rule.condition !== undefined && !allowedWeatherConditions.has(rule.condition)) issues.push(`${path}.rule.condition is not allowed`);
  validateNumber(rule.maxTemperatureC, `${path}.rule.maxTemperatureC`, issues);
}

function validateRuleForFeature(feature, rule, path, issues) {
  if (rule === undefined) return;
  if (!isPlainObject(rule)) {
    issues.push(`${path}.rule must be an object`);
    return;
  }

  if (feature === 'start_time') return validateStartTimeRule(rule, path, issues);
  if (feature === 'date') return validateDateRule(rule, path, issues);
  if (feature === 'price') return validatePriceRule(rule, path, issues);
  if (feature === 'court' || feature === 'venue' || feature === 'area' || feature === 'surface' || feature === 'venue_setting') return validateListRule(rule, path, issues);
  if (feature === 'duration') return validateDurationRule(rule, path, issues);
  if (feature === 'consecutive_availability') return validateConsecutiveAvailabilityRule(rule, path, issues);
  if (feature === 'court_count') return validateCourtCountRule(rule, path, issues);
  if (feature === 'adjacency') return validateAdjacencyRule(rule, path, issues);
  if (feature === 'travel_time') return validateTravelTimeRule(rule, path, issues);
  if (feature === 'weather') return validateWeatherRule(rule, path, issues);
  if (feature === 'next_hour_free') return validateNoUnknownKeys(rule, ['preferredMinutes'], `${path}.rule`, issues);
  return undefined;
}

function validatePreference(preference, path, { requireHardType = false } = {}) {
  const issues = [];
  if (!isPlainObject(preference)) return [`${path} must be an object`];

  validateNoUnknownKeys(preference, [
    'feature',
    'type',
    'importance',
    'priority',
    'relaxable',
    'relaxationDirection',
    'sourceText',
    'source',
    'isExplicit',
    'persistence',
    'direction',
    'target',
    'rule',
    'value',
  ], path, issues);

  if (!allowedFeatures.has(preference.feature)) issues.push(`${path}.feature must be one of ${[...allowedFeatures].join(', ')}`);
  if (!allowedTypes.has(preference.type)) issues.push(`${path}.type must be hard or soft`);
  if (requireHardType && preference.type !== 'hard') issues.push(`${path}.type must be hard inside hardConstraints`);
  if (!allowedImportance.has(preference.importance)) issues.push(`${path}.importance must be high, medium, low, or uncertain`);
  if (!allowedImportance.has(preference.priority)) issues.push(`${path}.priority must be high, medium, low, or uncertain`);
  if (preference.importance !== preference.priority) issues.push(`${path}.importance must match priority`);
  if (typeof preference.relaxable !== 'boolean') issues.push(`${path}.relaxable must be boolean`);
  if (preference.type === 'hard' && preference.relaxable !== false) issues.push(`${path}.relaxable must be false for hard constraints`);
  if (preference.type === 'soft' && preference.relaxable !== true) issues.push(`${path}.relaxable must be true for soft preferences`);
  if (preference.type === 'hard' && preference.relaxationDirection !== undefined) issues.push(`${path}.relaxationDirection is not allowed for hard constraints`);
  if (preference.relaxationDirection !== undefined && !allowedRelaxationDirections.has(preference.relaxationDirection)) {
    issues.push(`${path}.relaxationDirection is not allowed`);
  }
  if (preference.type === 'soft'
    && preference.relaxationDirection !== undefined
    && !allowedRelaxationDirectionsForFeature(preference.feature).has(preference.relaxationDirection)) {
    issues.push(`${path}.relaxationDirection is not allowed for ${preference.feature}`);
  }
  if (preference.sourceText !== undefined && typeof preference.sourceText !== 'string') issues.push(`${path}.sourceText must be a string`);
  if (preference.source !== undefined && !['user', 'default', 'system', 'replanner'].includes(preference.source)) {
    issues.push(`${path}.source must be user, default, system, or replanner`);
  }
  if (preference.isExplicit !== undefined && typeof preference.isExplicit !== 'boolean') issues.push(`${path}.isExplicit must be boolean`);
  if (preference.persistence !== undefined && !allowedPersistence.has(preference.persistence)) {
    issues.push(`${path}.persistence must be session or persistent`);
  }
  if (preference.direction !== undefined && !allowedDirections.has(preference.direction)) issues.push(`${path}.direction is not allowed`);
  if (preference.feature === 'weather' && preference.direction === 'higher') issues.push(`${path}.direction is not allowed for weather`);
  if (preference.target !== undefined && typeof preference.target !== 'boolean') issues.push(`${path}.target must be boolean`);
  if (preference.value !== undefined && typeof preference.value !== 'string') issues.push(`${path}.value must be a string`);

  validateRuleForFeature(preference.feature, preference.rule, path, issues);
  return issues;
}

function validateSearchScope(searchScope, issues) {
  if (!isPlainObject(searchScope)) {
    issues.push('searchScope must be an object');
    return;
  }

  validateNoUnknownKeys(searchScope, ['days', 'dateRange', 'timeWindow', 'location', 'sourceText', 'source', 'isExplicit'], 'searchScope', issues);
  if (!Number.isInteger(searchScope.days) || searchScope.days < 1 || searchScope.days > 30) {
    issues.push('searchScope.days must be an integer from 1 to 30');
  }
  validateDateRange(searchScope.dateRange, 'searchScope.dateRange', issues);
  if (searchScope.timeWindow !== undefined) validateStartTimeRule(searchScope.timeWindow, 'searchScope.timeWindow', issues);
  if (searchScope.location !== undefined && typeof searchScope.location !== 'string') issues.push('searchScope.location must be a string');
  if (searchScope.sourceText !== undefined && typeof searchScope.sourceText !== 'string') issues.push('searchScope.sourceText must be a string');
  if (searchScope.source !== undefined && !['user', 'default', 'system', 'replanner'].includes(searchScope.source)) {
    issues.push('searchScope.source must be user, default, system, or replanner');
  }
  if (searchScope.isExplicit !== undefined && typeof searchScope.isExplicit !== 'boolean') issues.push('searchScope.isExplicit must be boolean');
}

function validateWeatherPreference(weatherPreference, issues) {
  if (!isPlainObject(weatherPreference)) {
    issues.push('weatherPreference must be an object');
    return;
  }
  validateNoUnknownKeys(weatherPreference, ['avoidBadWeather', 'source', 'userOverride'], 'weatherPreference', issues);
  if (typeof weatherPreference.avoidBadWeather !== 'boolean') {
    issues.push('weatherPreference.avoidBadWeather must be boolean');
  }
  if (!['default', 'user'].includes(weatherPreference.source)) {
    issues.push('weatherPreference.source must be default or user');
  }
  if (typeof weatherPreference.userOverride !== 'boolean') {
    issues.push('weatherPreference.userOverride must be boolean');
  }
}

function validateObjective(objective, path) {
  const issues = [];
  if (!isPlainObject(objective)) return [`${path} must be an object`];
  validateNoUnknownKeys(objective, ['feature', 'direction', 'priority', 'sourceText'], path, issues);
  if (!allowedObjectiveFeatures.has(objective.feature)) issues.push(`${path}.feature is not allowed for objectives`);
  if (!allowedObjectiveDirections.has(objective.direction)) issues.push(`${path}.direction is not allowed`);
  if (!allowedImportance.has(objective.priority)) issues.push(`${path}.priority must be high, medium, low, or uncertain`);
  if (objective.sourceText !== undefined && typeof objective.sourceText !== 'string') issues.push(`${path}.sourceText must be a string`);
  return issues;
}

function validateUnresolved(unresolved, path) {
  const issues = [];
  if (!isPlainObject(unresolved)) return [`${path} must be an object`];
  validateNoUnknownKeys(unresolved, ['text', 'reason', 'sourceText'], path, issues);
  if (typeof unresolved.text !== 'string' || unresolved.text.length === 0) issues.push(`${path}.text must be a non-empty string`);
  if (unresolved.reason !== undefined && typeof unresolved.reason !== 'string') issues.push(`${path}.reason must be a string`);
  if (unresolved.sourceText !== undefined && typeof unresolved.sourceText !== 'string') issues.push(`${path}.sourceText must be a string`);
  return issues;
}

function validateNoDuplicateUnresolved(profile, issues) {
  const structuredSources = [
    ...profile.preferences,
    ...profile.hardConstraints,
    ...profile.objectives,
  ].map((item) => item.sourceText).filter(Boolean);

  for (const unresolved of profile.unresolvedPreferences) {
    if (structuredSources.includes(unresolved.sourceText) || structuredSources.includes(unresolved.text)) {
      issues.push(`unresolvedPreferences duplicates structured requirement: ${unresolved.text}`);
    }
  }
}

function validatePreferenceProfile(profile) {
  const issues = [];

  if (!isPlainObject(profile)) {
    throw new PreferenceSchemaError('Preference Profile must be an object', ['profile must be an object']);
  }

  validateNoUnknownKeys(profile, [
    'version',
    'searchWindowDays',
    'searchScope',
    'transportPreference',
    'weatherPreference',
    'preferences',
    'hardConstraints',
    'objectives',
    'unresolvedPreferences',
    'sourceText',
    'updatedAt',
  ], 'profile', issues);

  if (profile.version !== PREFERENCE_VERSION) issues.push('version must be 2');
  if (!Number.isInteger(profile.searchWindowDays) || profile.searchWindowDays < 1 || profile.searchWindowDays > 30) {
    issues.push('searchWindowDays must be an integer from 1 to 30');
  }
  validateSearchScope(profile.searchScope, issues);
  validateTransportPreference(profile.transportPreference, issues);
  validateWeatherPreference(profile.weatherPreference, issues);

  if (!Array.isArray(profile.preferences)) {
    issues.push('preferences must be an array');
  } else {
    profile.preferences.forEach((preference, index) => {
      issues.push(...validatePreference(preference, `preferences[${index}]`));
    });
  }

  if (!Array.isArray(profile.hardConstraints)) {
    issues.push('hardConstraints must be an array');
  } else {
    profile.hardConstraints.forEach((constraint, index) => {
      issues.push(...validatePreference(constraint, `hardConstraints[${index}]`, { requireHardType: true }));
    });
  }

  if (!Array.isArray(profile.objectives)) {
    issues.push('objectives must be an array');
  } else {
    profile.objectives.forEach((objective, index) => {
      issues.push(...validateObjective(objective, `objectives[${index}]`));
    });
  }

  if (!Array.isArray(profile.unresolvedPreferences)) {
    issues.push('unresolvedPreferences must be an array');
  } else {
    profile.unresolvedPreferences.forEach((unresolved, index) => {
      issues.push(...validateUnresolved(unresolved, `unresolvedPreferences[${index}]`));
    });
  }

  if (Array.isArray(profile.preferences)
    && Array.isArray(profile.hardConstraints)
    && Array.isArray(profile.objectives)
    && Array.isArray(profile.unresolvedPreferences)) {
    validateNoDuplicateUnresolved(profile, issues);
  }

  if (typeof profile.sourceText !== 'string') issues.push('sourceText must be a string');
  if (typeof profile.updatedAt !== 'string' || Number.isNaN(Date.parse(profile.updatedAt))) {
    issues.push('updatedAt must be an ISO timestamp string');
  }

  if (issues.length > 0) throw new PreferenceSchemaError('Invalid Preference Profile', issues);
  return profile;
}

export {
  PREFERENCE_VERSION,
  PreferenceSchemaError,
  allowedDateRangeTypes,
  allowedDirections,
  allowedFeatures,
  allowedImportance,
  allowedObjectiveDirections,
  allowedObjectiveFeatures,
  allowedPeriods,
  allowedPersistence,
  allowedRelaxationDirections,
  allowedTransportModes,
  allowedTypes,
  normalizePreferenceProfile,
  normalizeTransportPreference,
  validatePreferenceProfile,
};
