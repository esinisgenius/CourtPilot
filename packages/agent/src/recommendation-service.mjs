import { runReplanningLoop } from './replanner.mjs';
import { createInitialAgentState } from './state.mjs';
import { observeConfiguredAvailabilityProviders } from './observations.mjs';
import { normalizeSearchScope } from './search-scope.mjs';
import {
  buildPreferredTemporalPolicy,
  classifyTemporalSpecificity,
  inferPersonalizedTemporalPolicy,
} from './temporal-policy.mjs';
import {
  applyCandidateEligibilityGate,
  enrichCandidates,
  resolveTemporalWindow,
  summarizeCandidates,
  temporalWindowDays,
} from '../../core/src/index.mjs';
import { DEFAULT_BOOKABLE_VENUES } from '../../bookable/src/index.mjs';
import { DEFAULT_INTRAC_VENUES } from '../../intrac/src/index.mjs';
import { DEFAULT_SPORTLOGIC_VENUES } from '../../sportlogic/src/index.mjs';
import { DEFAULT_UNIFIED_BOOKINGS_VENUES } from '../../unified-bookings/src/index.mjs';
import { canonicalVenueInventory } from './venue-inventory.mjs';
import {
  createGoogleMapsProvider,
  haversineMeters,
  isValidCoordinate,
  MAPS_ERROR_CODES,
  MapsError,
  normalizeLocationQuery,
  resolveCanonicalLocation,
} from '../../maps/src/index.mjs';
import { interpretPreferences, loadEnvFile } from '../../preferences/src/index.mjs';

const SYDNEY_FALLBACK_LOCATION = Object.freeze({
  id: 'sydney',
  text: 'Sydney',
  canonicalName: 'Sydney',
  entityType: 'city',
  kind: 'city',
  lat: -33.8688,
  lng: 151.2093,
  center: { lat: -33.8688, lng: 151.2093 },
  radiusMeters: 35000,
  timezone: 'Australia/Sydney',
  source: 'sydney_fallback',
  confidence: 'low',
});

const configuredVenueCatalog = Object.freeze([
  {
    id: 'susf-tennis',
    name: 'Sydney Uni Sport Tennis Courts',
    suburb: 'Camperdown',
    provider: 'susf',
    providerVenueId: 'susf',
    sport: 'tennis',
    location: { lat: -33.8886, lng: 151.1873 },
    enabled: true,
  },
  ...DEFAULT_BOOKABLE_VENUES,
  ...DEFAULT_INTRAC_VENUES,
  ...DEFAULT_SPORTLOGIC_VENUES,
  ...DEFAULT_UNIFIED_BOOKINGS_VENUES,
]);

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactError(error) {
  return {
    code: error?.code ?? error?.name ?? 'ERROR',
    message: error?.message ?? String(error),
  };
}

function demoTemporalTrace(label, value) {
  if (process.env.TEMPORAL_TRACE === '1') {
    console.log(`[TEMPORAL_TRACE] ${label}=${value ?? ''}`);
  }
}

function personalizationTrace(label, value) {
  if (process.env.PERSONALIZATION_TRACE !== '1' && process.env.TEMPORAL_TRACE !== '1') return;
  console.log(`[PERSONALIZATION_TRACE] ${label}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function defaultMapsProvider() {
  try {
    return createGoogleMapsProvider();
  } catch (error) {
    if (error instanceof MapsError && error.code === MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED) return null;
    throw error;
  }
}

function providerOptionsForState(state) {
  const temporalWindow = state.searchScope?.temporalWindow ?? state.preferences?.searchScope?.temporalWindow ?? null;
  const temporalDays = temporalWindowDays(temporalWindow);
  const days = Number(temporalDays ?? state.searchScope?.days ?? state.preferences?.searchScope?.days ?? state.preferences?.searchWindowDays ?? 7);
  const durationMinutes = Number(state.searchScope?.durationMinutes ?? process.env.SUSF_DURATION ?? 60);
  const baseOptions = {
    days,
    durationMinutes,
    ...(temporalWindow?.dateStart ? { date: temporalWindow.dateStart, dateStart: temporalWindow.dateStart } : {}),
    ...(temporalWindow?.dateEnd ? { dateEnd: temporalWindow.dateEnd } : {}),
    ...(temporalWindow?.timeStart ? { timeStart: temporalWindow.timeStart } : {}),
    ...(temporalWindow?.timeEnd ? { timeEnd: temporalWindow.timeEnd } : {}),
    ...(temporalWindow?.timezone ? { timezone: temporalWindow.timezone } : {}),
  };
  demoTemporalTrace('PROVIDER_DATE_RANGE', `${baseOptions.dateStart ?? ''}..${baseOptions.dateEnd ?? ''}`);
  demoTemporalTrace('PROVIDER_TIME_RANGE', `${baseOptions.timeStart ?? ''}..${baseOptions.timeEnd ?? ''}`);
  const availabilityOptions = {};
  const matchedByProvider = state.searchScope?.locationRouting?.matchedVenuesByProvider ?? {};

  for (const [providerId, venues] of Object.entries(matchedByProvider)) {
    availabilityOptions[providerId] = {
      ...baseOptions,
      venues,
    };
  }

  return Object.keys(availabilityOptions).length > 0 ? availabilityOptions : baseOptions;
}

function accessibilityOptionsForProfile(profile) {
  const originText = profile.searchScope?.travelOrigin?.text
    ?? profile.searchScope?.travelOrigin
    ?? null;
  if (!originText) return null;
  return {
    originText,
  };
}

function candidateDistanceKm(candidate, searchScope = {}) {
  if (searchScope.locationSource !== 'explicit') return null;
  const target = centerForTarget(searchScope.targetLocation);
  const venue = candidate.features?.venue ?? candidate.source?.canonicalAvailability?.venue ?? null;
  const venuePoint = pointForVenue(venue);
  if (!target || !venuePoint) return null;
  return haversineMeters(target, venuePoint) / 1000;
}

function enrichDistanceFacts(candidates = [], searchScope = {}) {
  return candidates.map((candidate) => {
    const distanceKm = candidateDistanceKm(candidate, searchScope);
    if (!Number.isFinite(distanceKm)) return candidate;
    return {
      ...candidate,
      features: {
        ...candidate.features,
        distanceKm,
      },
    };
  });
}

async function observeRealCandidates(state, {
  signal = null,
  providerTimeoutMs,
  susfProviderTimeoutMs,
} = {}) {
  const observed = await observeConfiguredAvailabilityProviders(state, {
    availabilityOptions: providerOptionsForState(state),
    providerTimeoutMs,
    susfProviderTimeoutMs,
    signal,
  });

  const enriched = await enrichCandidates({
    candidates: observed.candidates,
    accessibilityOptions: accessibilityOptionsForProfile(observed.preferences),
  });
  const eligibility = applyCandidateEligibilityGate({
    candidates: enrichDistanceFacts(enriched, observed.searchScope),
    searchScope: observed.searchScope,
  });

  return {
    ...observed,
    candidates: eligibility.accepted,
    rejectedCandidates: [
      ...(observed.rejectedCandidates ?? []),
      ...eligibility.rejected,
    ],
  };
}

function groupedVenuesByProvider(venues) {
  const grouped = {};
  for (const venue of venues) {
    if (!venue.enabled || !venue.provider) continue;
    grouped[venue.provider] ??= [];
    grouped[venue.provider].push(venue);
  }
  return grouped;
}

function cloneTarget(location) {
  return location ? jsonClone(location) : null;
}

function centerForTarget(target) {
  if (!target || typeof target !== 'object') return null;
  if (isValidCoordinate(target.center)) return target.center;
  if (isValidCoordinate(target)) return { lat: target.lat, lng: target.lng };
  return null;
}

function pointForVenue(venue) {
  if (isValidCoordinate(venue.location)) return venue.location;
  const suburb = venue.suburb ? resolveCanonicalLocation(venue.suburb) : null;
  if (suburb && isValidCoordinate(suburb.center)) return suburb.center;
  return null;
}

function configuredSuburbLocation(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const matchingVenues = configuredVenueCatalog.filter((venue) => (
    venue.enabled !== false
    && venue.suburb
    && venue.suburb.toLowerCase() === normalized
  ));
  const points = matchingVenues.map(pointForVenue).filter(Boolean);
  if (points.length === 0) return null;
  const center = {
    lat: points.reduce((total, point) => total + point.lat, 0) / points.length,
    lng: points.reduce((total, point) => total + point.lng, 0) / points.length,
  };
  return {
    id: `configured-suburb:${normalized}`,
    text,
    canonicalName: matchingVenues[0].suburb,
    entityType: 'suburb',
    kind: 'suburb',
    center,
    radiusMeters: 3000,
    source: 'configured_venue_metadata',
    confidence: points.length === matchingVenues.length ? 'high' : 'medium',
  };
}

function sameCanonicalSuburb(venue, target) {
  if (!venue.suburb || !target) return false;
  const suburb = venue.suburb.toLowerCase();
  return [target.canonicalName, target.text]
    .filter(Boolean)
    .some((value) => suburb === String(value).toLowerCase());
}

function venueWithinTarget(venue, target, radiusMeters) {
  if (sameCanonicalSuburb(venue, target)) return true;
  const targetCenter = centerForTarget(target);
  const venuePoint = pointForVenue(venue);
  if (!targetCenter || !venuePoint) return false;
  return haversineMeters(targetCenter, venuePoint) <= radiusMeters;
}

function venueDistanceFromTarget(venue, target) {
  const targetCenter = centerForTarget(target);
  const venuePoint = pointForVenue(venue);
  if (!targetCenter || !venuePoint) return Number.POSITIVE_INFINITY;
  return haversineMeters(targetCenter, venuePoint);
}

function deprioritizeSusfForDefaultScope(providerIds) {
  return [
    ...providerIds.filter((providerId) => providerId !== 'susf'),
    ...providerIds.filter((providerId) => providerId === 'susf'),
  ];
}

function locationProviderRouting(searchScope = {}) {
  const target = searchScope.targetLocation
    ?? searchScope.targetArea
    ?? (typeof searchScope.location === 'string' ? syncTargetLocation(searchScope) : null);
  const targetText = target?.text ?? target?.canonicalName ?? searchScope.location ?? null;
  if (!targetText && !target) return null;

  if (target?.resolutionStatus === 'unresolved') {
    return {
      status: 'unresolved',
      query: targetText,
      matchedVenues: [],
      activeProviderIds: [],
      matchedVenuesByProvider: {},
    };
  }

  const center = centerForTarget(target);
  if (!center) {
    return {
      status: 'unresolved',
      query: targetText,
      matchedVenues: [],
      activeProviderIds: [],
      matchedVenuesByProvider: {},
    };
  }

  const radiusMeters = Number(target.radiusMeters ?? searchScope.radiusMeters ?? 3000);
  const matchedVenues = configuredVenueCatalog.filter((venue) => (
    venue.enabled !== false && venueWithinTarget(venue, target, radiusMeters)
  )).sort((a, b) => venueDistanceFromTarget(a, target) - venueDistanceFromTarget(b, target));
  if (matchedVenues.length === 0) {
    return {
      status: 'no_provider_coverage',
      query: targetText,
      center,
      radiusMeters,
      matchedVenues: [],
      activeProviderIds: [],
      matchedVenuesByProvider: {},
    };
  }

  const matchedVenuesByProvider = groupedVenuesByProvider(matchedVenues);
  const activeProviderIds = Object.keys(matchedVenuesByProvider);

  return {
    status: 'matched_geographic_scope',
    query: targetText,
    center,
    radiusMeters,
    matchedVenues: matchedVenues.map((venue) => ({
      id: venue.id,
      name: venue.name,
      suburb: venue.suburb ?? null,
      provider: venue.provider,
    })),
    activeProviderIds,
    matchedVenuesByProvider,
  };
}

function explicitTargetText(searchScope = {}) {
  return searchScope.targetLocation?.text
    ?? searchScope.targetArea?.text
    ?? searchScope.targetLocation
    ?? searchScope.targetArea
    ?? searchScope.location
    ?? null;
}

function normalizeResolvedLocation(location, {
  sourceText,
  source,
  confidence,
  entityType,
} = {}) {
  if (!location) return null;
  const center = location.center
    ?? location.location
    ?? (isValidCoordinate(location) ? { lat: location.lat, lng: location.lng } : null);
  if (!isValidCoordinate(center)) return null;
  const canonicalName = location.canonicalName
    ?? location.label
    ?? location.name
    ?? location.address
    ?? sourceText
    ?? 'Resolved location';
  return {
    id: location.id ?? location.placeId ?? null,
    text: sourceText ?? canonicalName,
    canonicalName,
    entityType: entityType ?? location.entityType ?? location.kind ?? inferEntityType(location),
    kind: location.kind ?? entityType ?? location.entityType ?? inferEntityType(location),
    lat: center.lat,
    lng: center.lng,
    center,
    radiusMeters: location.radiusMeters ?? location.defaultRadiusMeters ?? 3000,
    timezone: location.timezone ?? 'Australia/Sydney',
    source: source ?? location.source ?? location.providerMetadata?.provider ?? 'geocoder',
    confidence: confidence ?? location.confidence ?? confidenceForGeocode(location),
    placeId: location.placeId ?? null,
    providerMetadata: location.providerMetadata ?? null,
  };
}

function inferEntityType(location = {}) {
  const types = location.providerMetadata?.resultTypes ?? location.types ?? [];
  if (types.includes('locality') || types.includes('sublocality')) return 'suburb';
  if (types.includes('university') || types.includes('establishment') || types.includes('point_of_interest')) return 'poi';
  return 'place';
}

function confidenceForGeocode(location = {}) {
  const locationType = location.providerMetadata?.locationType;
  if (locationType === 'ROOFTOP' || locationType === 'GEOMETRIC_CENTER') return 'high';
  if (location.providerMetadata?.providerStatus === 'OK') return 'medium';
  return 'medium';
}

async function callLocationResolver(query, { locationResolver, mapsProvider } = {}) {
  if (typeof locationResolver === 'function') return locationResolver({ query });
  if (locationResolver?.resolve) return locationResolver.resolve({ query });
  if (mapsProvider?.geocode) {
    let last = null;
    for (const candidate of geocoderQueryCandidates(query)) {
      last = await mapsProvider.geocode({ query: candidate });
      if (last) return last;
    }
    return last;
  }
  return null;
}

function geocoderQueryCandidates(query) {
  const raw = String(query ?? '').trim();
  const normalized = normalizeLocationQuery(raw);
  const hasRelativePrefix = /\bnear\b|\baround\b|附近/i.test(raw);
  const candidates = [];
  const known = resolveCanonicalLocation(raw);
  if (hasRelativePrefix && known?.canonicalName) candidates.push(`${known.canonicalName} NSW Australia`);
  if (hasRelativePrefix && normalized && !/\bsydney\b|\bnsw\b/i.test(normalized)) {
    candidates.push(`${normalized} Sydney NSW Australia`);
  }
  candidates.push(raw);
  if (normalized && normalized !== raw.toLowerCase()) candidates.push(normalized);
  if (!hasRelativePrefix && normalized && !/\bsydney\b|\bnsw\b/i.test(normalized)) {
    candidates.push(`${normalized} Sydney NSW Australia`);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function relativeLocationOnly(value) {
  if (typeof value !== 'string') return false;
  const normalized = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ['附近', 'nearby', 'near me', 'around me', 'current location'].includes(normalized);
}

async function resolveTargetLocation(rawLocation, options = {}) {
  if (!rawLocation) return null;
  if (typeof rawLocation === 'object' && centerForTarget(rawLocation)) {
    return normalizeResolvedLocation(rawLocation, {
      sourceText: rawLocation.text ?? rawLocation.label ?? rawLocation.canonicalName,
      source: rawLocation.source,
      confidence: rawLocation.confidence,
    });
  }

  const sourceText = typeof rawLocation === 'string'
    ? rawLocation
    : rawLocation.text ?? rawLocation.query ?? rawLocation.label ?? null;
  if (!sourceText) return null;

  const configuredSuburb = configuredSuburbLocation(sourceText);
  if (configuredSuburb) {
    return normalizeResolvedLocation(configuredSuburb, {
      sourceText,
      source: configuredSuburb.source,
      confidence: configuredSuburb.confidence,
      entityType: configuredSuburb.entityType,
    });
  }

  const known = resolveCanonicalLocation(sourceText);
  if (known) {
    return normalizeResolvedLocation(known, {
      sourceText,
      source: known.source,
      confidence: known.confidence,
      entityType: known.kind,
    });
  }

  let geocoderError = null;
  if (options.mapsProvider || options.locationResolver) {
    try {
      const resolved = await callLocationResolver(sourceText, options);
      const normalized = normalizeResolvedLocation(resolved, {
        sourceText,
        source: resolved?.source ?? resolved?.providerMetadata?.provider ?? 'geocoder',
      });
      if (normalized) return normalized;
    } catch (error) {
      geocoderError = error;
      if (error instanceof MapsError
        && error.code !== MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED
        && error.code !== MAPS_ERROR_CODES.LOCATION_UNRESOLVED) {
        throw error;
      }
    }
  }

  return {
    text: sourceText,
    canonicalName: null,
    lat: null,
    lng: null,
    center: null,
    entityType: null,
    kind: null,
    radiusMeters: 3000,
    source: 'unresolved',
    confidence: 'none',
    resolutionStatus: 'unresolved',
    providerMetadata: geocoderError ? compactError(geocoderError) : null,
  };
}

function syncTargetLocation(searchScope = {}) {
  const targetText = explicitTargetText(searchScope);
  if (!targetText) return null;
  const known = resolveCanonicalLocation(targetText);
  if (known) return normalizeResolvedLocation(known, { sourceText: targetText, source: known.source, confidence: known.confidence });
  const configuredSuburb = configuredSuburbLocation(targetText);
  if (configuredSuburb) return normalizeResolvedLocation(configuredSuburb, { sourceText: targetText, source: configuredSuburb.source, confidence: configuredSuburb.confidence });
  return {
    text: targetText,
    canonicalName: null,
    lat: null,
    lng: null,
    center: null,
    entityType: null,
    kind: null,
    radiusMeters: 3000,
    source: 'unresolved',
    confidence: 'none',
    resolutionStatus: 'unresolved',
  };
}

function contextLocationSource(profile, {
  profileLocation,
  currentLocation,
} = {}) {
  const baseScope = profile.searchScope ?? {};
  const explicit = baseScope.targetLocation
    ?? baseScope.targetArea
    ?? baseScope.location
    ?? null;
  if (explicit && !relativeLocationOnly(explicit)) return { kind: 'explicit', value: explicit };
  if (profileLocation) return { kind: 'profile_preferred_location', value: profileLocation };
  if (currentLocation) return { kind: 'current_location', value: currentLocation };
  if (explicit) return { kind: 'explicit', value: explicit };
  return { kind: 'sydney_fallback', value: cloneTarget(SYDNEY_FALLBACK_LOCATION) };
}

function scopeWithRouting(baseScope, targetLocation, sourceKind, { now = new Date() } = {}) {
  const temporalWindow = resolveTemporalWindow({
    dateRange: baseScope.dateRange,
    timeWindow: baseScope.timeWindow,
    sourceText: baseScope.sourceText,
    now,
  });
  demoTemporalTrace('RAW_TEMPORAL', baseScope.sourceText ?? '');
  demoTemporalTrace('CANONICAL_DATE_START', temporalWindow.dateStart ?? '');
  demoTemporalTrace('CANONICAL_DATE_END', temporalWindow.dateEnd ?? '');
  demoTemporalTrace('CANONICAL_TIME_START', temporalWindow.timeStart ?? '');
  demoTemporalTrace('CANONICAL_TIME_END', temporalWindow.timeEnd ?? '');
  const scoped = {
    ...baseScope,
    targetLocation,
    locationSource: sourceKind,
    temporalWindow,
    ...(targetLocation?.radiusMeters ? { radiusMeters: targetLocation.radiusMeters } : {}),
  };
  const routing = locationProviderRouting(scoped);
  if (sourceKind === 'sydney_fallback') {
    const scopedProviderIds = scoped.providerScope?.activeProviderIds ?? scoped.providerScope?.initialProviderIds;
    const activeProviderIds = scopedProviderIds?.length
      ? scopedProviderIds
      : routing?.activeProviderIds?.length
        ? deprioritizeSusfForDefaultScope(routing.activeProviderIds)
        : deprioritizeSusfForDefaultScope([...new Set(configuredVenueCatalog
        .filter((venue) => venue.enabled !== false && venue.provider)
        .map((venue) => venue.provider))]);
    return normalizeSearchScope({
      ...scoped,
      locationRouting: {
        ...(routing ?? {}),
        status: 'sydney_fallback',
        query: 'Sydney',
        activeProviderIds,
      },
      providerScope: {
        ...(scoped.providerScope ?? {}),
        initialProviderIds: activeProviderIds,
        activeProviderIds,
        expandableProviderIds: activeProviderIds,
      },
    });
  }

  if (routing && routing.activeProviderIds.length > 0) {
    return normalizeSearchScope({
      ...scoped,
      locationRouting: routing,
      providerScope: {
        ...(scoped.providerScope ?? {}),
        initialProviderIds: routing.activeProviderIds,
        activeProviderIds: routing.activeProviderIds,
        expandableProviderIds: routing.activeProviderIds,
      },
    });
  }

  return normalizeSearchScope({
    ...scoped,
    locationRouting: routing,
    providerScope: {
      ...(scoped.providerScope ?? {}),
      initialProviderIds: [],
      activeProviderIds: [],
      expandableProviderIds: [],
    },
  });
}

function searchScopeForProfile(profile) {
  const baseScope = jsonClone(profile.searchScope ?? {});
  const source = contextLocationSource(profile);
  const targetLocation = source.kind === 'sydney_fallback'
    ? cloneTarget(SYDNEY_FALLBACK_LOCATION)
    : syncTargetLocation({ ...baseScope, location: source.value });
  return scopeWithRouting(baseScope, targetLocation, source.kind, { now: profile.updatedAt ?? new Date() });
}

async function searchScopeForProfileContext(profile, options = {}) {
  const baseScope = jsonClone(profile.searchScope ?? {});
  const source = contextLocationSource(profile, options);
  const targetLocation = source.kind === 'sydney_fallback'
    ? cloneTarget(SYDNEY_FALLBACK_LOCATION)
    : await resolveTargetLocation(source.value, options);
  return scopeWithRouting(baseScope, targetLocation, source.kind, { now: options.now ?? profile.updatedAt ?? new Date() });
}

function rankedCandidateObjects(candidates, rankedCandidates) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return rankedCandidates
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((ranking) => ({
      ranking,
      candidate: byId.get(ranking.candidateId),
    }))
    .filter((entry) => entry.candidate);
}

function candidatePriceAmount(entry) {
  return entry.candidate.features?.price ?? null;
}

function candidateStartMs(entry) {
  const value = Date.parse(entry.candidate.startTime);
  return Number.isFinite(value) ? value : null;
}

function sameVenue(left, right) {
  return left.candidate.venue === right.candidate.venue;
}

function samePresentationSlot(left, right) {
  return sameVenue(left, right) && left.candidate.startTime === right.candidate.startTime;
}

function isNearDuplicateTime(left, right, thresholdMinutes = 60) {
  const leftMs = candidateStartMs(left);
  const rightMs = candidateStartMs(right);
  if (leftMs === null || rightMs === null) return false;
  return Math.abs(leftMs - rightMs) <= thresholdMinutes * 60 * 1000;
}

function hasMeaningfulTimeDifference(candidate, selected, thresholdMinutes = 120) {
  const candidateMs = candidateStartMs(candidate);
  if (candidateMs === null) return false;
  return selected
    .filter((entry) => sameVenue(entry, candidate))
    .every((entry) => {
      const selectedMs = candidateStartMs(entry);
      return selectedMs === null || Math.abs(candidateMs - selectedMs) >= thresholdMinutes * 60 * 1000;
    });
}

function hasDifferentPrice(candidate, selected) {
  const price = candidatePriceAmount(candidate);
  if (!Number.isFinite(price)) return false;
  return selected.some((entry) => {
    const selectedPrice = candidatePriceAmount(entry);
    return Number.isFinite(selectedPrice) && selectedPrice !== price;
  });
}

function presentationHasExplicitTime(profile = {}) {
  const scope = profile.searchScope ?? {};
  const temporal = scope.temporalWindow ?? {};
  const window = scope.timeWindow ?? {};
  if (temporal.timeStart || temporal.timeEnd) return true;
  if (window.after || window.before || window.start || window.end || window.exact || window.around) return true;
  return [
    ...(profile.hardConstraints ?? []),
    ...(profile.preferences ?? []),
  ].some((preference) => preference.feature === 'start_time');
}

function diversifyRankedCandidates(ranked, { limit = 10, explicitTime = false } = {}) {
  if (!Array.isArray(ranked) || ranked.length <= 1) return ranked?.slice(0, limit) ?? [];
  const selected = [ranked[0]];
  const remaining = ranked.slice(1);
  const rankWindow = Math.max(limit, 10);

  function isDuplicate(entry) {
    return selected.some((current) => samePresentationSlot(current, entry));
  }

  function take(match) {
    const index = remaining.findIndex((entry) => (
      entry.ranking.rank <= rankWindow && !isDuplicate(entry) && match(entry)
    ));
    if (index === -1) return false;
    selected.push(remaining.splice(index, 1)[0]);
    return true;
  }

  if (explicitTime) {
    for (const entry of remaining) {
      if (selected.length >= limit) break;
      if (!isDuplicate(entry)) selected.push(entry);
    }
    return selected;
  }

  while (selected.length < limit && remaining.length > 0) {
    if (take((entry) => !selected.some((current) => sameVenue(current, entry)))) continue;
    if (take((entry) => hasMeaningfulTimeDifference(entry, selected))) continue;
    if (take((entry) => hasDifferentPrice(entry, selected)
      && !selected.some((current) => sameVenue(current, entry) && isNearDuplicateTime(current, entry)))) continue;
    const index = remaining.findIndex((entry) => entry.ranking.rank <= rankWindow
      && !isDuplicate(entry)
      && !selected.some((current) => sameVenue(current, entry) && isNearDuplicateTime(current, entry)));
    if (index !== -1) {
      selected.push(remaining.splice(index, 1)[0]);
      continue;
    }
    const fallbackIndex = remaining.findIndex((entry) => entry.ranking.rank <= rankWindow && !isDuplicate(entry));
    if (fallbackIndex === -1) break;
    selected.push(remaining.splice(fallbackIndex, 1)[0]);
  }

  return selected;
}

function serializeCandidate(entry, index = entry.ranking.rank - 1) {
  const { candidate, ranking } = entry;
  const weather = candidate.features?.weather ?? null;
  const calendar = candidate.features?.calendar ?? null;
  const accessibility = candidate.features?.accessibility ?? candidate.accessibility ?? null;
  const endTime = endTimeFromStart(candidate.startTime, candidate.durationMinutes);

  return {
    id: candidate.id,
    rank: index + 1,
    originalRank: ranking.rank,
    venue: candidate.venue,
    court: candidate.court,
    startTime: candidate.startTime,
    endTime,
    localDate: candidate.features?.localDate ?? null,
    localTime: candidate.features?.localTime ?? null,
    distanceKm: Number.isFinite(candidate.features?.distanceKm) ? candidate.features.distanceKm : null,
    durationMinutes: candidate.durationMinutes,
    booking: candidate.booking?.url ? candidate.booking : null,
    availability: {
      nextHourAlsoAvailable: candidate.features?.nextHourFree ?? null,
      source: candidate.source?.availability?.source ?? candidate.source?.canonicalAvailability?.provenance?.source ?? null,
      provider: candidate.source?.provider ?? null,
    },
    price: {
      amount: candidate.features?.price ?? null,
      currency: candidate.source?.canonicalAvailability?.price?.currency ?? null,
      options: candidate.features?.priceOptions ?? [],
    },
    weather,
    calendar,
    accessibility,
    reasons: ranking.reasons ?? [],
    tradeoffs: ranking.tradeoffs ?? [],
    warnings: [
      ...(candidate.features?.weatherWarning ? [{ feature: 'weather', detail: candidate.features.weatherWarning }] : []),
      ...(candidate.features?.weatherUnknown ? [{ feature: 'weather', detail: 'weather_unknown' }] : []),
    ],
  };
}

function endTimeFromStart(startTime, durationMinutes) {
  const startMs = Date.parse(startTime);
  const durationMs = Number(durationMinutes) * 60 * 1000;
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs)) return null;
  return new Date(startMs + durationMs).toISOString();
}

function canonicalVenueKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\btennis\b/g, '')
    .replace(/\bcourts?\b/g, '')
    .replace(/\bcentre\b/g, 'center')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tierOneVenueKeys(entries = []) {
  return new Set(entries.flatMap((entry) => [
    entry.candidate?.source?.canonicalAvailability?.venue?.id,
    canonicalVenueKey(entry.candidate?.venue),
  ].filter(Boolean)));
}

function nearbyCourtDistanceKm(venue, target) {
  const center = centerForTarget(target);
  const point = isValidCoordinate(venue) ? { lat: venue.lat, lng: venue.lng } : pointForVenue(venue);
  if (!center || !point) return null;
  return haversineMeters(center, point) / 1000;
}

function serializeNearbyCourt(venue, distanceKm) {
  return {
    id: venue.id,
    venue: venue.name,
    name: venue.name,
    suburb: venue.suburb ?? null,
    area: venue.area ?? null,
    court: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    price: null,
    distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
    liveAvailability: false,
    realtimeAvailability: Boolean(venue.realtimeAvailability),
    booking: venue.booking?.url ? venue.booking : null,
    courtCount: venue.courtCount ?? null,
    surface: venue.surface ?? null,
    provider: venue.provider ?? null,
    verificationStatus: venue.verificationStatus,
  };
}

function selectNearbyCourts(searchScope = {}, tierOneEntries = [], {
  limit = 5,
  inventory = canonicalVenueInventory(),
} = {}) {
  if (searchScope.locationSource !== 'explicit') return [];
  const target = searchScope.targetLocation;
  if (!centerForTarget(target)) return [];

  const excluded = tierOneVenueKeys(tierOneEntries);
  const radiusMeters = Math.max(3000, Math.min(Number(searchScope.radiusMeters ?? target.radiusMeters ?? 3000), 8000));

  return inventory
    .filter((venue) => (
      venue.verificationStatus === 'verified'
      && venue.sport === 'tennis'
      && venue.realtimeAvailability === false
      && !excluded.has(venue.id)
      && !excluded.has(canonicalVenueKey(venue.name))
    ))
    .map((venue) => ({
      venue,
      distanceKm: nearbyCourtDistanceKm(venue, target),
    }))
    .filter((entry) => Number.isFinite(entry.distanceKm) && entry.distanceKm * 1000 <= radiusMeters)
    .sort((a, b) => a.distanceKm - b.distanceKm || a.venue.name.localeCompare(b.venue.name))
    .slice(0, limit)
    .map((entry) => serializeNearbyCourt(entry.venue, entry.distanceKm));
}

function summarizeRejected(rejectedCandidates = []) {
  const counts = {};
  for (const rejected of rejectedCandidates) {
    for (const reason of rejected.reasons ?? []) {
      const key = `${reason.feature}:${reason.reason}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function compactEvaluation(evaluation) {
  if (!evaluation) return null;
  return {
    status: evaluation.status,
    satisfactory: evaluation.satisfactory,
    reasons: evaluation.reasons ?? [],
    weakPreferences: evaluation.weakPreferences ?? [],
    topCandidateId: evaluation.topCandidateId ?? null,
    topCandidateSoftJudgements: evaluation.topCandidateSoftJudgements ?? [],
    softViolations: evaluation.softViolations ?? [],
    missingFacts: evaluation.missingFacts ?? [],
    observationIssues: evaluation.observationIssues ?? [],
    factualCandidateFeatureCount: evaluation.factualCandidateFeatureCount ?? 0,
    failedConstraintCount: evaluation.failedConstraints?.length ?? 0,
  };
}

function userFacingStatusForRun({ result, ranked, providerObservations, searchScope }) {
  const routingStatus = searchScope?.locationRouting?.status;
  const timedOut = providerObservations.filter((item) => item.status === 'timed_out');
  const failed = providerObservations.filter((item) => item.status === 'failed' || item.status === 'cancelled');
  const successes = providerObservations.filter((item) => item.status === 'success' && (item.candidateCount ?? 0) > 0);
  const rejectedByReason = summarizeRejected(result.state.rejectedCandidates);

  if (routingStatus === 'unresolved') {
    return {
      code: 'LOCATION_UNRESOLVED',
      title: 'I need a clearer location',
      message: 'I could not reliably match that place to a Sydney tennis search area.',
      severity: 'needs_input',
    };
  }

  if (routingStatus === 'no_provider_coverage') {
    return {
      code: 'NO_PROVIDER_COVERAGE',
      title: 'No connected courts near that location',
      message: 'I understood the location, but none of the connected booking providers cover nearby tennis venues yet.',
      severity: 'needs_input',
    };
  }

  if (ranked.length > 0 && timedOut.length > 0) {
    return {
      code: 'PARTIAL_RECOMMENDATIONS',
      title: 'Found courts from the providers that responded',
      message: `${timedOut.length} provider${timedOut.length === 1 ? '' : 's'} timed out, so these recommendations use the available provider results.`,
      severity: 'warning',
    };
  }

  if (ranked.length > 0) {
    return {
      code: 'RECOMMENDATIONS_READY',
      title: 'Found court recommendations',
      message: 'These options passed the hard filters and are ranked by your preferences.',
      severity: 'success',
    };
  }

  if (timedOut.length > 0 && successes.length === 0) {
    return {
      code: 'PROVIDER_TIMEOUT',
      title: 'The booking provider was too slow',
      message: 'The connected booking site did not respond within the demo time budget. Try again or use a broader area.',
      severity: 'warning',
    };
  }

  if (failed.length > 0 && successes.length === 0) {
    return {
      code: 'PROVIDER_UNAVAILABLE',
      title: 'Booking provider unavailable',
      message: 'The connected booking provider failed before returning usable availability.',
      severity: 'warning',
    };
  }

  if (Object.keys(rejectedByReason).some((reason) => reason.startsWith('hard:') || reason.includes('date_') || reason.includes('time_'))) {
    return {
      code: 'CONSTRAINTS_TOO_STRICT',
      title: 'No courts match those constraints',
      message: 'I found availability, but the hard constraints removed every candidate.',
      severity: 'needs_input',
    };
  }

  return {
    code: 'NO_AVAILABILITY',
    title: 'No available courts found',
    message: 'I did not find bookable court availability in the current search scope.',
    severity: 'neutral',
  };
}

function serializeRun({
  request,
  profile,
  result,
  startedAt,
  finishedAt = new Date().toISOString(),
}) {
  const ranked = rankedCandidateObjects(result.state.candidates, result.rankedCandidates);
  const diversified = diversifyRankedCandidates(ranked, {
    limit: 10,
    explicitTime: presentationHasExplicitTime(profile),
  });
  demoTemporalTrace('FIRST_FINAL_SLOT', diversified[0]?.candidate?.startTime ?? '');
  const nearbyCourts = selectNearbyCourts(result.state.searchScope, diversified);
  const latestIteration = result.iterations.at(-1) ?? null;
  const providerObservations = result.state.factualObservations?.availability?.providers ?? [];
  const userStatus = userFacingStatusForRun({
    result,
    ranked,
    providerObservations,
    searchScope: result.state.searchScope,
  });

  return {
    ok: true,
    mode: 'real',
    request,
    startedAt,
    finishedAt,
    status: result.status,
    userStatus,
    preferenceProfile: profile,
    searchScope: result.state.searchScope,
    summary: {
      providerObservations,
      totalCandidates: summarizeCandidates(result.state.candidates).total,
      feasibleCandidates: result.state.candidates.length,
      rejectedCandidates: result.state.rejectedCandidates.length,
      rejectedByReason: summarizeRejected(result.state.rejectedCandidates),
      iterations: result.iterations.length,
      latestEvaluation: compactEvaluation(latestIteration?.evaluation),
      latestAction: latestIteration?.action ?? null,
      locationRouting: result.state.searchScope?.locationRouting ?? locationProviderRouting(profile.searchScope),
      maps: profile.searchScope?.travelOrigin
        ? { status: 'requested' }
        : { status: 'not_requested', reason: 'No travel origin was present in the request.' },
    },
    candidates: diversified.map(serializeCandidate),
    verifiedAvailability: diversified.map(serializeCandidate),
    nearbyCourts,
    replanning: result.iterations.map((iteration) => ({
      iteration: iteration.iteration,
      evaluation: compactEvaluation(iteration.evaluation),
      action: iteration.action,
      candidateCount: iteration.candidateCount,
      searchScope: iteration.searchScope,
    })),
  };
}

async function recommendCourts({
  request,
  currentLocation = null,
  profileLocation = null,
  locationResolver = null,
  mapsProvider = null,
  temporalPolicyProvider = null,
  userProfile = null,
  recentBehavior = {},
  now = new Date(),
  maxIterations = Number(process.env.RECOMMEND_MAX_ITERATIONS ?? 2),
  minCandidates = Number(process.env.RECOMMEND_MIN_CANDIDATES ?? 1),
  totalBudgetMs = Number(process.env.RECOMMEND_TOTAL_BUDGET_MS ?? 90000),
  providerTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS ?? 12000),
  susfProviderTimeoutMs = Number(process.env.SUSF_PROVIDER_TIMEOUT_MS ?? 60000),
  signal = null,
} = {}) {
  if (typeof request !== 'string' || request.trim().length === 0) {
    return {
      ok: false,
      mode: 'real',
      status: 'INVALID_REQUEST',
      error: { code: 'INVALID_REQUEST', message: 'request must be a non-empty string' },
    };
  }

  const startedAt = now.toISOString();
  await loadEnvFile();
  let requestPreferences;
  try {
    requestPreferences = await interpretPreferences(request, { now });
  } catch (error) {
    return {
      ok: false,
      mode: 'real',
      request,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'PREFERENCE_PARSE_FAILED',
      error: compactError(error),
    };
  }

  const searchScope = await searchScopeForProfileContext(requestPreferences, {
    currentLocation,
    profileLocation,
    locationResolver,
    mapsProvider: mapsProvider ?? defaultMapsProvider(),
    now,
  });
  const baseRuntimeProfile = {
    ...requestPreferences,
    searchScope: {
      ...(requestPreferences.searchScope ?? {}),
      ...searchScope,
    },
  };
  personalizationTrace('REQUEST_TEMPORAL', baseRuntimeProfile.searchScope?.temporalWindow ?? null);
  personalizationTrace('USER_PROFILE', {
    hasProfile: Boolean(userProfile),
    preferredDays: userProfile?.preferredDays ?? [],
    preferredTimeWindows: userProfile?.preferredTimeWindows ?? [],
    typicalDurationMinutes: userProfile?.typicalDurationMinutes ?? userProfile?.preferredDurationMinutes ?? null,
    maxTravelMinutes: userProfile?.maxTravelMinutes ?? null,
    preferredVenues: userProfile?.preferredVenues ?? [],
  });
  personalizationTrace('BEHAVIOR_SUMMARY', {
    bookingClickCount: recentBehavior?.bookingClickCount ?? 0,
    selectionCount: recentBehavior?.selectionCount ?? 0,
    searchCount: recentBehavior?.searchCount ?? 0,
    timeBuckets: recentBehavior?.timeBuckets ?? null,
    dominantTimeBucket: recentBehavior?.dominantTimeBucket ?? null,
    confidence: recentBehavior?.confidence ?? null,
  });
  const preferredTemporalPolicy = await buildPreferredTemporalPolicy({
    requestPreferences: baseRuntimeProfile,
    userProfile,
    recentBehavior,
    provider: temporalPolicyProvider,
  });
  personalizationTrace('POLICY_MODE', preferredTemporalPolicy.mode);
  personalizationTrace('EVIDENCE_USED', preferredTemporalPolicy.evidenceUsed);
  const runtimeProfile = {
    ...baseRuntimeProfile,
    preferredTemporalPolicy,
  };

  const initialState = createInitialAgentState({
    goal: request,
    preferences: runtimeProfile,
    searchScope,
    factualObservations: {},
  });

  const budgetController = new AbortController();
  const abortFromParent = () => budgetController.abort(signal.reason);
  if (signal) signal.addEventListener('abort', abortFromParent, { once: true });
  const budgetTimeout = Number.isFinite(totalBudgetMs) && totalBudgetMs > 0
    ? setTimeout(() => {
      const error = new Error(`Recommendation timed out after ${totalBudgetMs}ms`);
      error.code = 'RECOMMENDATION_TIMEOUT';
      budgetController.abort(error);
    }, totalBudgetMs)
    : null;

  try {
    const result = await runReplanningLoop(initialState, {
      observe: (state) => observeRealCandidates(state, {
        signal: budgetController.signal,
        providerTimeoutMs,
        susfProviderTimeoutMs,
      }),
      maxIterations,
      minCandidates,
      defaultCalendarBusyIsHard: true,
    });
    return serializeRun({ request, profile: runtimeProfile, result, startedAt });
  } catch (error) {
    return {
      ok: false,
      mode: 'real',
      request,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'RECOMMENDATION_FAILED',
      preferenceProfile: runtimeProfile,
      error: compactError(error),
    };
  } finally {
    if (budgetTimeout) clearTimeout(budgetTimeout);
    if (signal) signal.removeEventListener('abort', abortFromParent);
  }
}

export {
  buildPreferredTemporalPolicy,
  classifyTemporalSpecificity,
  diversifyRankedCandidates,
  inferPersonalizedTemporalPolicy,
  locationProviderRouting,
  providerOptionsForState,
  recommendCourts,
  selectNearbyCourts,
  serializeCandidate,
  serializeNearbyCourt,
  searchScopeForProfileContext,
  searchScopeForProfile,
};
