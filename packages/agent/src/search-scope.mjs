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
  switchSearchArea,
  withNormalizedSearchScope,
};
