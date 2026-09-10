import {
  INITIAL_RADIUS_METERS,
  TRAVEL_MODES,
  getNextRadius,
  getSavedPlayArea,
  normalizeSavedAreaLocation,
  normalizeTravelMode,
} from '../../maps/src/index.mjs';
import { nextExpandableProviderId, normalizeProviderScope } from './provider-scope.mjs';
import { validateAgentState } from './state.mjs';

function normalizeSearchScope(searchScope = {}) {
  return {
    ...searchScope,
    location: searchScope.location ?? null,
    activeAreaId: searchScope.activeAreaId ?? null,
    radiusMeters: searchScope.radiusMeters ?? INITIAL_RADIUS_METERS,
    travelMode: normalizeTravelMode(searchScope.travelMode ?? TRAVEL_MODES.TRANSIT),
    travelModeSource: searchScope.travelModeSource ?? 'product_default',
    courtScope: {
      includeNonPreferred: false,
      ...(searchScope.courtScope ?? {}),
    },
    providerScope: normalizeProviderScope(searchScope.providerScope),
  };
}

function withNormalizedSearchScope(state) {
  const valid = validateAgentState(state);
  return {
    ...valid,
    searchScope: normalizeSearchScope(valid.searchScope),
  };
}

function expandSearchRadius(state) {
  const current = withNormalizedSearchScope(state);
  return {
    ...current,
    searchScope: {
      ...current.searchScope,
      radiusMeters: getNextRadius(current.searchScope.radiusMeters),
    },
  };
}

function includeNonPreferredCourts(state) {
  const current = withNormalizedSearchScope(state);
  if (current.searchScope.courtScope.includeNonPreferred) {
    throw new Error('Non-preferred courts are already included in the search scope');
  }

  return {
    ...current,
    searchScope: {
      ...current.searchScope,
      courtScope: {
        ...current.searchScope.courtScope,
        includeNonPreferred: true,
      },
    },
  };
}

function hardStartTimeRules(state) {
  return (state.preferences?.hardConstraints ?? [])
    .filter((constraint) => constraint.feature === 'start_time' && constraint.rule)
    .map((constraint) => constraint.rule);
}

function hardBoundedTimeWindow(state) {
  const rules = hardStartTimeRules(state);
  if (rules.length === 0) return state.searchScope?.timeWindow ?? {};

  return rules.reduce((window, rule) => {
    const next = { ...window };
    if (rule.before) next.before = rule.before;
    if (rule.after) next.after = rule.after;
    if (rule.equals) next.equals = rule.equals;
    if (rule.between) next.between = rule.between;
    if (rule.exclude) next.exclude = rule.exclude;
    if (rule.period) next.period = rule.period;
    return next;
  }, {});
}

function shiftTimeWindow(state) {
  const current = withNormalizedSearchScope(state);
  const shiftCount = (current.searchScope.temporalShiftCount ?? 0) + 1;
  const boundedWindow = hardBoundedTimeWindow(current);

  return {
    ...current,
    searchScope: {
      ...current.searchScope,
      timeWindow: boundedWindow,
      temporalShiftCount: shiftCount,
      temporalShiftSemantics: 'within_hard_start_time_bounds',
    },
  };
}

function expandVenueSet(state) {
  const current = withNormalizedSearchScope(state);
  const providerId = nextExpandableProviderId(current.searchScope.providerScope);
  if (!providerId) {
    throw new Error('No configured provider expansion remains in the search scope');
  }

  return {
    ...current,
    searchScope: {
      ...current.searchScope,
      providerScope: normalizeProviderScope({
        ...current.searchScope.providerScope,
        activeProviderIds: [
          ...current.searchScope.providerScope.activeProviderIds,
          providerId,
        ],
        lastExpansionProviderId: providerId,
      }),
    },
  };
}

async function switchSearchArea(state, targetAreaId, { savedAreasPath } = {}) {
  const current = withNormalizedSearchScope(state);
  const area = await getSavedPlayArea(targetAreaId, { filePath: savedAreasPath });
  if (!area) {
    throw new Error(`Saved play area not found: ${targetAreaId}`);
  }

  return {
    ...current,
    searchScope: {
      ...current.searchScope,
      location: normalizeSavedAreaLocation(area),
      activeAreaId: area.id,
      radiusMeters: area.defaultRadiusMeters,
    },
  };
}

export {
  expandVenueSet,
  expandSearchRadius,
  includeNonPreferredCourts,
  normalizeSearchScope,
  shiftTimeWindow,
  switchSearchArea,
  withNormalizedSearchScope,
};
