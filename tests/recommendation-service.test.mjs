import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySurfaceScope,
  buildPreferredTemporalPolicy,
  classifyTemporalSpecificity,
  diversifyRankedCandidates,
  inferPersonalizedTemporalPolicy,
  locationProviderRouting,
  materializeLogicalDurationCandidates,
  providerOptionsForState,
  recommendCourts,
  searchScopeForProfile,
  searchScopeForProfileContext,
  selectNearbyCourts,
  serializeCandidate,
  serializeNearbyCourt,
} from '../packages/agent/src/recommendation-service.mjs';
import { normalizePreferenceProfile } from '../packages/preferences/src/index.mjs';
import { applyHardConstraints } from '../packages/core/src/index.mjs';

function rankedEntry({ id, rank, venue, startTime, price = 20 }) {
  return {
    ranking: { candidateId: id, rank, reasons: [], tradeoffs: [] },
    candidate: {
      id,
      venue,
      court: `Court ${id}`,
      startTime,
      durationMinutes: 60,
      features: {
        localDate: startTime.slice(0, 10),
        localTime: startTime.slice(11, 16),
        price,
      },
    },
  };
}

test('explicit Burwood location routes initial provider scope to configured Burwood provider', () => {
  const searchScope = {
    days: 7,
    location: 'burwood附近',
    timeWindow: { after: '20:00' },
  };

  const routing = locationProviderRouting(searchScope);
  assert.equal(routing.status, 'matched_geographic_scope');
  assert.equal(routing.activeProviderIds.includes('sportlogic'), true);
  assert.equal(routing.matchedVenues.some((venue) => venue.name === 'Burwood Tennis Courts'), true);

  const routedScope = searchScopeForProfile({ searchScope });
  assert.equal(routedScope.providerScope.activeProviderIds.includes('sportlogic'), true);
  assert.equal(routedScope.providerScope.initialProviderIds.includes('sportlogic'), true);
  assert.equal(routedScope.targetLocation.text, 'burwood附近');
  assert.equal(routedScope.targetLocation.canonicalName, 'Burwood');
  assert.deepEqual(routedScope.targetLocation.center, { lat: -33.8775, lng: 151.1035 });
});

test('Strathfield before-or-after request routes locally without lossy temporal narrowing', () => {
  const profile = normalizePreferenceProfile({
    version: 2,
    searchWindowDays: 7,
    searchScope: {},
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
  }, {
    sourceText: 'Strathfield 最近几天，13:00 前或者17:00后都行',
    updatedAt: '2026-09-20T02:00:00.000Z',
  });
  const routedScope = searchScopeForProfile(profile);
  const options = providerOptionsForState({
    searchScope: routedScope,
    preferences: { ...profile, searchScope: routedScope },
  });

  assert.equal(routedScope.targetLocation.canonicalName, 'Strathfield');
  assert.equal(routedScope.locationRouting.status, 'matched_geographic_scope');
  assert.equal(routedScope.locationRouting.matchedVenues.some((venue) => venue.id === 'unified-strathfield-sports-club-tennis'), true);
  assert.equal(routedScope.providerScope.activeProviderIds.includes('unified-bookings'), true);
  assert.equal(routedScope.providerScope.activeProviderIds.includes('susf'), false);
  assert.equal(routedScope.temporalWindow.dateStart, '2026-09-20');
  assert.equal(routedScope.temporalWindow.dateEnd, '2026-09-22');
  assert.equal(routedScope.temporalWindow.timeStart, null);
  assert.equal(routedScope.temporalWindow.timeEnd, null);
  assert.deepEqual(routedScope.temporalWindow.timeWindows, [
    { start: '00:00', end: '13:00' },
    { start: '17:00', end: '23:59' },
  ]);
  assert.equal(Array.isArray(options['unified-bookings']), true);
  assert.deepEqual(options['unified-bookings'].map((item) => ({
    timeStart: item.timeStart,
    timeEnd: item.timeEnd,
  })), [
    { timeStart: undefined, timeEnd: '13:00' },
    { timeStart: '17:00', timeEnd: undefined },
  ]);
  assert.equal(options['unified-bookings'].some((item) => item.timeStart === '17:00' && item.timeEnd === '13:00'), false);

  const candidates = ['12:30', '14:00', '17:00'].map((time, index) => ({
    id: `or-${index}`,
    venue: 'Strathfield Sports Club Tennis',
    court: 'Court 1',
    startTime: `2026-09-21T${time}:00+10:00`,
    durationMinutes: 60,
    features: { localDate: '2026-09-21', localTime: time },
  }));
  const filtered = applyHardConstraints({ candidates, preferenceProfile: { ...profile, searchScope: routedScope } });
  assert.deepEqual(filtered.accepted.map((item) => item.features.localTime), ['12:30', '17:00']);
  assert.deepEqual(filtered.rejected.map((item) => item.candidate.features.localTime), ['14:00']);
});

test('next Monday remains an exact date through hard filtering', () => {
  const profile = normalizePreferenceProfile({
    version: 2,
    searchScope: { dateRange: { type: 'next_week', sourceText: '下周一' } },
    preferences: [],
    hardConstraints: [{
      feature: 'date', type: 'hard', importance: 'high', relaxable: false,
      rule: { dateRange: { type: 'next_week', sourceText: '下周一' } }, sourceText: '下周一',
    }],
    objectives: [], unresolvedPreferences: [],
  }, { sourceText: '下周一早上想在悉大附近打两个小时', updatedAt: '2026-09-20T02:00:00.000Z' });
  const scope = searchScopeForProfile(profile, { now: new Date('2026-09-20T02:00:00.000Z') });
  assert.equal(profile.searchScope.dateRange.type, 'specific_date');
  assert.equal(scope.temporalWindow.dateStart, '2026-09-21');
  assert.equal(scope.temporalWindow.dateEnd, '2026-09-21');
  const candidates = ['2026-09-22', '2026-09-21'].map((date) => ({
    id: date, venue: 'SUSF', court: 'Court 4', startTime: `${date}T10:00:00+10:00`, durationMinutes: 60,
    features: { localDate: date, localTime: '10:00', weekday: date === '2026-09-21' ? 'Mon' : 'Tue' },
  }));
  const filtered = applyHardConstraints({ candidates, preferenceProfile: { ...profile, searchScope: scope } });
  assert.deepEqual(filtered.accepted.map((item) => item.id), ['2026-09-21']);
});

test('two adjacent 60-minute slots become a 120-minute final recommendation', async () => {
  const base = ['10:00', '11:00'].map((time, index) => ({
    id: `slot-${index}`,
    venue: 'SUSF',
    court: 'Court 4',
    startTime: `2026-09-21T${time}:00+10:00`,
    durationMinutes: 60,
    features: { localDate: '2026-09-21', localTime: time, nextHourFree: index === 0, price: 20 },
    source: { provider: 'susf' },
  }));
  const profile = normalizePreferenceProfile({
    version: 2, searchScope: { dateRange: { type: 'tomorrow', sourceText: '明天' } }, preferences: [],
    hardConstraints: [{ feature: 'consecutive_availability', type: 'hard', importance: 'high', relaxable: false, rule: { minMinutes: 120 }, sourceText: '打两个小时' }],
    objectives: [], unresolvedPreferences: [],
  }, { sourceText: '明天打两个小时', updatedAt: '2026-09-20T02:00:00.000Z' });
  const logical = materializeLogicalDurationCandidates(base, profile);
  assert.equal(logical.length, 1);
  assert.equal(logical[0].durationMinutes, 120);
  assert.deepEqual(logical[0].componentSlots.map((item) => item.id), ['slot-0', 'slot-1']);

  const result = await recommendCourts({
    request: '明天打两个小时',
    now: new Date('2026-09-20T02:00:00.000Z'),
    preferenceProvider: { async interpret() { return profile; } },
    replannerMode: 'heuristic',
    observeCandidates: async () => ({ candidates: base }),
    maxIterations: 1,
  });
  assert.equal(result.candidates[0].durationMinutes, 120);
  assert.equal(result.candidates[0].endTime, '2026-09-21T02:00:00.000Z');
  assert.equal(result.candidates[0].componentSlots.length, 2);
});

test('recommendation service preserves the LLM-selected slate order', async () => {
  const profile = normalizePreferenceProfile({
    version: 2,
    searchScope: { days: 2 },
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
  }, { sourceText: '明天早上想在悉大或者city打球', updatedAt: '2026-09-20T02:00:00.000Z' });
  const candidates = [
    { id: 'usyd-1000', venue: 'USYD', court: 'Court 4', startTime: '2026-09-21T10:00:00+10:00' },
    { id: 'usyd-1015', venue: 'USYD', court: 'Court 4', startTime: '2026-09-21T10:15:00+10:00' },
    { id: 'city-1000', venue: 'City', court: 'Court 1', startTime: '2026-09-21T10:00:00+10:00' },
    { id: 'usyd-0800', venue: 'USYD', court: 'Court 1', startTime: '2026-09-21T08:00:00+10:00' },
  ].map((item) => ({
    ...item,
    durationMinutes: 60,
    features: {
      localDate: '2026-09-21',
      localTime: item.startTime.slice(11, 16),
      nextHourFree: false,
      price: null,
    },
    source: { provider: 'fixture', availability: { status: 'verified', source: 'fixture' } },
  }));

  const result = await recommendCourts({
    request: '明天早上想在悉大或者city打球',
    now: new Date('2026-09-20T02:00:00.000Z'),
    preferenceProvider: { async interpret() { return profile; } },
    replannerMode: 'heuristic',
    rankerProvider: ({ input }) => ({
      rankedCandidates: ['usyd-1000', 'city-1000', 'usyd-0800', 'usyd-1015'].map((candidateId, index) => ({
        candidateId,
        rank: index + 1,
        reasons: ['Feasible preference match.'],
        tradeoffs: ['No known price fact.'],
        marginalValue: index === 0
          ? 'Strongest overall match.'
          : 'Adds a meaningfully different choice to the slate.',
      })),
    }),
    observeCandidates: async () => ({ candidates }),
    maxIterations: 1,
  });

  assert.equal(result.summary.rankingMode, 'llm_slate');
  assert.deepEqual(result.candidates.slice(0, 3).map((item) => item.id), [
    'usyd-1000',
    'city-1000',
    'usyd-0800',
  ]);
  assert.match(result.candidates[1].marginalValue, /different choice/);
});

test('explicit CBD provider options never fall back to all Bookable venues', () => {
  const routedScope = searchScopeForProfile({
    searchScope: {
      days: 7,
      location: 'city',
      locationSource: 'explicit',
    },
  });
  const stateWithInvalidExpansion = {
    searchScope: {
      ...routedScope,
      providerScope: {
        ...routedScope.providerScope,
        activeProviderIds: [...routedScope.providerScope.activeProviderIds, 'bookable'],
      },
    },
    preferences: { searchScope: routedScope },
  };

  const options = providerOptionsForState(stateWithInvalidExpansion);

  assert.deepEqual(options.bookable.venues, []);
  assert.equal(options.susf.venues.some((venue) => venue.id === 'susf-tennis'), true);
});

test('temporal specificity treats narrow canonical windows as explicit', () => {
  const result = classifyTemporalSpecificity({
    searchScope: {
      temporalWindow: { timeStart: '17:00', timeEnd: '19:00' },
    },
  });

  assert.equal(result.modeCandidate, 'explicit');
});

test('temporal specificity treats open-ended time constraints as broad', () => {
  const result = classifyTemporalSpecificity({
    searchScope: {
      temporalWindow: { timeStart: '10:00', timeEnd: null },
      timeWindow: { after: '10:00' },
    },
  });

  assert.equal(result.modeCandidate, 'broad');
});

test('first-time temporal policy uses cold start for broad requests', async () => {
  const policy = await buildPreferredTemporalPolicy({
    requestPreferences: {
      sourceText: 'anytime tomorrow',
      updatedAt: '2026-09-16T00:00:00.000Z',
      searchScope: {
        temporalWindow: { dateStart: '2026-09-17', dateEnd: '2026-09-17', timeStart: null, timeEnd: null },
      },
      preferences: [],
      objectives: [],
      hardConstraints: [],
    },
    userProfile: null,
    recentBehavior: {},
  });

  assert.equal(policy.mode, 'cold_start');
});

test('personalized temporal policy uses persistent user profile time evidence', async () => {
  const policy = await buildPreferredTemporalPolicy({
    requestPreferences: {
      sourceText: 'anytime tomorrow',
      updatedAt: '2026-09-16T00:00:00.000Z',
      searchScope: {
        temporalWindow: { dateStart: '2026-09-17', dateEnd: '2026-09-17', timeStart: null, timeEnd: null },
      },
      preferences: [],
      objectives: [],
      hardConstraints: [],
    },
    userProfile: {
      preferredTimeWindows: [{ start: '17:00', end: '20:00' }],
      preferences: [{
        feature: 'start_time',
        type: 'soft',
        importance: 'high',
        priority: 'high',
        rule: { period: 'evening' },
        sourceText: 'preferred time window',
        persistence: 'persistent',
      }],
      objectives: [],
      hardConstraints: [],
    },
  });

  assert.equal(policy.mode, 'personalized');
  assert.equal(policy.confidence, 'medium');
  assert.deepEqual(policy.preferredWindows[0], { start: '17:00', end: '20:00', priority: 1 });
  assert.ok(policy.evidenceUsed.some((item) => item.startsWith('userProfile_')));
});

test('personalized temporal policy preserves before-or-after user profile windows', async () => {
  const policy = await buildPreferredTemporalPolicy({
    requestPreferences: {
      sourceText: '13点前或者17点以后都行',
      updatedAt: '2026-09-16T00:00:00.000Z',
      searchScope: {
        temporalWindow: { timeStart: null, timeEnd: null },
      },
      preferences: [],
      objectives: [],
      hardConstraints: [],
    },
    userProfile: {
      preferences: [{
        feature: 'start_time',
        type: 'soft',
        importance: 'medium',
        priority: 'medium',
        rule: { before: '13:00', after: '17:00' },
      }],
      objectives: [],
      hardConstraints: [],
    },
  });

  assert.equal(policy.mode, 'personalized');
  assert.deepEqual(policy.preferredWindows.slice(0, 2), [
    { start: '00:00', end: '13:00', priority: 1 },
    { start: '17:00', end: '23:59', priority: 2 },
  ]);
});

test('low-confidence temporal personalization falls back to cold start', async () => {
  const policy = await buildPreferredTemporalPolicy({
    requestPreferences: {
      sourceText: 'anytime tomorrow',
      searchScope: { temporalWindow: { timeStart: null, timeEnd: null } },
      preferences: [],
      objectives: [],
      hardConstraints: [],
    },
    userProfile: {
      preferences: [{
        feature: 'start_time',
        type: 'soft',
        importance: 'low',
        priority: 'low',
        rule: { period: 'morning' },
      }],
      objectives: [],
      hardConstraints: [],
    },
  });

  assert.equal(policy.mode, 'cold_start');
  assert.deepEqual(policy.preferredWindows[0], { start: '10:00', end: '12:00', priority: 1 });
});

test('booking behavior summary can produce high-confidence personalized temporal policy', () => {
  const policy = inferPersonalizedTemporalPolicy({
    userProfile: null,
    recentBehavior: {
      bookingClickCount: 5,
      timeBuckets: { morning: 1, daytime: 0, evening: 4 },
      dominantTimeBucket: 'evening',
      confidence: 'high',
    },
  });

  assert.equal(policy.mode, 'personalized');
  assert.equal(policy.confidence, 'high');
  assert.deepEqual(policy.preferredWindows[0], { start: '17:00', end: '20:00', priority: 1 });
  assert.ok(policy.evidenceUsed.some((item) => item.startsWith('booking_behavior_')));
});

test('explicit current query overrides stored temporal personalization', async () => {
  const policy = await buildPreferredTemporalPolicy({
    requestPreferences: {
      sourceText: 'tomorrow 10:00-11:00',
      searchScope: {
        temporalWindow: {
          dateStart: '2026-09-17',
          dateEnd: '2026-09-17',
          timeStart: '10:00',
          timeEnd: '11:00',
        },
      },
      preferences: [],
      objectives: [],
      hardConstraints: [],
    },
    userProfile: {
      preferredTimeWindows: [{ start: '17:00', end: '20:00' }],
    },
    recentBehavior: {
      bookingClickCount: 5,
      timeBuckets: { morning: 0, daytime: 0, evening: 5 },
      dominantTimeBucket: 'evening',
    },
  });

  assert.equal(policy.mode, 'explicit');
  assert.deepEqual(policy.preferredWindows[0], { start: '10:00', end: '11:00', priority: 1 });
});

test('missing location uses Sydney-wide routing without defaulting provider order to SUSF', () => {
  const routedScope = searchScopeForProfile({
    searchScope: {
      days: 7,
    },
  });

  assert.equal(routedScope.locationSource, 'sydney_fallback');
  assert.notEqual(routedScope.providerScope.activeProviderIds[0], 'susf');
});

test('unmatched explicit location closes provider scope instead of falling back to SUSF', () => {
  const routedScope = searchScopeForProfile({
    searchScope: {
      days: 7,
      location: 'some unknown tennis suburb',
    },
  });

  assert.equal(routedScope.locationRouting.status, 'unresolved');
  assert.deepEqual(routedScope.providerScope.activeProviderIds, []);
  assert.deepEqual(routedScope.providerScope.expandableProviderIds, []);
});

test('explicit resolved Zetland scope is centered on Zetland and does not inherit USYD bias', async () => {
  const routedScope = await searchScopeForProfileContext({
    searchScope: {
      days: 7,
      location: 'Zetland',
      radiusMeters: 35000,
      source: 'user',
      isExplicit: true,
    },
  }, {
    locationResolver: () => ({
      canonicalName: 'Zetland',
      center: { lat: -33.907, lng: 151.208 },
      radiusMeters: 3000,
      kind: 'suburb',
      source: 'fixture_geocoder',
    }),
  });

  assert.equal(routedScope.targetLocation.canonicalName, 'Zetland');
  assert.deepEqual(routedScope.locationRouting.center, { lat: -33.907, lng: 151.208 });
  assert.equal(routedScope.locationRouting.radiusMeters, 3000);
  assert.equal(routedScope.providerScope.activeProviderIds[0], 'intrac');
  assert.notEqual(routedScope.providerScope.activeProviderIds[0], 'susf');
});

test('city input does not match Blacktown City Council venues', () => {
  const searchScope = {
    days: 7,
    location: 'city',
    sourceText: '在 city 打',
    source: 'user',
    isExplicit: true,
  };

  const routing = locationProviderRouting(searchScope);
  assert.equal(routing.status, 'matched_geographic_scope');
  assert.equal(routing.matchedVenues.some((venue) => venue.name.includes('Blacktown')), false);

  const routedScope = searchScopeForProfile({ searchScope });
  assert.equal(routedScope.locationRouting.status, 'matched_geographic_scope');
  assert.equal(routedScope.targetLocation.text, 'city');
  assert.equal(routedScope.targetLocation.canonicalName, 'Sydney CBD');
  assert.equal(routedScope.providerScope.activeProviderIds.includes('susf'), true);
});

test('city or USYD keeps both explicit location scopes without Sydney-wide fallback', () => {
  const sourceText = '周一我想在city或悉大打球，不要太热';
  const profile = normalizePreferenceProfile({
    version: 2,
    searchWindowDays: 7,
    searchScope: {
      days: 7,
      location: null,
      sourceText: '',
    },
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
    sourceText: '',
    updatedAt: '2026-09-19T00:00:00+10:00',
  }, { sourceText, updatedAt: '2026-09-19T00:00:00+10:00' });

  const routedScope = searchScopeForProfile(profile);
  const matchedNames = routedScope.locationRouting.matchedVenues.map((venue) => venue.name);

  assert.equal(profile.searchScope.sourceText, sourceText);
  assert.equal(routedScope.locationSource, 'explicit');
  assert.equal(routedScope.locationRouting.status, 'matched_geographic_scope');
  assert.deepEqual(
    routedScope.locationRouting.targets.map((target) => target.canonicalName),
    ['Sydney CBD', 'University of Sydney'],
  );
  assert.equal(matchedNames.includes('Sydney Uni Sport Tennis Courts'), true);
  assert.equal(matchedNames.includes('Camperdown Tennis'), true);
  assert.equal(matchedNames.includes('Aloha Street Tennis Courts'), false);
  assert.equal(matchedNames.includes('Burwood Tennis Courts'), false);
});

test('compound city-or-USYD location text resolves before the primary target is rejected', () => {
  const routedScope = searchScopeForProfile({
    updatedAt: '2026-09-19T00:00:00+10:00',
    searchScope: {
      days: 7,
      location: 'city或悉大',
      sourceText: '周一我想在city或悉大打球，不要太热',
      source: 'user',
      isExplicit: true,
    },
  });

  assert.equal(routedScope.locationRouting.status, 'matched_geographic_scope');
  assert.equal(routedScope.providerScope.activeProviderIds.includes('susf'), true);
  assert.equal(
    routedScope.locationRouting.matchedVenues.some((venue) => venue.name === 'Aloha Street Tennis Courts'),
    false,
  );
});

test('CBD downtown and Chinese city-centre variants normalize to Sydney CBD', () => {
  for (const location of ['CBD', 'downtown', '市中心', '悉尼市区']) {
    const routedScope = searchScopeForProfile({
      searchScope: {
        days: 7,
        location,
        source: 'user',
        isExplicit: true,
      },
    });

    assert.equal(routedScope.targetLocation.canonicalName, 'Sydney CBD');
    assert.deepEqual(routedScope.targetLocation.center, { lat: -33.8688, lng: 151.2093 });
  }
});

test('explicit CBD recommendation includes nearby static verified courts without fake slots', () => {
  const routedScope = searchScopeForProfile({
    searchScope: {
      days: 3,
      location: 'CBD',
      source: 'user',
      isExplicit: true,
    },
  });

  const nearby = selectNearbyCourts(routedScope, [], { limit: 5 });
  assert.equal(nearby.length >= 1, true);
  assert.equal(nearby.some((venue) => venue.venue === 'Prince Alfred Park Tennis Courts'), true);

  for (const venue of nearby) {
    assert.equal(venue.liveAvailability, false);
    assert.equal(venue.realtimeAvailability, false);
    assert.equal(venue.court, null);
    assert.equal(venue.startTime, null);
    assert.equal(venue.endTime, null);
    assert.equal(venue.price, null);
    assert.equal(venue.verificationStatus, 'verified');
    assert.equal(Number.isFinite(venue.distanceKm), true);
  }
});

test('coastal semantic preference recalls tagged realtime venues without treating it as a location', () => {
  const profile = normalizePreferenceProfile({
    version: 2,
    searchScope: { days: 7 },
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
  }, { sourceText: '海边风景好的网球场' });
  const routedScope = searchScopeForProfile(profile);
  const matchedNames = routedScope.locationRouting.matchedVenues.map((venue) => venue.name);

  assert.equal(routedScope.locationSource, 'sydney_fallback');
  assert.deepEqual(routedScope.venueSettings, ['coastal', 'scenic']);
  assert.equal(matchedNames.includes('Collaroy Tennis Club'), true);
  assert.equal(matchedNames.includes('Pinecourt Tennis Club'), true);
  assert.equal(matchedNames.includes('Kiama Blowhole Tennis Club'), true);
  assert.equal(matchedNames.includes('Burwood Tennis Courts'), false);
});

test('scenic semantic preference returns tagged static venues as nearby courts without fake slots', () => {
  const profile = normalizePreferenceProfile({
    version: 2,
    searchScope: { days: 7 },
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
  }, { sourceText: '找个风景好的球场' });
  const routedScope = searchScopeForProfile(profile);
  const nearby = selectNearbyCourts(routedScope, [], { limit: 5 });

  assert.equal(nearby.some((venue) => venue.venue === 'Baker Park Tennis Courts'), true);
  assert.equal(nearby.some((venue) => venue.venue === 'The Langham Sydney Tennis Court'), true);
  for (const venue of nearby) {
    assert.equal(venue.liveAvailability, false);
    assert.equal(venue.startTime, null);
    assert.equal(venue.price, null);
  }
});

test('surface semantic preference narrows realtime recall to matching venue metadata', () => {
  const profile = normalizePreferenceProfile({
    version: 2,
    searchScope: { days: 7 },
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
  }, { sourceText: 'Find me a Hard Court' });
  const routedScope = searchScopeForProfile(profile);
  const matchedNames = routedScope.locationRouting.matchedVenues.map((venue) => venue.name);

  assert.deepEqual(routedScope.surfaces, ['hard']);
  assert.equal(matchedNames.includes('Pinecourt Tennis Club'), true);
  assert.equal(matchedNames.includes('Kiama Blowhole Tennis Club'), false);
  assert.equal(matchedNames.includes('Burwood Tennis Courts'), true);
});

test('serialized cards show only a selected court surface or a single known venue surface', () => {
  const serialized = serializeCandidate({
    ranking: { candidateId: 'pinecourt-slot', rank: 1, reasons: [], tradeoffs: [] },
    candidate: {
      id: 'pinecourt-slot',
      venue: 'Pinecourt Tennis Club',
      court: 'Court 1',
      startTime: '2026-09-20T10:00:00+10:00',
      durationMinutes: 60,
      booking: { url: null, capability: null, provider: 'clubspark' },
      features: { localDate: '2026-09-20', localTime: '10:00', price: 20 },
      source: {
        provider: 'clubspark',
        availability: { source: 'live' },
        canonicalAvailability: {
          venue: { id: 'clubspark-pinecourt-tennis-club' },
          court: { surface: null },
          price: { currency: 'AUD' },
          provenance: { source: 'live' },
        },
      },
    },
  });
  assert.deepEqual(serialized.surfaces, ['hard']);
  assert.equal(serialized.surface, 'hard');

  const meadowbank = serializeCandidate({
    ranking: { candidateId: 'meadowbank-clay-slot', rank: 1, reasons: [], tradeoffs: [] },
    candidate: {
      id: 'meadowbank-clay-slot',
      venue: 'Meadowbank Park Tennis Centre',
      court: 'Court 3 (Clay Court)',
      startTime: '2026-09-20T10:00:00+10:00',
      durationMinutes: 60,
      booking: {
        url: 'https://www.tennisvenues.com.au/booking/meadowbank-park-tc',
        capability: 'court_date_time_preselected',
        provider: 'sportlogic',
      },
      features: { localDate: '2026-09-20', localTime: '10:00', price: 29 },
      source: {
        provider: 'sportlogic',
        availability: { source: 'live' },
        canonicalAvailability: {
          venue: { id: 'sportlogic-meadowbank-park-tennis-centre' },
          court: { surface: null },
          price: { currency: 'AUD' },
          provenance: { source: 'live' },
        },
      },
    },
  });
  assert.equal(meadowbank.courtSurface, 'clay');
  assert.deepEqual(meadowbank.surfaces, ['clay']);

  const mutchPark = serializeNearbyCourt({
    id: 'static-mutch-park-tennis-centre',
    name: 'Mutch Park Tennis Centre',
    suburb: 'Pagewood',
    area: 'Eastern Suburbs',
    surfaces: ['synthetic', 'hard'],
    surface: 'synthetic',
    courtSurfaces: {},
    realtimeAvailability: false,
    verificationStatus: 'verified',
    booking: { url: null, capability: null },
  }, 2.3);
  assert.equal(mutchPark.surface, null);
  assert.deepEqual(mutchPark.surfaces, []);
});

test('surface scope keeps Meadowbank clay courts and rejects its synthetic courts', () => {
  const candidate = (court) => ({
    id: `meadowbank-${court}`,
    venue: 'Meadowbank Park Tennis Centre',
    court,
    source: {
      provider: 'sportlogic',
      canonicalAvailability: {
        venue: { id: 'sportlogic-meadowbank-park-tennis-centre' },
        court: { surface: null },
      },
    },
  });
  const clay = candidate('Court 3 (Clay Court)');
  const synthetic = candidate('Court 5');
  const filtered = applySurfaceScope([synthetic, clay], { surfaces: ['clay'] });

  assert.deepEqual(filtered.accepted.map((entry) => entry.id), ['meadowbank-Court 3 (Clay Court)']);
  assert.equal(filtered.rejected.length, 1);
  assert.equal(filtered.rejected[0].reasons[0].reason, 'candidate_surface_mismatch');
});

test('nearby courts exclude realtime availability tier venues and unknown inventory', () => {
  const searchScope = {
    locationSource: 'explicit',
    targetLocation: {
      text: 'Fixture',
      center: { lat: -33.86, lng: 151.2 },
      radiusMeters: 5000,
    },
    radiusMeters: 5000,
  };
  const nearby = selectNearbyCourts(searchScope, [{
    candidate: {
      venue: 'Already Ranked Tennis',
      source: { canonicalAvailability: { venue: { id: 'static-ranked' } } },
    },
  }], {
    limit: 5,
    inventory: [
      {
        id: 'static-ranked',
        name: 'Already Ranked Tennis',
        sport: 'tennis',
        verificationStatus: 'verified',
        realtimeAvailability: false,
        lat: -33.861,
        lng: 151.201,
        booking: { url: 'https://booking.example.test/ranked', capability: 'booking_page' },
      },
      {
        id: 'static-nearby',
        name: 'Nearby Static Tennis',
        sport: 'tennis',
        verificationStatus: 'verified',
        realtimeAvailability: false,
        lat: -33.862,
        lng: 151.202,
        booking: { url: null, capability: null },
        venueUrl: 'https://venue.example.test/nearby',
      },
      {
        id: 'realtime-nearby',
        name: 'Nearby Realtime Tennis',
        sport: 'tennis',
        verificationStatus: 'verified',
        realtimeAvailability: true,
        lat: -33.863,
        lng: 151.203,
        booking: { url: 'https://booking.example.test/realtime', capability: 'booking_page' },
      },
      {
        id: 'unknown-nearby',
        name: 'Unknown Nearby Tennis',
        sport: 'tennis',
        verificationStatus: 'unknown',
        realtimeAvailability: false,
        lat: -33.864,
        lng: 151.204,
        booking: { url: 'https://booking.example.test/unknown', capability: 'booking_page' },
      },
    ],
  });

  assert.deepEqual(nearby.map((venue) => venue.id), ['static-nearby']);
  assert.equal(nearby[0].venueUrl, 'https://venue.example.test/nearby');
});

test('nearby courts are only returned for explicit resolved locations', () => {
  const nearby = selectNearbyCourts({
    locationSource: 'sydney_fallback',
    targetLocation: {
      text: 'Sydney',
      center: { lat: -33.8688, lng: 151.2093 },
      radiusMeters: 35000,
    },
  });

  assert.deepEqual(nearby, []);
});

test('Chinese Sydney University nearby routes to USYD and Camperdown providers', () => {
  const routedScope = searchScopeForProfile({
    searchScope: {
      days: 3,
      location: '悉尼大学附近',
      source: 'user',
      isExplicit: true,
    },
  });

  assert.equal(routedScope.targetLocation.canonicalName, 'University of Sydney');
  assert.equal(routedScope.locationRouting.status, 'matched_geographic_scope');
  assert.equal(routedScope.providerScope.activeProviderIds.includes('susf'), true);
  assert.equal(routedScope.providerScope.activeProviderIds.includes('intrac'), true);
  assert.equal(routedScope.locationRouting.matchedVenues.some((venue) => venue.id === 'susf-tennis'), true);
  assert.equal(routedScope.locationRouting.matchedVenues.some((venue) => venue.id === 'intrac-camperdown-tennis'), true);
});

test('USYD input can prioritize SUSF when it is geographically reasonable', () => {
  const routedScope = searchScopeForProfile({
    searchScope: {
      days: 3,
      location: 'USYD',
      source: 'user',
      isExplicit: true,
    },
  });

  assert.equal(routedScope.targetLocation.canonicalName, 'University of Sydney');
  assert.equal(routedScope.providerScope.activeProviderIds[0], 'susf');
  assert.equal(routedScope.locationRouting.matchedVenues[0].id, 'susf-tennis');
});

test('diversified recommendations prefer another venue over near-duplicate slots', () => {
  const selected = diversifyRankedCandidates([
    rankedEntry({ id: 'a-1100', rank: 1, venue: 'A venue', startTime: '2026-09-16T11:00:00+10:00' }),
    rankedEntry({ id: 'a-1130', rank: 2, venue: 'A venue', startTime: '2026-09-16T11:30:00+10:00' }),
    rankedEntry({ id: 'a-1200', rank: 3, venue: 'A venue', startTime: '2026-09-16T12:00:00+10:00' }),
    rankedEntry({ id: 'b-1300', rank: 4, venue: 'B venue', startTime: '2026-09-16T13:00:00+10:00' }),
  ], { limit: 2 });

  assert.deepEqual(selected.map((entry) => entry.candidate.id), ['a-1100', 'b-1300']);
});

test('diversified recommendations spread times when only one venue is available', () => {
  const selected = diversifyRankedCandidates([
    rankedEntry({ id: 'a-0600', rank: 1, venue: 'A venue', startTime: '2026-09-16T06:00:00+10:00' }),
    rankedEntry({ id: 'a-0630', rank: 2, venue: 'A venue', startTime: '2026-09-16T06:30:00+10:00' }),
    rankedEntry({ id: 'a-1000', rank: 3, venue: 'A venue', startTime: '2026-09-16T10:00:00+10:00' }),
    rankedEntry({ id: 'a-1700', rank: 4, venue: 'A venue', startTime: '2026-09-16T17:00:00+10:00' }),
  ], { limit: 3 });

  assert.deepEqual(selected.map((entry) => entry.candidate.id), ['a-0600', 'a-1000', 'a-1700']);
});

test('diversified recommendations remove same-venue same-start duplicates', () => {
  const selected = diversifyRankedCandidates([
    rankedEntry({ id: 'a-0600-1', rank: 1, venue: 'A venue', startTime: '2026-09-16T06:00:00+10:00' }),
    rankedEntry({ id: 'a-0600-2', rank: 2, venue: 'A venue', startTime: '2026-09-16T06:00:00+10:00' }),
    rankedEntry({ id: 'a-1000', rank: 3, venue: 'A venue', startTime: '2026-09-16T10:00:00+10:00' }),
  ], { limit: 3 });

  assert.deepEqual(selected.map((entry) => entry.candidate.id), ['a-0600-1', 'a-1000']);
});

test('diversified recommendations preserve near times for explicit time requests', () => {
  const selected = diversifyRankedCandidates([
    rankedEntry({ id: 'a-0700-1', rank: 1, venue: 'A venue', startTime: '2026-09-16T07:00:00+10:00' }),
    rankedEntry({ id: 'a-0700-2', rank: 2, venue: 'A venue', startTime: '2026-09-16T07:00:00+10:00' }),
    rankedEntry({ id: 'a-0715', rank: 3, venue: 'A venue', startTime: '2026-09-16T07:15:00+10:00' }),
  ], { limit: 3, explicitTime: true });

  assert.deepEqual(selected.map((entry) => entry.candidate.id), ['a-0700-1', 'a-0715']);
});

test('diversified recommendations do not promote very low ranked alternatives', () => {
  const selected = diversifyRankedCandidates([
    rankedEntry({ id: 'a-1100', rank: 1, venue: 'A venue', startTime: '2026-09-16T11:00:00+10:00' }),
    rankedEntry({ id: 'a-1400', rank: 2, venue: 'A venue', startTime: '2026-09-16T14:00:00+10:00' }),
    rankedEntry({ id: 'a-1700', rank: 3, venue: 'A venue', startTime: '2026-09-16T17:00:00+10:00' }),
    rankedEntry({ id: 'b-1300', rank: 20, venue: 'B venue', startTime: '2026-09-16T13:00:00+10:00' }),
  ], { limit: 3 });

  assert.deepEqual(selected.map((entry) => entry.candidate.id), ['a-1100', 'a-1400', 'a-1700']);
});

test('diversified recommendations do not jump outside the rank window for time spread', () => {
  const selected = diversifyRankedCandidates([
    rankedEntry({ id: 'a-1000', rank: 1, venue: 'A venue', startTime: '2026-09-16T10:00:00+10:00' }),
    rankedEntry({ id: 'a-1015', rank: 2, venue: 'A venue', startTime: '2026-09-16T10:15:00+10:00' }),
    rankedEntry({ id: 'a-1030', rank: 3, venue: 'A venue', startTime: '2026-09-16T10:30:00+10:00' }),
    rankedEntry({ id: 'a-1700', rank: 20, venue: 'A venue', startTime: '2026-09-16T17:00:00+10:00' }),
  ], { limit: 3 });

  assert.deepEqual(selected.map((entry) => entry.candidate.id), ['a-1000', 'a-1015', 'a-1030']);
});

test('serialized recommendation includes booking metadata without requiring a URL', () => {
  const withBooking = serializeCandidate({
    ranking: { candidateId: 'with-booking', rank: 1, reasons: [], tradeoffs: [] },
    candidate: {
      id: 'with-booking',
      venue: 'Fixture venue',
      court: 'Court 1',
      startTime: '2026-09-16T10:00:00+10:00',
      durationMinutes: 60,
      booking: {
        url: 'https://booking.example.test/slot',
        capability: 'date_time_preselected',
        provider: 'intrac',
      },
      features: {
        localDate: '2026-09-16',
        localTime: '10:00',
        price: null,
      },
      source: {
        provider: 'intrac',
        availability: { source: 'live' },
      },
    },
  });
  const withoutBooking = serializeCandidate({
    ranking: { candidateId: 'without-booking', rank: 2, reasons: [], tradeoffs: [] },
    candidate: {
      id: 'without-booking',
      venue: 'Fixture venue',
      court: 'Court 2',
      startTime: '2026-09-16T11:00:00+10:00',
      durationMinutes: 60,
      booking: {
        url: null,
        capability: null,
        provider: 'fixture',
      },
      features: {
        localDate: '2026-09-16',
        localTime: '11:00',
        price: null,
      },
      source: {
        provider: 'fixture',
        availability: { source: 'live' },
      },
    },
  });

  assert.deepEqual(withBooking.booking, {
    url: 'https://booking.example.test/slot',
    capability: 'date_time_preselected',
    provider: 'intrac',
  });
  assert.equal(withoutBooking.booking, null);
});

test('canonical temporal windows feed provider date and time options', () => {
  const now = '2026-09-15T00:20:00+10:00';
  const cases = [
    {
      scope: { sourceText: 'tomorrow', dateRange: { type: 'tomorrow', sourceText: 'tomorrow' } },
      expected: { dateStart: '2026-09-16', dateEnd: '2026-09-16', timeStart: null, timeEnd: null, days: 1 },
    },
    {
      scope: { sourceText: '后天', dateRange: { type: 'specific_date', value: '后天', sourceText: '后天' } },
      expected: { dateStart: '2026-09-17', dateEnd: '2026-09-17', timeStart: null, timeEnd: null, days: 1 },
    },
    {
      scope: { sourceText: 'Friday', dateRange: { type: 'specific_date', value: 'Friday', sourceText: 'Friday' } },
      expected: { dateStart: '2026-09-18', dateEnd: '2026-09-18', timeStart: null, timeEnd: null, days: 1 },
    },
    {
      scope: { sourceText: '周五', dateRange: { type: 'specific_date', value: '周五', sourceText: '周五' } },
      expected: { dateStart: '2026-09-18', dateEnd: '2026-09-18', timeStart: null, timeEnd: null, days: 1 },
    },
    {
      scope: { sourceText: '下周三', dateRange: { type: 'specific_date', startDate: '2024-06-12', value: 'next Wednesday', sourceText: '下周三' } },
      expected: { dateStart: '2026-09-23', dateEnd: '2026-09-23', timeStart: null, timeEnd: null, days: 1 },
    },
    {
      scope: { sourceText: '下周一', dateRange: { type: 'specific_date', value: '下周一', sourceText: '下周一' } },
      expected: { dateStart: '2026-09-21', dateEnd: '2026-09-21', timeStart: null, timeEnd: null, days: 1 },
    },
    {
      scope: { sourceText: '最近几天', dateRange: { type: 'next_few_days', sourceText: '最近几天' } },
      expected: { dateStart: '2026-09-15', dateEnd: '2026-09-17', timeStart: null, timeEnd: null, days: 3 },
    },
    {
      scope: { sourceText: 'after 10am', timeWindow: { after: '10:00' } },
      expected: { dateStart: null, dateEnd: null, timeStart: '10:00', timeEnd: null, days: 7 },
    },
    {
      scope: {
        sourceText: 'Friday after 10am',
        dateRange: { type: 'specific_date', value: 'Friday', sourceText: 'Friday' },
        timeWindow: { after: '10:00' },
      },
      expected: { dateStart: '2026-09-18', dateEnd: '2026-09-18', timeStart: '10:00', timeEnd: null, days: 1 },
    },
    {
      scope: {
        sourceText: '后天10点以后',
        dateRange: { type: 'specific_date', value: '后天', sourceText: '后天' },
        timeWindow: { after: '10:00' },
      },
      expected: { dateStart: '2026-09-17', dateEnd: '2026-09-17', timeStart: '10:00', timeEnd: null, days: 1 },
    },
  ];

  for (const { scope, expected } of cases) {
    const routedScope = searchScopeForProfile({
      updatedAt: now,
      searchScope: {
        days: 7,
        ...scope,
      },
    });
    assert.deepEqual({
      dateStart: routedScope.temporalWindow.dateStart,
      dateEnd: routedScope.temporalWindow.dateEnd,
      timeStart: routedScope.temporalWindow.timeStart,
      timeEnd: routedScope.temporalWindow.timeEnd,
    }, {
      dateStart: expected.dateStart,
      dateEnd: expected.dateEnd,
      timeStart: expected.timeStart,
      timeEnd: expected.timeEnd,
    });

    const options = providerOptionsForState({
      searchScope: routedScope,
      preferences: { updatedAt: now, searchScope: routedScope },
    });
    const providerOptions = options.susf ?? Object.values(options)[0] ?? options;
    assert.equal(providerOptions.dateStart ?? null, expected.dateStart);
    assert.equal(providerOptions.dateEnd ?? null, expected.dateEnd);
    assert.equal(providerOptions.timeStart ?? null, expected.timeStart);
    assert.equal(providerOptions.timeEnd ?? null, expected.timeEnd);
    assert.equal(providerOptions.days, expected.days);
  }
});
