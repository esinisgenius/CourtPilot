import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialAgentState,
  observeConfiguredAvailabilityProviders,
  runReplanningLoop,
} from '../packages/agent/src/index.mjs';
import {
  locationProviderRouting,
  searchScopeForProfileContext,
  searchScopeForProfile,
} from '../packages/agent/src/recommendation-service.mjs';
import {
  applyCandidateEligibilityGate,
  buildCandidates,
  enrichCandidates,
} from '../packages/core/src/index.mjs';
import { canonicalAvailability, legacyAvailabilityFromCanonical } from '../packages/core/src/availability-schema.mjs';
import { resolveCanonicalLocation } from '../packages/maps/src/index.mjs';
import { normalizePreferenceProfile } from '../packages/preferences/src/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const observedAt = '2026-09-12T09:00:00+10:00';

const tennisProof = Object.freeze({
  sport: { type: 'tennis', proof: 'provider_resource' },
});

const venues = Object.freeze({
  susf: {
    id: 'susf-tennis',
    name: 'Sydney Uni Sport Tennis Courts',
    providerVenueId: 'susf-tennis',
    suburb: 'Camperdown',
    location: { lat: -33.8886, lng: 151.1873 },
  },
  burwood: {
    id: 'sportlogic-burwood-tennis-courts',
    name: 'Burwood Tennis Courts',
    providerVenueId: '1',
    suburb: 'Burwood',
  },
  strathfield: {
    id: 'unified-strathfield-sports-club-tennis',
    name: 'Strathfield Sports Club Tennis',
    providerVenueId: 'ff5fe060-c9a2-11ea-b131-02cc617d54fa',
    suburb: 'Strathfield',
    location: { lat: -33.8791, lng: 151.0836 },
  },
  pymble: {
    id: 'bookable-krg-hamilton-park',
    name: 'Hamilton Park tennis courts',
    providerVenueId: '36',
    suburb: 'Pymble',
  },
  mascot: {
    id: 'bookable-bayside-aloha-street',
    name: 'Aloha Street Tennis Courts',
    providerVenueId: '40',
    suburb: 'Mascot',
    location: { lat: -33.9260254, lng: 151.1934517 },
  },
  moorePark: {
    id: 'intrac-moore-park-tennis-courts',
    name: 'Moore Park Tennis Courts',
    providerVenueId: '72',
    suburb: 'Moore Park',
  },
  golf: {
    id: 'fixture-driving-range',
    name: 'Fixture Driving Range',
    providerVenueId: 'golf-1',
    suburb: 'Burwood',
    location: { lat: -33.876, lng: 151.1 },
  },
});

function slot({
  provider,
  venue,
  courtName = 'Court 1',
  courtId = 'court-1',
  startTime = '2026-09-13T20:30:00',
  durationMinutes = 60,
  price = null,
  nextHourAlsoAvailable = true,
  surface = 'hard',
  eligibility = tennisProof,
} = {}) {
  return legacyAvailabilityFromCanonical(canonicalAvailability({
    provider,
    venue,
    court: {
      id: courtId,
      name: courtName,
      providerCourtId: courtId,
      surface,
    },
    startTime,
    durationMinutes,
    price: { amount: price, currency: 'AUD', confidence: price === null ? 'unknown' : 'verified' },
    eligibility,
    provenance: {
      observedAt,
      availabilityMethod: `${provider}_fixture`,
    },
  }), { nextHourAlsoAvailable });
}

const providerData = Object.freeze({
  susf: [
    slot({ provider: 'susf', venue: venues.susf, courtName: 'Court 4', courtId: 'court-4', startTime: '2026-09-13T18:00:00', price: 29, nextHourAlsoAvailable: true }),
    slot({ provider: 'susf', venue: venues.susf, courtName: 'Court 5', courtId: 'court-5', startTime: '2026-09-12T20:30:00', price: 29, nextHourAlsoAvailable: true }),
  ],
  bookable: [
    slot({ provider: 'bookable', venue: venues.pymble, courtName: 'Hamilton Court 1', courtId: 'hamilton-1', startTime: '2026-09-13T19:00:00', price: 24, nextHourAlsoAvailable: true, surface: 'synthetic grass' }),
    slot({ provider: 'bookable', venue: venues.mascot, courtName: 'Aloha Court 1', courtId: 'aloha-1', startTime: '2026-09-13T19:30:00', price: 25, nextHourAlsoAvailable: true }),
    slot({ provider: 'bookable', venue: venues.mascot, courtName: 'Driving Range Bay 1', courtId: 'bay-1', startTime: '2026-09-13T19:00:00', price: 15, nextHourAlsoAvailable: true, surface: null, eligibility: null }),
  ],
  'unified-bookings': [
    slot({ provider: 'unified-bookings', venue: venues.strathfield, courtName: 'Strathfield Court 1', courtId: 'strathfield-1', startTime: '2026-09-13T20:30:00', price: 22, nextHourAlsoAvailable: true }),
  ],
  sportlogic: [
    slot({ provider: 'sportlogic', venue: venues.burwood, courtName: 'Burwood Court 1', courtId: 'burwood-1', startTime: '2026-09-13T20:30:00', price: 26, nextHourAlsoAvailable: true }),
  ],
  intrac: [
    slot({ provider: 'intrac', venue: venues.moorePark, courtName: 'Moore Park Court 1', courtId: 'moore-1', startTime: '2026-09-13T21:00:00', price: 31, nextHourAlsoAvailable: true }),
  ],
});

function baseProfile(input, overrides = {}) {
  return normalizePreferenceProfile({
    version: 2,
    sourceText: input,
    searchScope: {
      sourceText: input,
      ...(overrides.searchScope ?? {}),
    },
    preferences: overrides.preferences ?? [],
    hardConstraints: overrides.hardConstraints ?? [],
    objectives: overrides.objectives ?? [],
    unresolvedPreferences: overrides.unresolvedPreferences ?? [],
    transportPreference: overrides.transportPreference ?? {},
    weatherPreference: overrides.weatherPreference ?? {},
  }, {
    sourceText: input,
    updatedAt: observedAt,
  });
}

function hard(feature, rule, sourceText) {
  return { feature, type: 'hard', importance: 'high', priority: 'high', rule, sourceText, source: 'user', isExplicit: true };
}

function soft(feature, attrs = {}) {
  return { feature, type: 'soft', importance: attrs.importance ?? 'medium', priority: attrs.priority ?? attrs.importance ?? 'medium', source: 'user', isExplicit: true, ...attrs };
}

function providerOptionsForState(state) {
  const baseOptions = {
    days: Number(state.searchScope?.days ?? 7),
    durationMinutes: Number(state.searchScope?.durationMinutes ?? 60),
  };
  const matchedByProvider = state.searchScope?.locationRouting?.matchedVenuesByProvider ?? {};
  const scoped = {};
  for (const [providerId, matchedVenues] of Object.entries(matchedByProvider)) {
    scoped[providerId] = { ...baseOptions, venues: matchedVenues };
  }
  return Object.keys(scoped).length ? scoped : baseOptions;
}

function makeProviderFetchers({ failures = [], empty = [], forceSingleHourOnly = false } = {}) {
  const failureSet = new Set(failures);
  const emptySet = new Set(empty);
  return Object.fromEntries(Object.entries(providerData).map(([providerId, rows]) => [providerId, async (options = {}) => {
    if (failureSet.has(providerId)) {
      const error = new Error(`Fixture provider failure for ${providerId}`);
      error.code = 'FIXTURE_PROVIDER_FAILED';
      throw error;
    }
    if (emptySet.has(providerId)) return [];
    const venueIds = Array.isArray(options.venues) ? new Set(options.venues.map((venue) => venue.id)) : null;
    const filtered = venueIds ? rows.filter((row) => venueIds.has(row.canonical.venue.id)) : rows;
    if (forceSingleHourOnly) {
      return filtered.map((row) => ({
        ...row,
        nextHourAlsoAvailable: false,
      }));
    }
    return filtered;
  }]));
}

async function fixtureWeatherAdapter({ location, slots }) {
  return slots.map((item) => {
    const unavailable = String(item.startTime).includes('20:30:00');
    if (unavailable) {
      return {
        candidateId: item.id,
        startTime: item.startTime,
        forecastAvailable: false,
        unavailableReason: 'fixture_weather_grid_missing',
        source: location.source ?? 'fixture',
      };
    }
    return {
      candidateId: item.id,
      startTime: item.startTime,
      temperatureC: item.id.includes('susf') ? 31 : 24,
      feelsLikeC: item.id.includes('susf') ? 32 : 24,
      precipitationProbability: 10,
      precipitationMm: 0,
      windKph: 14,
      weatherCode: '0',
      source: 'fixture-open-meteo',
      forecastAvailable: true,
    };
  });
}

async function observeFixtureCandidates(state, options = {}) {
  const observed = await observeConfiguredAvailabilityProviders(state, {
    providerFetchers: makeProviderFetchers(options),
    availabilityOptions: providerOptionsForState(state),
    candidateBuilder: buildCandidates,
  });
  const enriched = await enrichCandidates({
    candidates: observed.candidates,
    weatherAdapter: fixtureWeatherAdapter,
    accessibilityOptions: observed.preferences?.searchScope?.travelOrigin ? { originText: observed.preferences.searchScope.travelOrigin.text } : null,
  });
  const eligibility = applyCandidateEligibilityGate({
    candidates: enriched,
    searchScope: observed.searchScope,
  });
  return {
    ...observed,
    candidates: eligibility.accepted,
    rejectedCandidates: [...(observed.rejectedCandidates ?? []), ...eligibility.rejected],
  };
}

const mockGeocoderRows = Object.freeze({
  Chatswood: {
    label: 'Chatswood NSW 2067, Australia',
    lat: -33.7969,
    lng: 151.1839,
    providerMetadata: { provider: 'fixture_geocoder', resultTypes: ['locality', 'political'], locationType: 'APPROXIMATE', providerStatus: 'OK' },
  },
  Pymble: {
    label: 'Pymble NSW 2073, Australia',
    lat: -33.7439,
    lng: 151.1416,
    providerMetadata: { provider: 'fixture_geocoder', resultTypes: ['locality', 'political'], locationType: 'APPROXIMATE', providerStatus: 'OK' },
  },
  Mascot: {
    label: 'Mascot NSW 2020, Australia',
    lat: -33.925,
    lng: 151.193,
    providerMetadata: { provider: 'fixture_geocoder', resultTypes: ['locality', 'political'], locationType: 'APPROXIMATE', providerStatus: 'OK' },
  },
  '宝活': {
    label: 'Burwood NSW 2134, Australia',
    lat: -33.8775,
    lng: 151.1035,
    providerMetadata: { provider: 'fixture_geocoder', resultTypes: ['locality', 'political'], locationType: 'APPROXIMATE', providerStatus: 'OK' },
  },
  'Macquarie Uni': {
    label: 'Macquarie University NSW 2109, Australia',
    lat: -33.7756,
    lng: 151.1129,
    providerMetadata: { provider: 'fixture_geocoder', resultTypes: ['university', 'establishment', 'point_of_interest'], locationType: 'GEOMETRIC_CENTER', providerStatus: 'OK' },
  },
  'Broadway shopping centre': {
    label: 'Broadway Sydney, 1 Bay Street, Glebe NSW 2037, Australia',
    lat: -33.8843,
    lng: 151.1949,
    providerMetadata: { provider: 'fixture_geocoder', resultTypes: ['shopping_mall', 'establishment', 'point_of_interest'], locationType: 'ROOFTOP', providerStatus: 'OK' },
  },
});

async function mockLocationResolver({ query }) {
  return mockGeocoderRows[query] ?? null;
}

function traceRun(caseDef, profile, result) {
  const scope = result.state.searchScope;
  const rawLocationExpression = profile.searchScope?.targetLocation?.text
    ?? profile.searchScope?.targetArea?.text
    ?? profile.searchScope?.location
    ?? null;
  const canonical = rawLocationExpression ? resolveCanonicalLocation(rawLocationExpression) : null;
  const hardRejects = result.state.rejectedCandidates.flatMap((entry) => entry.reasons ?? [])
  const eligibilityRejects = result.state.rejectedCandidates.flatMap((entry) => entry.reasons ?? [])
    .filter((reason) => ['sport', 'geography'].includes(reason.feature));
  const rankedIds = result.rankedCandidates.map((item) => item.candidateId);
  const candidatesById = new Map(result.state.candidates.map((candidate) => [candidate.id, candidate]));
  const recommendations = rankedIds.slice(0, 3).map((id) => candidatesById.get(id)).filter(Boolean);

  return {
    id: caseDef.id,
    category: caseDef.category,
    rawUserInput: caseDef.input,
    parsedPreferences: profile,
    hardConstraints: profile.hardConstraints,
    softPreferences: profile.preferences,
    rawLocationExpression,
    resolvedTargetLocation: scope.targetLocation ?? null,
    canonicalGeographicEntity: scope.targetLocation?.canonicalName
      ? {
        canonicalName: scope.targetLocation.canonicalName,
        lat: scope.targetLocation.lat,
        lng: scope.targetLocation.lng,
        entityType: scope.targetLocation.kind,
      }
      : null,
    confidence: scope.targetLocation?.confidence ?? null,
    profileLocationParticipated: Boolean(caseDef.context?.profileLocation),
    currentLocationParticipated: Boolean(caseDef.context?.currentLocation),
    geographicSearchScope: {
      targetLocation: scope.targetLocation ?? null,
      locationRouting: scope.locationRouting ?? locationProviderRouting(profile.searchScope),
      radiusMeters: scope.radiusMeters,
    },
    providerRouting: {
      initialProviderIds: scope.providerScope?.initialProviderIds ?? [],
      activeProviderIds: scope.providerScope?.activeProviderIds ?? [],
      expandableProviderIds: scope.providerScope?.expandableProviderIds ?? [],
    },
    rawProviderObservations: result.state.factualObservations?.availability?.providers ?? [],
    rawCandidates: result.iterations.flatMap((iteration) => iteration.factualCandidateFeatures ?? []).map((candidate) => candidate.candidateId),
    venueMetadata: result.state.candidates.map((candidate) => candidate.features?.venue ?? null).filter(Boolean),
    geoEnrichment: result.state.candidates.map((candidate) => ({
      candidateId: candidate.id,
      venue: candidate.venue,
      location: candidate.features?.venue?.location ?? null,
    })),
    weatherEnrichment: result.state.candidates.map((candidate) => ({
      candidateId: candidate.id,
      venue: candidate.venue,
      weather: candidate.features?.weather ?? null,
      weatherUnknown: candidate.features?.weatherUnknown === true,
      weatherWarning: candidate.features?.weatherWarning ?? null,
    })),
    surfacePriceEnrichment: result.state.candidates.map((candidate) => ({
      candidateId: candidate.id,
      surface: candidate.source?.canonicalAvailability?.court?.surface ?? null,
      price: candidate.features?.price ?? null,
      priceOptions: candidate.features?.priceOptions ?? [],
    })),
    eligibilityRejects,
    hardConstraintRejects: hardRejects,
    rankingScoring: result.rankedCandidates,
    replanningActions: result.iterations.map((iteration) => iteration.action),
    finalRecommendations: recommendations.map((candidate) => ({
      id: candidate.id,
      venue: candidate.venue,
      court: candidate.court,
      startTime: candidate.startTime,
      localDate: candidate.features?.localDate,
      localTime: candidate.features?.localTime,
      nextHourAlsoAvailable: candidate.features?.nextHourFree,
      price: candidate.features?.price,
      weather: candidate.features?.weather ?? null,
    })),
    finalAgentStatus: result.status,
    uiOutput: caseDef.uiOutput ?? uiOutputFor(result),
    expectedBehavior: caseDef.expectedBehavior,
  };
}

function uiOutputFor(result) {
  if (result.rankedCandidates.length > 0) return `Real pipeline finished: ${result.status}.`;
  const latest = result.iterations.at(-1);
  return `${result.status}: no ranked candidates returned. ${latest?.action?.rationale ?? 'Check the run summary for provider and replanning state.'}`;
}

function includesVenue(trace, text) {
  return trace.finalRecommendations.some((candidate) => candidate.venue.toLowerCase().includes(text.toLowerCase()));
}

function activeProviders(trace) {
  return trace.providerRouting.activeProviderIds;
}

const cases = [
  {
    id: 'L02-suburb-mascot',
    category: 'location:suburb',
    input: 'Mascot 附近找个周末的场',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Mascot', dateRange: { type: 'weekend' } },
    }),
    expectedBehavior: 'Resolve a southern suburb and keep candidate pool in that target area.',
    expect: (trace) => activeProviders(trace).includes('bookable') && includesVenue(trace, 'Aloha Street'),
  },
  {
    id: 'L03-suburb-chatswood-unseen',
    category: 'location:suburb',
    input: 'Chatswood 那边今晚可以吗',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Chatswood', timeWindow: { period: 'evening' } },
    }),
    expectedBehavior: 'Resolve an unseen Sydney suburb through geocoding or ask only if confidence is low.',
    expect: (trace) => trace.canonicalGeographicEntity?.canonicalName === 'Chatswood' || trace.finalAgentStatus === 'ASKING_USER',
  },
  {
    id: 'L04-natural-cn-burwood',
    category: 'location:natural-language',
    input: '宝活附近，周日晚上八点后，后一小时也最好空着',
    profile: (input) => baseProfile(input, {
      searchScope: { location: '宝活', dateRange: { type: 'weekend' } },
      hardConstraints: [hard('start_time', { after: '20:00' }, '八点后')],
      preferences: [soft('next_hour_free', { target: true, importance: 'high' })],
    }),
    expectedBehavior: 'Resolve common Chinese Burwood wording semantically/geographically, without a one-off alias patch.',
    expect: (trace) => trace.canonicalGeographicEntity?.canonicalName === 'Burwood' || includesVenue(trace, 'Burwood Tennis'),
  },
  {
    id: 'L05-landmark-usyd',
    category: 'location:landmark',
    input: '离 USYD 近一点，17点以后',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'USYD' },
      hardConstraints: [hard('start_time', { after: '17:00' }, '17点以后')],
    }),
    expectedBehavior: 'Resolve USYD as a landmark and include verified nearby tennis options, including SUSF only because it is geographically relevant.',
    expect: (trace) => trace.canonicalGeographicEntity?.canonicalName === 'University of Sydney' && includesVenue(trace, 'Sydney Uni Sport'),
  },
  {
    id: 'L06-station-central',
    category: 'location:landmark',
    input: 'Central 那边，今天晚上',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Central', dateRange: { type: 'today' }, timeWindow: { period: 'evening' } },
    }),
    expectedBehavior: 'Resolve Central Station and search around that anchor instead of declaring the provider scope empty.',
    expect: (trace) => trace.canonicalGeographicEntity?.canonicalName === 'Central Station' && activeProviders(trace).length > 0,
  },
  {
    id: 'L07-university-macquarie',
    category: 'location:landmark',
    input: 'Macquarie Uni 附近，稍微远一点也可以',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Macquarie Uni' },
      preferences: [soft('travel_time', { rule: { maxTransitMinutes: 35 }, relaxationDirection: 'longer_travel_time' })],
      transportPreference: { maxTransitMinutes: 35 },
    }),
    expectedBehavior: 'Resolve an unseen university/POI through geocoding and allow radius/travel relaxation from that anchor.',
    expect: (trace) => Boolean(trace.canonicalGeographicEntity) && trace.finalAgentStatus !== 'MAX_ITERATIONS_REACHED',
  },
  {
    id: 'L08-shopping-centre-broadway',
    category: 'location:poi',
    input: 'Broadway shopping centre 附近的场',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Broadway shopping centre' },
    }),
    expectedBehavior: 'Resolve shopping centre / landmark text with Maps-backed identity or ask if ambiguous.',
    expect: (trace) => Boolean(trace.canonicalGeographicEntity) || trace.finalAgentStatus === 'ASKING_USER',
  },
  {
    id: 'L09-fuzzy-city-nearby',
    category: 'location:fuzzy',
    input: 'city附近都行，不要太贵',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'city附近' },
      preferences: [soft('price', { direction: 'lower', importance: 'high' })],
    }),
    expectedBehavior: 'Map city附近 to Sydney CBD, then use a geographic search scope rather than configured-name matching only.',
    expect: (trace) => trace.canonicalGeographicEntity?.canonicalName === 'Sydney CBD' && trace.finalAgentStatus !== 'MAX_ITERATIONS_REACHED',
  },
  {
    id: 'L10-implicit-profile-location',
    category: 'location:implicit',
    input: '明天晚上帮我找一个便宜的',
    context: { profileLocation: 'Strathfield' },
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Strathfield', dateRange: { type: 'tomorrow' } },
      preferences: [soft('price', { direction: 'lower', importance: 'high' })],
    }),
    expectedBehavior: 'When explicit target is absent, profile preferred location should participate before current location and SUSF fallback.',
    expect: (trace) => trace.profileLocationParticipated && activeProviders(trace).includes('unified-bookings') && includesVenue(trace, 'Strathfield'),
  },
  {
    id: 'L11-implicit-current-location',
    category: 'location:implicit',
    input: '现在附近有没有能打的',
    context: { currentLocation: { lat: -33.8791, lng: 151.0836, label: 'Current location near Strathfield' } },
    profile: (input) => baseProfile(input, {
      searchScope: { dateRange: { type: 'today' } },
    }),
    expectedBehavior: 'With no explicit/profile location, currentLocation should anchor search before Sydney-level fallback; never default to SUSF.',
    expect: (trace) => trace.currentLocationParticipated && !activeProviders(trace).includes('susf') && includesVenue(trace, 'Strathfield'),
  },
  {
    id: 'L12-no-location-sydney-fallback',
    category: 'location:implicit',
    input: '这几天找个便宜的场',
    profile: (input) => baseProfile(input, {
      searchScope: { dateRange: { type: 'next_few_days' } },
      preferences: [soft('price', { direction: 'lower', importance: 'high' })],
    }),
    expectedBehavior: 'With no location sources, use an explicit Sydney-level fallback status and broad provider strategy, not hidden SUSF/USYD default.',
    expect: (trace) => trace.geographicSearchScope.locationRouting?.status === 'sydney_fallback'
      && activeProviders(trace).length > 1
      && trace.geographicSearchScope.targetLocation?.canonicalName === 'Sydney',
  },
  {
    id: 'L13-ambiguous-newtown',
    category: 'location:ambiguous',
    input: 'Newtown 那边或者附近吧',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Newtown' },
    }),
    expectedBehavior: 'Ambiguous or unresolved location should ask for clarification, not expand radius without an anchor.',
    expect: (trace) => trace.finalAgentStatus === 'ASKING_USER' && !trace.replanningActions.some((action) => action.selectedAction === 'EXPAND_RADIUS'),
  },
  {
    id: 'L14-out-of-scope-strathfield',
    category: 'provider-routing',
    input: '我想在 Strathfield 打球，不要混到 USYD',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Strathfield' },
    }),
    expectedBehavior: 'Target-area routing must exclude SUSF/USYD when the target anchor is Strathfield.',
    expect: (trace) => activeProviders(trace).includes('unified-bookings') && !trace.finalRecommendations.some((candidate) => candidate.venue.includes('Sydney Uni')),
  },
  {
    id: 'T15-weekend-sunday-after-8',
    category: 'time',
    input: '周六有事，周日晚上八点后',
    profile: (input) => baseProfile(input, {
      searchScope: { dateRange: { type: 'weekend' } },
      hardConstraints: [
        hard('date', { dateRange: { type: 'specific_date', value: '2026-09-13', sourceText: '周日' } }, '周日'),
        hard('start_time', { after: '20:00' }, '晚上八点后'),
      ],
    }),
    expectedBehavior: 'Honor Sunday-only date semantics after excluding Saturday.',
    expect: (trace) => trace.finalRecommendations.every((candidate) => candidate.localDate === '2026-09-13' && candidate.localTime >= '20:00'),
  },
  {
    id: 'T16-before-13-or-after-17',
    category: 'time',
    input: '13:00前或者17:00后都行',
    profile: (input) => baseProfile(input, {
      hardConstraints: [hard('start_time', { before: '13:00', after: '17:00' }, '13:00前或者17:00后')],
    }),
    expectedBehavior: 'Treat the stated acceptable windows as hard start-time eligibility.',
    expect: (trace) => trace.finalRecommendations.every((candidate) => candidate.localTime < '13:00' || candidate.localTime > '17:00'),
  },
  {
    id: 'T17-hard-continuous-two-hours',
    category: 'time:duration',
    input: '我必须连续打两小时',
    profile: (input) => baseProfile(input, {
      hardConstraints: [hard('consecutive_availability', { minMinutes: 120 }, '必须连续打两小时')],
    }),
    providerOptions: { empty: [], forceSingleHourOnly: true },
    expectedBehavior: 'Hard continuous two-hour requirement must reject single-hour-only candidates.',
    expect: (trace) => trace.finalRecommendations.length === 0 || trace.finalRecommendations.every((candidate) => candidate.nextHourAlsoAvailable === true),
  },
  {
    id: 'P19-soft-weather-unknown-retained',
    category: 'weather',
    input: 'Strathfield，明晚，不要太热',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Strathfield', dateRange: { type: 'tomorrow' } },
      preferences: [soft('weather', { direction: 'avoid', rule: { condition: 'not_too_hot' }, importance: 'medium' })],
    }),
    expectedBehavior: 'Soft weather preference plus weather_unknown should retain real candidates with warning/confidence, not reject all.',
    expect: (trace) => includesVenue(trace, 'Strathfield') && trace.hardConstraintRejects.every((reason) => reason.reason !== 'weather_unknown'),
  },
  {
    id: 'P20-hard-weather-unknown-fail-closed',
    category: 'weather',
    input: 'Strathfield，不下雨才打',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Strathfield' },
      hardConstraints: [hard('weather', { condition: 'no_rain' }, '不下雨才打')],
    }),
    expectedBehavior: 'Hard no-rain requirement can fail closed when all weather sources are unavailable, with clear user-facing status.',
    expect: (trace) => trace.finalRecommendations.length === 0 && trace.hardConstraintRejects.some((reason) => reason.reason === 'weather_unknown'),
  },
  {
    id: 'V21-positive-tennis-proof',
    category: 'provider-integrity',
    input: '便宜的都看看，先审 provider 里的非网球资源',
    profile: (input) => baseProfile(input, {
      searchScope: {
        providerScope: {
          initialProviderIds: ['bookable'],
          activeProviderIds: ['bookable'],
          expandableProviderIds: ['bookable'],
        },
      },
      preferences: [soft('price', { direction: 'lower', importance: 'high' })],
    }),
    expectedBehavior: 'Non-tennis facilities such as golf/driving range must be rejected unless there is positive tennis proof.',
    expect: (trace) => trace.eligibilityRejects.some((reason) => reason.reason === 'sport_eligibility_insufficient') && !includesVenue(trace, 'Driving Range'),
  },
  {
    id: 'F22-provider-partial-failure',
    category: 'failure',
    input: 'Pymble 或附近，今晚',
    profile: (input) => baseProfile(input, {
      searchScope: { location: 'Pymble', timeWindow: { period: 'evening' } },
    }),
    providerOptions: { failures: ['bookable'] },
    expectedBehavior: 'Provider failure should be reported cleanly and not silently fall back to SUSF/USYD.',
    expect: (trace) => trace.rawProviderObservations.some((observation) => observation.status === 'failed') && !includesVenue(trace, 'Sydney Uni Sport'),
  },
];

async function runCase(caseDef) {
  const profile = caseDef.profile(caseDef.input);
  const initialState = createInitialAgentState({
    goal: caseDef.input,
    preferences: profile,
    searchScope: await searchScopeForProfileContext(profile, {
      currentLocation: caseDef.context?.currentLocation,
      profileLocation: caseDef.context?.profileLocation,
      locationResolver: mockLocationResolver,
    }),
    factualObservations: {},
  });
  const result = await runReplanningLoop(initialState, {
    observe: (state) => observeFixtureCandidates(state, caseDef.providerOptions ?? {}),
    maxIterations: 2,
    minCandidates: 1,
  });
  const trace = traceRun(caseDef, profile, result);
  const pass = Boolean(caseDef.expect(trace));
  return {
    ...trace,
    actualBehavior: actualSummary(trace),
    pass,
    failureRootCause: pass ? null : rootCauseFor(caseDef.id),
  };
}

function actualSummary(trace) {
  const venuesText = trace.finalRecommendations.map((candidate) => candidate.venue).join(', ') || 'none';
  const providersText = trace.providerRouting.activeProviderIds.join(', ') || 'none';
  return `${trace.finalAgentStatus}; providers=${providersText}; recommendations=${venuesText}`;
}

function rootCauseFor(id) {
  const causes = {
    L03: 'Location resolution is limited to a small static canonical alias list plus configured venue text matching; no Maps-backed geocoding path is used by the H5 recommendation service.',
    L04: 'Common natural-language/Chinese suburb variants are not semantically interpreted unless prelisted in static aliases.',
    L05: 'SUSF is not part of configuredVenueCatalog routing, so explicit USYD can resolve canonically but still closes provider scope instead of routing to SUSF by geography.',
    L06: 'Canonical landmark resolution does not feed a radius/provider discovery query; provider routing requires configured venue text match.',
    L07: 'Unseen POI/university expressions are not sent to a geocoder in the H5 recommendation path.',
    L08: 'Shopping centre/landmark expressions are unsupported without hardcoded aliases or configured venue name matches.',
    L09: 'Fuzzy city/CBD resolves to a static canonical entity but provider routing cannot use geographic anchors, so it ends in no active providers.',
    L11: 'Recommendation service has no currentLocation input/state path; no-location requests normalize to default provider scope.',
    L12: 'Provider scope defaults to initial susf and has no explicit Sydney-level fallback status or broad provider strategy.',
    L13: 'Unresolved explicit locations are represented as empty provider scope, then replanner mechanically expands radius despite lacking a coordinate anchor.',
    T15: 'Hard filtering supports start_time but not date/day exclusion constraints, so weekend/Saturday-vs-Sunday semantics are not enforced downstream.',
    T17: 'Hard consecutive_availability constraints are parsed/represented but not enforced by applyHardConstraints.',
  };
  return causes[Object.keys(causes).find((prefix) => id.startsWith(prefix))] ?? 'Current behavior diverges from expected product semantics; inspect trace for the responsible layer.';
}

function issueCatalog(results) {
  const failed = results.filter((result) => !result.pass);
  return [
    {
      severity: 'P0',
      layer: 'location resolution/provider routing',
      title: 'Explicit resolvable locations can produce no providers or the wrong default search behavior.',
      rootCause: 'H5 searchScopeForProfile uses static aliases plus configured venue text matching rather than semantic interpretation -> geocoder -> geographic provider discovery.',
      cases: failed.filter((result) => ['L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L13'].some((id) => result.id.startsWith(id))).map((result) => result.id),
    },
    {
      severity: 'P0',
      layer: 'fallback/provider routing',
      title: 'No-location requests default to SUSF/USYD.',
      rootCause: 'normalizeProviderScope defaults initialProviderIds to ["susf"]; recommendation service has no currentLocation/profile-location precedence contract at API boundary.',
      cases: failed.filter((result) => ['L11', 'L12'].some((id) => result.id.startsWith(id))).map((result) => result.id),
    },
    {
      severity: 'P1',
      layer: 'hard constraints',
      title: 'Date/day and continuous-duration hard semantics are not enforced.',
      rootCause: 'applyHardConstraints evaluates weather, transport, and start_time, but does not evaluate date/dateRange or consecutive_availability.',
      cases: failed.filter((result) => ['T15', 'T17'].some((id) => result.id.startsWith(id))).map((result) => result.id),
    },
    {
      severity: 'P1',
      layer: 'enrichment',
      title: 'Weather unknown can remove all candidates under hard weather constraints.',
      rootCause: 'This is intentional fail-closed for hard no-rain, but UI/replanning need a user-facing weather-unavailable status instead of opaque no-results.',
      cases: failed.filter((result) => result.id === 'P20-hard-weather-unknown-fail-closed').map((result) => result.id),
    },
    {
      severity: 'P2',
      layer: 'UI/state',
      title: 'The H5 demo exposes internal statuses and replanner rationale.',
      rootCause: 'preferences-panel.js renders raw response.status, provider ids, evaluator/replanner status, and internal error text directly.',
      cases: [],
    },
  ].filter((issue) => issue.cases.length > 0);
}

function summarize(results) {
  const passCount = results.filter((result) => result.pass).length;
  return {
    generatedAt: new Date().toISOString(),
    total: results.length,
    passCount,
    failCount: results.length - passCount,
    passRate: passCount / results.length,
    issues: issueCatalog(results),
    sharedRootCauses: [
      {
        rootCause: 'Static alias/configured-venue-name location architecture instead of semantic+geocoder canonicalization.',
        failingCases: results.filter((result) => ['L03', 'L04', 'L06', 'L07', 'L08', 'L09', 'L13'].some((id) => result.id.startsWith(id))).map((result) => result.id),
      },
      {
        rootCause: 'SUSF-first provider registry default and missing request/context location precedence.',
        failingCases: results.filter((result) => ['L11', 'L12'].some((id) => result.id.startsWith(id))).map((result) => result.id),
      },
      {
        rootCause: 'Hard constraint evaluator does not cover date/day or consecutive availability.',
        failingCases: results.filter((result) => ['T15', 'T17'].some((id) => result.id.startsWith(id))).map((result) => result.id),
      },
    ],
    susfUsydBias: {
      sources: [
        'Current audit no longer finds SUSF as a hidden initial-provider fallback.',
        'No-location requests now use an explicit Sydney fallback scope with multiple active providers.',
        'SUSF/USYD can still appear for CBD/Central/Broadway because the configured SUSF venue has real coordinates inside the search radius.',
        'Remaining ranking fairness depends on completing geo metadata for non-SUSF providers, because some configured venues still lack coordinates.',
      ],
      notObserved: [
        'No explicit venue/provider bonus was found in fallback ranking.',
      ],
    },
    strathfieldWeatherUnknown: {
      source: 'Fixture reproduces the current failure class: weather rows unavailable for Strathfield across venue/suburb/Sydney fallback produce forecastAvailable=false.',
      codePath: 'enrichCandidates -> weatherRowsWithFallback -> applyHardConstraints/evaluateWeather.',
      semantics: 'Soft weather preference keeps the candidate with weatherUnknown; hard no_rain rejects with reason weather:weather_unknown.',
    },
    hardcodedAliasDependency: {
      currentArchitecture: true,
      evidence: 'packages/maps/src/canonical-locations.mjs contains a small static CANONICAL_LOCATIONS alias list; H5 searchScopeForProfile calls resolveCanonicalLocation synchronously and does not call resolveLocation/GoogleMapsProvider.',
    },
    architectureLimitations: [
      'No H5 API contract for currentLocation/profile preferred location precedence.',
      'No canonical geographic entity schema with entityType/confidence from a geocoder in recommendation-service output.',
      'Provider routing is catalog string matching, not radius-based venue discovery from a resolved anchor.',
      'SearchScope targetLocation is also used as travelOrigin only when profile.searchScope.travelOrigin exists; the audit did not find direct targetLocation reuse in accessibilityOptionsForProfile, but the API does not clearly separate the fields for the UI.',
      'Hard constraints lack date/day and continuous-slot enforcement.',
      'UI state mapping is raw/internal rather than user-facing.',
    ],
    recommendedFixOrder: [
      'Wire production H5 geocoding provider configuration so live requests use Maps-backed resolution when static canonical shortcuts miss.',
      'Normalize venue geo metadata across non-SUSF providers to improve Sydney fallback coverage and ranking fairness.',
      'Add parser evals for day-specific constraints such as 周六有事，周日晚上八点后 so hard date rules are reliably produced.',
      'Map internal statuses to user-facing UI states: location unresolved, provider unavailable, no matching courts, weather unavailable, constraints too strict.',
    ],
  };
}

function markdownReport(summary, results) {
  const rows = results.map((result) => `| ${result.id} | ${result.category} | ${result.pass ? 'PASS' : 'FAIL'} | ${result.actualBehavior.replaceAll('|', '/')} | ${result.failureRootCause?.replaceAll('|', '/') ?? ''} |`).join('\n');
  const issues = summary.issues.map((issue) => `- ${issue.severity} ${issue.layer}: ${issue.title} Cases: ${issue.cases.join(', ')}. Root cause: ${issue.rootCause}`).join('\n');
  return `# H5 Golden QA Audit

Generated: ${summary.generatedAt}

Pass rate: ${summary.passCount}/${summary.total} (${Math.round(summary.passRate * 100)}%)

## Cases

| Case | Category | Result | Actual behavior | Failure root cause |
| --- | --- | --- | --- | --- |
${rows}

## Issues

${issues}

## SUSF / USYD Bias

${summary.susfUsydBias.sources.map((item) => `- ${item}`).join('\n')}

## Strathfield Weather Unknown

- Source: ${summary.strathfieldWeatherUnknown.source}
- Code path: ${summary.strathfieldWeatherUnknown.codePath}
- Semantics: ${summary.strathfieldWeatherUnknown.semantics}

## Recommended Minimum Fix Order

${summary.recommendedFixOrder.map((item, index) => `${index + 1}. ${item}`).join('\n')}
`;
}

const results = [];
for (const caseDef of cases) {
  results.push(await runCase(caseDef));
}

const summary = summarize(results);
const payload = { summary, results };
const jsonPath = resolve(__dirname, 'h5-golden-audit-results.json');
const mdPath = resolve(__dirname, 'h5-golden-audit-report.md');
await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
await writeFile(mdPath, markdownReport(summary, results), 'utf8');

console.log(`H5 golden QA audit: ${summary.passCount}/${summary.total} passed (${Math.round(summary.passRate * 100)}%).`);
console.log(`JSON: ${jsonPath}`);
console.log(`Report: ${mdPath}`);
