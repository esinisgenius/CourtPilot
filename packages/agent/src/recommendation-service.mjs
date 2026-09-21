import { runReplanningLoop } from './replanner.mjs';
import { createOpenAiReplannerProvider } from './llm-replanner.mjs';
import { createOpenAiRankerProvider } from '../../ranking/src/index.mjs';
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
  stableCandidateId,
  summarizeCandidates,
  temporalWindowDays,
} from '../../core/src/index.mjs';
import { DEFAULT_BOOKABLE_VENUES } from '../../bookable/src/index.mjs';
import { DEFAULT_INTRAC_VENUES } from '../../intrac/src/index.mjs';
import { DEFAULT_CLUBSPARK_VENUES } from '../../clubspark/src/index.mjs';
import { DEFAULT_MINDBODY_VENUES } from '../../mindbody/src/index.mjs';
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
  ...DEFAULT_CLUBSPARK_VENUES,
  ...DEFAULT_MINDBODY_VENUES,
  ...DEFAULT_SPORTLOGIC_VENUES,
  ...DEFAULT_UNIFIED_BOOKINGS_VENUES,
].map((venue) => {
  const canonical = canonicalVenueInventory().find((item) => item.id === venue.id);
  return { ...venue, surfaces: canonical?.surfaces ?? venue.surfaces ?? [] };
}));

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
  const optionVariants = Array.isArray(temporalWindow?.timeWindows) && temporalWindow.timeWindows.length > 0
    ? temporalWindow.timeWindows.map((window) => ({
        ...baseOptions,
        ...(window.start && window.start !== '00:00' ? { timeStart: window.start } : {}),
        ...(window.end && window.end !== '23:59' ? { timeEnd: window.end } : {}),
      }))
    : [baseOptions];
  const withVenues = (venues) => {
    const variants = optionVariants.map((options) => ({ ...options, venues }));
    return variants.length === 1 ? variants[0] : variants;
  };
  demoTemporalTrace('PROVIDER_DATE_RANGE', `${baseOptions.dateStart ?? ''}..${baseOptions.dateEnd ?? ''}`);
  demoTemporalTrace('PROVIDER_TIME_RANGE', `${baseOptions.timeStart ?? ''}..${baseOptions.timeEnd ?? ''}`);
  const availabilityOptions = {};
  const matchedByProvider = state.searchScope?.locationRouting?.matchedVenuesByProvider ?? {};

  if (state.searchScope?.locationSource === 'explicit'
    && state.searchScope?.locationRouting?.status === 'matched_geographic_scope') {
    const activeProviderIds = state.searchScope?.providerScope?.activeProviderIds ?? [];
    for (const providerId of activeProviderIds) {
      availabilityOptions[providerId] = withVenues(matchedByProvider[providerId] ?? []);
    }
    return availabilityOptions;
  }

  for (const [providerId, venues] of Object.entries(matchedByProvider)) {
    availabilityOptions[providerId] = withVenues(venues);
  }

  return Object.keys(availabilityOptions).length > 0
    ? availabilityOptions
    : optionVariants.length === 1 ? baseOptions : optionVariants;
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
  const targets = searchScope.locationRouting?.targets?.length
    ? searchScope.locationRouting.targets
    : [searchScope.targetLocation];
  const venue = candidate.features?.venue ?? candidate.source?.canonicalAvailability?.venue ?? null;
  const venuePoint = pointForVenue(venue);
  if (!venuePoint) return null;
  const distances = targets
    .map((target) => centerForTarget(target))
    .filter(Boolean)
    .map((target) => haversineMeters(target, venuePoint) / 1000);
  return distances.length > 0 ? Math.min(...distances) : null;
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

function requestedLogicalDuration(profile = {}) {
  const signals = [...(profile.hardConstraints ?? []), ...(profile.preferences ?? [])]
    .filter((item) => item.feature === 'duration' || item.feature === 'consecutive_availability');
  const minutes = signals
    .map((item) => item.rule?.exactMinutes ?? item.rule?.minMinutes ?? item.rule?.preferredMinutes)
    .filter(Number.isFinite);
  return {
    minutes: minutes.length > 0 ? Math.max(...minutes) : null,
    hard: signals.some((item) => item.type === 'hard' && Number.isFinite(
      item.rule?.exactMinutes ?? item.rule?.minMinutes ?? item.rule?.preferredMinutes,
    )),
  };
}

function candidateResourceKey(candidate) {
  const canonical = candidate.source?.canonicalAvailability;
  return [
    candidate.source?.provider,
    canonical?.venue?.id ?? candidate.venue,
    canonical?.court?.id ?? candidate.court,
  ].join('|');
}

function materializeLogicalDurationCandidates(candidates = [], profile = {}) {
  const request = requestedLogicalDuration(profile);
  if (request.minutes !== 120) return candidates;

  const sixtyMinute = candidates.filter((candidate) => candidate.durationMinutes === 60);
  const byResourceAndStart = new Map(sixtyMinute.map((candidate) => [
    `${candidateResourceKey(candidate)}|${Date.parse(candidate.startTime)}`,
    candidate,
  ]));
  const logical = [];
  for (const candidate of sixtyMinute) {
    const startMs = Date.parse(candidate.startTime);
    if (!Number.isFinite(startMs)) continue;
    const next = byResourceAndStart.get(`${candidateResourceKey(candidate)}|${startMs + 60 * 60 * 1000}`);
    if (!next) continue;
    logical.push({
      ...candidate,
      id: stableCandidateId({
        provider: candidate.source?.provider,
        venue: candidate.source?.canonicalAvailability?.venue?.id ?? candidate.venue,
        court: candidate.source?.canonicalAvailability?.court?.id ?? candidate.court,
        startTime: candidate.startTime,
        durationMinutes: 120,
      }),
      durationMinutes: 120,
      componentSlots: [
        { id: candidate.id, startTime: candidate.startTime, durationMinutes: 60 },
        { id: next.id, startTime: next.startTime, durationMinutes: 60 },
      ],
      features: {
        ...candidate.features,
        nextHourFree: true,
        continuousDurationMinutes: 120,
      },
    });
  }

  const nativeLong = candidates.filter((candidate) => candidate.durationMinutes >= 120);
  if (request.hard) return [...nativeLong, ...logical];
  return [...candidates, ...logical];
}

function candidateSurface(candidate) {
  const venueId = candidate.source?.canonicalAvailability?.venue?.id;
  const venue = canonicalVenueInventory().find((item) => item.id === venueId);
  const providerSurface = canonicalSurfaceType(candidate.source?.canonicalAvailability?.court?.surface);
  const courtNumber = String(candidate.court ?? '').match(/\b(\d{1,2})\b/)?.[1] ?? null;
  const mappedSurface = courtNumber ? venue?.courtSurfaces?.[courtNumber] ?? null : null;
  if (mappedSurface || providerSurface) return mappedSurface ?? providerSurface;
  return venue?.surfaces?.length === 1 ? venue.surfaces[0] : null;
}

function applySurfaceScope(candidates = [], searchScope = {}) {
  const requested = new Set(searchScope.surfaces ?? []);
  if (requested.size === 0) return { accepted: candidates, rejected: [] };

  const accepted = [];
  const rejected = [];
  for (const candidate of candidates) {
    const surface = candidateSurface(candidate);
    if (surface && requested.has(surface)) {
      accepted.push(candidate);
    } else {
      rejected.push({
        candidate,
        reasons: [{
          feature: 'surface',
          reason: surface ? 'candidate_surface_mismatch' : 'candidate_surface_unknown',
          detail: surface
            ? `Court surface ${surface} does not match the requested surface.`
            : 'Court surface is not known precisely enough to match the request.',
        }],
      });
    }
  }
  return { accepted, rejected };
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
  const surfaceScope = applySurfaceScope(eligibility.accepted, observed.searchScope);

  return {
    ...observed,
    candidates: surfaceScope.accepted,
    rejectedCandidates: [
      ...(observed.rejectedCandidates ?? []),
      ...eligibility.rejected,
      ...surfaceScope.rejected,
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
  if (target.center && isValidCoordinate(target.center)) return target.center;
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

function alternativeLocationTargets(searchScope = {}, primaryTarget = null) {
  const text = String(searchScope.sourceText ?? '').toLowerCase();
  const hasAlternativeConnector = /(?:\u6216\u8005|\u6216|\bor\b|\/)/iu.test(text);
  const mentionsCity = /(?:\bcity\b|\bcbd\b|\bdowntown\b|\u5e02\u4e2d\u5fc3|\u6089\u5c3c\u5e02\u533a)/iu.test(text);
  const mentionsUsyd = /(?:\u6089\u5927|\u6089\u5c3c\u5927\u5b66|\busyd\b|\bsydney uni(?:versity)?\b|\buniversity of sydney\b)/iu.test(text);
  if (!hasAlternativeConnector || !mentionsCity || !mentionsUsyd) return [primaryTarget].filter(Boolean);

  return ['city', '\u6089\u5c3c\u5927\u5b66\u9644\u8fd1']
    .map((location) => syncTargetLocation({ location }))
    .filter((target) => centerForTarget(target));
}

function locationProviderRouting(searchScope = {}) {
  const target = searchScope.targetLocation
    ?? searchScope.targetArea
    ?? (typeof searchScope.location === 'string' ? syncTargetLocation(searchScope) : null);
  const targetText = target?.text ?? target?.canonicalName ?? searchScope.location ?? null;
  if (!targetText && !target) return null;
  const targets = alternativeLocationTargets(searchScope, target)
    .filter((candidateTarget) => centerForTarget(candidateTarget));

  if (targets.length === 0) {
    return {
      status: 'unresolved',
      query: targetText,
      matchedVenues: [],
      activeProviderIds: [],
      matchedVenuesByProvider: {},
    };
  }

  const center = centerForTarget(targets[0]);
  const radiusMeters = Number(target.radiusMeters ?? searchScope.radiusMeters ?? 3000);
  const requestedSettings = new Set(searchScope.venueSettings ?? []);
  const hasSettingPreference = requestedSettings.size > 0;
  const settingMatches = (venue) => !hasSettingPreference
    || (venue.settings ?? []).some((setting) => requestedSettings.has(setting));
  const requestedSurfaces = new Set(searchScope.surfaces ?? []);
  const hasSurfacePreference = requestedSurfaces.size > 0;
  const surfaceMatches = (venue) => !hasSurfacePreference
    || (venue.surfaces ?? []).some((surface) => requestedSurfaces.has(surface));
  const matchedVenues = configuredVenueCatalog.filter((venue) => {
    if (venue.enabled === false || !settingMatches(venue) || !surfaceMatches(venue)) return false;
    if (searchScope.locationSource === 'sydney_fallback' && (hasSettingPreference || hasSurfacePreference)) return true;
    return targets.some((candidateTarget) => venueWithinTarget(
      venue,
      candidateTarget,
      Number(candidateTarget.radiusMeters ?? radiusMeters),
    ));
  }).sort((a, b) => (
    Math.min(...targets.map((candidateTarget) => venueDistanceFromTarget(a, candidateTarget)))
      - Math.min(...targets.map((candidateTarget) => venueDistanceFromTarget(b, candidateTarget)))
  ));
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
    targets,
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

function preferredVenueSettings(profile = {}) {
  return [...new Set((profile.preferences ?? [])
    .filter((preference) => preference.feature === 'venue_setting' && preference.type !== 'hard')
    .flatMap((preference) => preference.rule?.include ?? preference.rule?.values ?? [])
    .map((setting) => String(setting).trim().toLowerCase())
    .filter(Boolean))];
}

function preferredSurfaces(profile = {}) {
  return [...new Set((profile.preferences ?? [])
    .filter((preference) => preference.feature === 'surface' && preference.type !== 'hard')
    .flatMap((preference) => preference.rule?.include ?? preference.rule?.values ?? [])
    .map((surface) => String(surface).trim().toLowerCase())
    .filter(Boolean))];
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
    const thematicSearch = (scoped.venueSettings?.length ?? 0) > 0 || (scoped.surfaces?.length ?? 0) > 0;
    const scopedProviderIds = scoped.providerScope?.activeProviderIds ?? scoped.providerScope?.initialProviderIds;
    const activeProviderIds = scopedProviderIds?.length
      ? scopedProviderIds
      : routing?.activeProviderIds?.length
        ? deprioritizeSusfForDefaultScope(routing.activeProviderIds)
        : thematicSearch
          ? []
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
  const hardTimeRule = (profile.hardConstraints ?? [])
    .find((constraint) => constraint.feature === 'start_time')?.rule;
  const baseScope = {
    ...jsonClone(profile.searchScope ?? {}),
    ...(!profile.searchScope?.timeWindow && hardTimeRule ? { timeWindow: jsonClone(hardTimeRule) } : {}),
    venueSettings: preferredVenueSettings(profile),
    surfaces: preferredSurfaces(profile),
  };
  const source = contextLocationSource(profile);
  const targetLocation = source.kind === 'sydney_fallback'
    ? cloneTarget(SYDNEY_FALLBACK_LOCATION)
    : syncTargetLocation({ ...baseScope, location: source.value });
  return scopeWithRouting(baseScope, targetLocation, source.kind, { now: profile.updatedAt ?? new Date() });
}

async function searchScopeForProfileContext(profile, options = {}) {
  const hardTimeRule = (profile.hardConstraints ?? [])
    .find((constraint) => constraint.feature === 'start_time')?.rule;
  const baseScope = {
    ...jsonClone(profile.searchScope ?? {}),
    ...(!profile.searchScope?.timeWindow && hardTimeRule ? { timeWindow: jsonClone(hardTimeRule) } : {}),
    venueSettings: preferredVenueSettings(profile),
    surfaces: preferredSurfaces(profile),
  };
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
  const accessibility = candidate.features?.accessibility ?? candidate.accessibility ?? null;
  const endTime = endTimeFromStart(candidate.startTime, candidate.durationMinutes);
  const venueId = candidate.source?.canonicalAvailability?.venue?.id;
  const venueMetadata = canonicalVenueInventory().find((venue) => venue.id === venueId);
  const courtSurface = candidate.source?.canonicalAvailability?.court?.surface;
  const courtNumber = String(candidate.court ?? '').match(/\b(\d{1,2})\b/)?.[1] ?? null;
  const mappedCourtSurface = courtNumber ? venueMetadata?.courtSurfaces?.[courtNumber] ?? null : null;
  const resolvedCourtSurface = mappedCourtSurface ?? canonicalSurfaceType(courtSurface);
  const venueSurfaces = venueMetadata?.surfaces ?? [];
  const surfaces = resolvedCourtSurface
    ? [resolvedCourtSurface]
    : venueSurfaces.length === 1
      ? venueSurfaces
      : [];

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
    componentSlots: candidate.componentSlots ?? [],
    surface: surfaces[0] ?? null,
    surfaces,
    courtSurface: resolvedCourtSurface,
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
    accessibility,
    reasons: ranking.reasons ?? [],
    tradeoffs: ranking.tradeoffs ?? [],
    marginalValue: ranking.marginalValue ?? null,
    warnings: [
      ...(candidate.features?.weatherWarning ? [{ feature: 'weather', detail: candidate.features.weatherWarning }] : []),
      ...(candidate.features?.weatherUnknown ? [{ feature: 'weather', detail: 'weather_unknown' }] : []),
    ],
  };
}

function canonicalSurfaceType(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!normalized) return null;
  if (/clay|red clay/.test(normalized)) return 'clay';
  if (/synthetic|artificial/.test(normalized)) return 'synthetic';
  if (/grass|lawn/.test(normalized)) return 'grass';
  if (/hard|acrylic|concrete|asphalt/.test(normalized)) return 'hard';
  return normalized;
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
  const surfaces = venue.surfaces?.length === 1
    ? venue.surfaces
    : venue.surface && !(venue.surfaces?.length > 1)
      ? [venue.surface]
      : [];
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
    venueUrl: venue.venueUrl ?? null,
    courtCount: venue.courtCount ?? null,
    surface: surfaces[0] ?? null,
    surfaces,
    courtSurfaces: venue.courtSurfaces ?? {},
    pricing: venue.pricing ?? null,
    provider: venue.provider ?? null,
    verificationStatus: venue.verificationStatus,
    settings: venue.settings ?? [],
  };
}

function selectNearbyCourts(searchScope = {}, tierOneEntries = [], {
  limit = 5,
  inventory = canonicalVenueInventory(),
} = {}) {
  const requestedSettings = new Set(searchScope.venueSettings ?? []);
  const settingSearch = requestedSettings.size > 0;
  const requestedSurfaces = new Set(searchScope.surfaces ?? []);
  const surfaceSearch = requestedSurfaces.size > 0;
  if (searchScope.locationSource !== 'explicit' && !settingSearch && !surfaceSearch) return [];
  const target = searchScope.targetLocation;
  if (!centerForTarget(target)) return [];

  const excluded = tierOneVenueKeys(tierOneEntries);
  const radiusMeters = Math.max(3000, Math.min(Number(searchScope.radiusMeters ?? target.radiusMeters ?? 3000), 8000));

  return inventory
    .filter((venue) => (
      venue.verificationStatus === 'verified'
      && venue.sport === 'tennis'
      && venue.realtimeAvailability === false
      && (!settingSearch || (venue.settings ?? []).some((setting) => requestedSettings.has(setting)))
      && (!surfaceSearch || (venue.surfaces ?? []).some((surface) => requestedSurfaces.has(surface)))
      && !excluded.has(venue.id)
      && !excluded.has(canonicalVenueKey(venue.name))
    ))
    .map((venue) => ({
      venue,
      distanceKm: nearbyCourtDistanceKm(venue, target),
    }))
    .filter((entry) => Number.isFinite(entry.distanceKm)
      && ((settingSearch || surfaceSearch) && searchScope.locationSource !== 'explicit'
        ? true
        : entry.distanceKm * 1000 <= radiusMeters))
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
  const diversified = result.rankingMode === 'llm_slate'
    ? ranked.slice(0, 10)
    : diversifyRankedCandidates(ranked, {
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
      rankingMode: result.rankingMode ?? null,
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
      source: iteration.source,
      evaluation: compactEvaluation(iteration.evaluation),
      action: iteration.action,
      reason: iteration.reason,
      validationFailure: iteration.validationFailure,
      diagnosticsSummary: iteration.diagnosticsSummary,
      stateBefore: iteration.stateBefore,
      stateAfter: iteration.stateAfter,
      candidateCount: iteration.candidateCount,
      searchScope: iteration.searchScope,
      observation: iteration.observation,
      rankedCandidates: iteration.rankedCandidates,
      factualCandidateFeatures: iteration.factualCandidateFeatures,
    })),
  };
}

async function recommendCourts({
  request,
  currentLocation = null,
  profileLocation = null,
  locationResolver = null,
  mapsProvider = null,
  preferenceProvider = null,
  temporalPolicyProvider = null,
  replannerProvider = null,
  replannerMode = null,
  rankerProvider = null,
  rankerMode = null,
  observeCandidates = null,
  userProfile = null,
  recentBehavior = {},
  now = new Date(),
  maxIterations = null,
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
  const selectedReplannerMode = replannerMode ?? process.env.REPLANNER_MODE ?? 'llm';
  const selectedRankerMode = rankerMode ?? process.env.RANKER_MODE ?? 'llm';
  const selectedMaxIterations = maxIterations ?? Number(process.env.RECOMMEND_MAX_ITERATIONS ?? 3);
  const selectedReplannerProvider = selectedReplannerMode === 'heuristic'
    ? null
    : replannerProvider ?? createOpenAiReplannerProvider();
  const selectedRankerProvider = selectedRankerMode === 'heuristic'
    ? null
    : rankerProvider ?? createOpenAiRankerProvider();
  let requestPreferences;
  try {
    requestPreferences = await interpretPreferences(request, { provider: preferenceProvider, now });
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
    const baseObserve = observeCandidates ?? ((state) => observeRealCandidates(state, {
      signal: budgetController.signal,
      providerTimeoutMs,
      susfProviderTimeoutMs,
    }));
    const result = await runReplanningLoop(initialState, {
      provider: selectedReplannerProvider,
      observe: async (state) => {
        const observed = await baseObserve(state);
        return {
          ...observed,
          candidates: materializeLogicalDurationCandidates(
            observed?.candidates ?? state.candidates,
            state.preferences,
          ).map((candidate) => ({
            ...candidate,
            features: {
              ...candidate.features,
              surface: candidateSurface(candidate),
            },
          })),
        };
      },
      rankerProvider: selectedRankerProvider,
      maxIterations: selectedMaxIterations,
      minCandidates,
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
  applySurfaceScope,
  classifyTemporalSpecificity,
  diversifyRankedCandidates,
  inferPersonalizedTemporalPolicy,
  locationProviderRouting,
  providerOptionsForState,
  materializeLogicalDurationCandidates,
  recommendCourts,
  selectNearbyCourts,
  serializeCandidate,
  serializeNearbyCourt,
  searchScopeForProfileContext,
  searchScopeForProfile,
};
