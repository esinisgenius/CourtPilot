import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GoogleMapsProvider,
  INITIAL_RADIUS_METERS,
  MAPS_ERROR_CODES,
  MapsError,
  TtlCache,
  TRAVEL_MODES,
  availabilityForVenue,
  createTravelEstimateContext,
  dedupeVenues,
  enrichVenueTravelTimes,
  getGoogleMapsApiKey,
  getInitialRadiusMeters,
  getNextRadius,
  inferTravelModeFromText,
  listSavedPlayAreas,
  loadSavedPlayAreasDocument,
  normalizeDeviceLocation,
  normalizeProviderVenue,
  normalizeRouteResult,
  normalizeRouteMatrixElement,
  normalizeSavedPlayArea,
  normalizeTargetTime,
  resolveLocation,
  resolveLocationFromContext,
  saveSavedPlayArea,
  selectReliableGeocodeResult,
  searchTennisVenues,
} from '../packages/maps/src/index.mjs';
import {
  createInitialAgentState,
  expandSearchRadius,
  normalizeSearchScope,
  switchSearchArea,
} from '../packages/agent/src/index.mjs';
import {
  attachVenueToCandidate,
  venueToCandidateVenueFeature,
} from '../packages/core/src/index.mjs';

const USYD = { lat: -33.8886, lng: 151.1873 };

async function tempJsonFile(value) {
  const dir = await mkdtemp(join(tmpdir(), 'tennis-maps-test-'));
  const filePath = join(dir, 'saved-play-areas.json');
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function mockProvider() {
  return {
    geocodeCalls: 0,
    searchCalls: 0,
    routeCalls: 0,
    async geocode({ query }) {
      this.geocodeCalls += 1;
      if (query === 'unresolved') return null;
      return {
        label: 'University of Sydney',
        lat: USYD.lat,
        lng: USYD.lng,
        placeId: 'usyd-place',
      };
    },
    async searchPlaces({ query }) {
      this.searchCalls += 1;
      if (query === 'empty') return [];
      return [
        {
          placeId: 'susf-place',
          name: 'Sydney Uni Sport Tennis Courts',
          location: USYD,
          address: 'Western Ave',
          providerTypes: ['sports_complex'],
        },
        {
          placeId: 'other-place',
          name: 'Camperdown Tennis Club',
          location: { lat: -33.886, lng: 151.18 },
          address: null,
          providerTypes: ['point_of_interest'],
        },
      ];
    },
    async computeTravelTimes({ destinations }) {
      this.routeCalls += 1;
      return destinations.map((_, index) => ({
        durationMinutes: 10 + index,
        distanceMeters: 900 + index,
      }));
    },
  };
}

test('location resolver handles explicit user text contract', async () => {
  const provider = mockProvider();
  const location = await resolveLocation({ type: 'user_text', query: 'USYD' }, { provider });

  assert.equal(location.label, 'University of Sydney');
  assert.equal(location.source, 'user_explicit');
  assert.equal(location.placeId, 'usyd-place');
  assert.equal(provider.geocodeCalls, 1);
});

test('location resolver handles saved area and missing file', async () => {
  const filePath = await tempJsonFile({
    version: 1,
    areas: [{
      id: 'usyd',
      label: 'USYD',
      center: USYD,
      defaultRadiusMeters: 3000,
    }],
  });

  const location = await resolveLocation({ type: 'saved_area', areaId: 'usyd' }, { savedAreasPath: filePath });
  assert.equal(location.source, 'saved_area');
  assert.equal(location.areaId, 'usyd');
  assert.deepEqual(await listSavedPlayAreas({ filePath: join(tmpdir(), 'missing-saved-areas.json') }), []);
});

test('device location normalize rejects malformed coordinates', () => {
  assert.deepEqual(normalizeDeviceLocation({ lat: -33.8, lng: 151.2 }), {
    label: 'Current location',
    lat: -33.8,
    lng: 151.2,
    source: 'device_geolocation',
  });
  assert.throws(
    () => normalizeDeviceLocation({ lat: 999, lng: 151.2 }),
    /malformed coordinates/,
  );
});

test('explicit user location has priority over saved area and device context', async () => {
  const provider = mockProvider();
  const filePath = await tempJsonFile({
    version: 1,
    areas: [{
      id: 'home',
      label: 'Home',
      center: { lat: -34, lng: 151 },
    }],
  });

  const explicit = await resolveLocationFromContext({
    explicitLocation: { type: 'user_text', query: 'USYD' },
    savedAreaId: 'home',
    deviceLocation: { lat: -35, lng: 150 },
  }, { provider, savedAreasPath: filePath });
  assert.equal(explicit.source, 'user_explicit');

  const fallback = await resolveLocationFromContext({
    savedAreaId: 'home',
    deviceLocation: { lat: -35, lng: 150 },
  }, { provider, savedAreasPath: filePath });
  assert.equal(fallback.source, 'saved_area');
});

test('unresolved location is explicit and not guessed', async () => {
  await assert.rejects(
    () => resolveLocation({ type: 'user_text', query: 'unresolved' }, { provider: mockProvider() }),
    (error) => error.code === MAPS_ERROR_CODES.LOCATION_UNRESOLVED,
  );
});

test('Google geocoding accepts named institution candidate without hardcoding the query', async () => {
  const provider = new GoogleMapsProvider({
    apiKey: 'test-api-key-not-real',
    cache: new TtlCache(),
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'OK',
      results: [{
        formatted_address: 'The University of Sydney, Camperdown NSW 2006, Australia',
        place_id: 'ChIJTestUniversityPlace',
        types: ['university', 'establishment', 'point_of_interest'],
        geometry: {
          location: USYD,
          location_type: 'ROOFTOP',
        },
      }],
    }), { status: 200 }),
  });

  const location = await resolveLocation({
    type: 'user_text',
    query: 'University of Sydney',
  }, { provider });

  assert.equal(location.source, 'user_explicit');
  assert.equal(location.label, 'The University of Sydney, Camperdown NSW 2006, Australia');
  assert.equal(location.providerMetadata.providerStatus, 'OK');
  assert.deepEqual(location.providerMetadata.resultTypes, ['university', 'establishment', 'point_of_interest']);
  assert.equal(location.providerMetadata.reliabilityDecision, 'accepted_first_valid_coordinate_result');
});

test('Google geocoding ZERO_RESULTS remains true LOCATION_UNRESOLVED', async () => {
  const provider = new GoogleMapsProvider({
    apiKey: 'test-api-key-not-real',
    cache: new TtlCache(),
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'ZERO_RESULTS',
      results: [],
    }), { status: 200 }),
  });

  await assert.rejects(
    () => resolveLocation({ type: 'user_text', query: 'not a real place probably' }, { provider }),
    (error) => error.code === MAPS_ERROR_CODES.LOCATION_UNRESOLVED,
  );
});

test('Google geocoding provider status errors do not masquerade as LOCATION_UNRESOLVED', async () => {
  const provider = new GoogleMapsProvider({
    apiKey: 'test-api-key-not-real',
    cache: new TtlCache(),
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'REQUEST_DENIED',
      error_message: 'This API project is not authorized to use this API.',
      results: [],
    }), { status: 200 }),
  });

  await assert.rejects(
    () => resolveLocation({ type: 'user_text', query: 'University of Sydney' }, { provider }),
    (error) => {
      assert.equal(error.code, MAPS_ERROR_CODES.MAPS_PROVIDER_ERROR);
      assert.equal(error.details.providerStatus, 'REQUEST_DENIED');
      assert.equal(error.details.resultCount, 0);
      return true;
    },
  );
});

test('geocoding reliability selection uses first valid coordinate result generically', () => {
  const selected = selectReliableGeocodeResult([
    { formatted_address: 'Broken', geometry: { location: { lat: 999, lng: 151 } } },
    {
      formatted_address: 'A suburb, NSW, Australia',
      types: ['locality', 'political'],
      geometry: { location: { lat: -33.9, lng: 151.2 }, location_type: 'APPROXIMATE' },
    },
  ]);

  assert.equal(selected.formatted_address, 'A suburb, NSW, Australia');
});

test('Google geocoding OK with no valid coordinates is LOCATION_UNRESOLVED not provider error', async () => {
  const provider = new GoogleMapsProvider({
    apiKey: 'test-api-key-not-real',
    cache: new TtlCache(),
    fetchImpl: async () => new Response(JSON.stringify({
      status: 'OK',
      results: [{
        formatted_address: 'Broken',
        geometry: { location: { lat: 999, lng: 151 } },
      }],
    }), { status: 200 }),
  });

  await assert.rejects(
    () => resolveLocation({ type: 'user_text', query: 'Broken' }, { provider }),
    (error) => error.code === MAPS_ERROR_CODES.LOCATION_UNRESOLVED,
  );
});

test('saved play areas validate load invalid entries and avoid real home fixture coordinates', async () => {
  const validPath = await tempJsonFile({
    version: 1,
    areas: [{
      id: 'home',
      label: 'Home',
      center: { lat: -33, lng: 151 },
    }],
  });
  assert.equal((await loadSavedPlayAreasDocument({ filePath: validPath })).areas[0].defaultRadiusMeters, 3000);
  assert.throws(() => normalizeSavedPlayArea({ id: 'bad', label: 'Bad', center: { lat: 1000, lng: 151 } }));

  const fixture = JSON.parse(await readFile('data/saved-play-areas.example.json', 'utf8'));
  const home = fixture.areas.find((area) => area.id === 'home');
  assert.deepEqual(home.center, { lat: -33, lng: 151 });
});

test('saved play area can be saved without hardcoded area ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tennis-area-save-'));
  const filePath = join(dir, 'areas.json');
  const saved = await saveSavedPlayArea({
    id: 'work',
    label: 'Work',
    center: { lat: -33.9, lng: 151.2 },
  }, { filePath });
  assert.equal(saved.id, 'work');
  assert.equal((await listSavedPlayAreas({ filePath }))[0].label, 'Work');
});

test('venue discovery normalizes provider rows dedupes and defaults unknown availability', () => {
  const venue = normalizeProviderVenue({
    placeId: 'abc',
    name: 'Local Tennis Club',
    location: { lat: -33.88, lng: 151.19 },
    providerTypes: ['sports_complex'],
  }, { center: USYD });

  assert.equal(venue.source, 'google_places');
  assert.equal(venue.availability.status, 'unknown');
  assert.equal(venue.travel, null);
  assert.equal(dedupeVenues([venue, { ...venue, geoDistanceMeters: 9999 }]).length, 1);
});

test('venue discovery enforces strict radius after provider normalization', async () => {
  const venues = await searchTennisVenues({
    center: USYD,
    radiusMeters: 3000,
    limit: 10,
    queries: ['tennis_court'],
    provider: {
      async searchPlaces() {
        return [
          {
            placeId: 'near',
            name: 'Near Tennis Court',
            location: { lat: -33.889, lng: 151.188 },
            providerTypes: ['tennis_court'],
          },
          {
            placeId: 'far',
            name: 'Far Tennis Court',
            location: { lat: -34.2, lng: 151.5 },
            providerTypes: ['tennis_court'],
          },
        ];
      },
    },
  });

  assert.deepEqual(venues.map((venue) => venue.placeId), ['near']);
});

test('venue discovery handles empty result and provider error distinctly', async () => {
  const empty = await searchTennisVenues({
    center: USYD,
    provider: {
      async searchPlaces() {
        return [];
      },
    },
    queries: ['empty'],
  });
  assert.deepEqual(empty, []);

  await assert.rejects(
    () => searchTennisVenues({
      center: USYD,
      provider: {
        async searchPlaces() {
          throw new Error('provider down');
        },
      },
      queries: ['tennis court'],
    }),
    (error) => error.code === MAPS_ERROR_CODES.VENUE_SEARCH_FAILED,
  );
});

test('SUSF reconciliation marks verified availability only for matching nearby venues', () => {
  assert.deepEqual(availabilityForVenue({
    name: 'Sydney Uni Sport Tennis Courts',
    location: USYD,
  }), {
    status: 'verified',
    source: 'susf',
  });

  assert.deepEqual(availabilityForVenue({
    name: 'Sydney Uni Sport Tennis Courts',
    location: { lat: -34.2, lng: 151.2 },
  }), {
    status: 'unknown',
    source: null,
  });
});

test('travel modes normalize infer explicit user source and product default', () => {
  assert.equal(inferTravelModeFromText('走路15分钟以内').mode, TRAVEL_MODES.WALK);
  assert.equal(inferTravelModeFromText('开车20分钟').mode, TRAVEL_MODES.DRIVE);
  assert.equal(inferTravelModeFromText('坐公交').mode, TRAVEL_MODES.TRANSIT);
  assert.deepEqual(inferTravelModeFromText('不要太远'), {
    mode: TRAVEL_MODES.TRANSIT,
    valueSource: 'product_default',
  });
});

test('target time creates explicit travel estimate context', () => {
  assert.equal(normalizeTargetTime('2026-09-03T08:00:00.000Z'), '2026-09-03T08:00:00.000Z');
  assert.deepEqual(createTravelEstimateContext({
    targetTime: '2026-09-03T08:00:00.000Z',
    targetTimeType: 'arrival',
  }), {
    type: 'target_arrival_time',
    targetTime: '2026-09-03T08:00:00.000Z',
    targetTimeType: 'arrival',
    limitation: null,
  });
  assert.equal(createTravelEstimateContext().type, 'venue_level_current_or_provider_default');
  assert.throws(() => normalizeTargetTime('not a date'), /valid date/);
});

test('travel time enrichment batches deduped destinations and leaves missing route null', async () => {
  let destinationCount = 0;
  const venues = [
    normalizeProviderVenue({ placeId: 'a', name: 'A', location: { lat: -33.88, lng: 151.18 } }, { center: USYD }),
    normalizeProviderVenue({ placeId: 'b', name: 'B', location: { lat: -33.88, lng: 151.18 } }, { center: USYD }),
    normalizeProviderVenue({ placeId: 'c', name: 'C', location: { lat: -33.89, lng: 151.2 } }, { center: USYD }),
  ];
  const enriched = await enrichVenueTravelTimes({
    origin: USYD,
    venues,
    mode: 'WALK',
    modeValueSource: 'user_explicit',
    provider: {
      async computeTravelTimes({ destinations, mode }) {
        destinationCount = destinations.length;
        assert.equal(mode, TRAVEL_MODES.WALK);
        return [
          { durationMinutes: 12.2, distanceMeters: 1200 },
          { status: 'unavailable', reason: 'route_not_found' },
        ];
      },
    },
    targetTime: '2026-09-03T08:00:00.000Z',
  });

  assert.equal(destinationCount, 2);
  assert.equal(enriched[0].travel.durationMinutes, 13);
  assert.equal(enriched[0].travel.valueSource, 'user_explicit');
  assert.equal(enriched[0].travel.estimateContext.type, 'target_arrival_time');
  assert.equal(enriched[0].travel.estimateContext.targetTime, '2026-09-03T08:00:00.000Z');
  assert.equal(enriched[1].travel.durationMinutes, 13);
  assert.equal(enriched[2].travel.durationMinutes, null);
  assert.equal(enriched[2].travel.unavailableReason, 'route_not_found');
});

test('travel fallback context does not pretend to be target-time routing', async () => {
  const [enriched] = await enrichVenueTravelTimes({
    origin: USYD,
    venues: [normalizeProviderVenue({
      placeId: 'a',
      name: 'A Tennis Court',
      location: { lat: -33.88, lng: 151.18 },
      providerTypes: ['tennis_court'],
    }, { center: USYD })],
    provider: {
      async computeTravelTimes({ targetTime, targetTimeType, estimateContext }) {
        assert.equal(targetTime, null);
        assert.equal(targetTimeType, null);
        assert.equal(estimateContext.type, 'venue_level_current_or_provider_default');
        return [{ durationMinutes: 14, distanceMeters: 1000 }];
      },
    },
  });

  assert.equal(enriched.travel.estimateContext.type, 'venue_level_current_or_provider_default');
  assert.match(enriched.travel.estimateContext.limitation, /No target time/);
});

test('travel provider failure is not converted to zero minutes', async () => {
  await assert.rejects(
    () => enrichVenueTravelTimes({
      origin: USYD,
      venues: [normalizeProviderVenue({ placeId: 'a', name: 'A', location: { lat: -33.88, lng: 151.18 } }, { center: USYD })],
      provider: {
        async computeTravelTimes() {
          throw new Error('routes down');
        },
      },
    }),
    (error) => error.code === MAPS_ERROR_CODES.ROUTES_PROVIDER_ERROR,
  );

  assert.equal(normalizeRouteResult({ status: 'unavailable' }, {
    mode: TRAVEL_MODES.DRIVE,
    valueSource: 'product_default',
  }).durationMinutes, null);
});

test('Google provider cache hit avoids repeated provider calls', async () => {
  let calls = 0;
  const provider = new GoogleMapsProvider({
    apiKey: 'test-api-key-not-real',
    cache: new TtlCache(),
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        status: 'OK',
        results: [{
          formatted_address: 'USYD',
          place_id: 'place',
          geometry: { location: USYD },
        }],
      }), { status: 200 });
    },
  });

  await provider.geocode({ query: 'USYD' });
  await provider.geocode({ query: 'USYD' });
  assert.equal(calls, 1);
});

test('Google Nearby Search uses strict locationRestriction circle', async () => {
  let requestUrl;
  let requestBody;
  const provider = new GoogleMapsProvider({
    apiKey: 'test-api-key-not-real',
    cache: new TtlCache(),
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        places: [{
          id: 'place',
          displayName: { text: 'USYD Tennis Court' },
          formattedAddress: 'Western Ave',
          location: { latitude: USYD.lat, longitude: USYD.lng },
          types: ['tennis_court'],
        }],
      }), { status: 200 });
    },
  });

  const places = await provider.searchPlaces({
    query: 'tennis_court',
    center: USYD,
    radiusMeters: 3000,
    limit: 5,
  });

  assert.equal(requestUrl, 'https://places.googleapis.com/v1/places:searchNearby');
  assert.deepEqual(requestBody.includedTypes, ['tennis_court']);
  assert.equal(requestBody.locationRestriction.circle.radius, 3000);
  assert.equal(requestBody.locationBias, undefined);
  assert.equal(places[0].providerTypes.includes('tennis_court'), true);
});

test('Google Routes request and cache key include target time', async () => {
  const bodies = [];
  const provider = new GoogleMapsProvider({
    apiKey: 'test-api-key-not-real',
    cache: new TtlCache(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify([{
        originIndex: 0,
        destinationIndex: 0,
        condition: 'ROUTE_EXISTS',
        duration: '600s',
        distanceMeters: 2000,
      }]), { status: 200 });
    },
  });

  const args = {
    origin: USYD,
    destinations: [{ lat: -33.88, lng: 151.18 }],
    mode: TRAVEL_MODES.TRANSIT,
    estimateContext: createTravelEstimateContext({ targetTime: '2026-09-03T08:00:00.000Z' }),
    targetTime: '2026-09-03T08:00:00.000Z',
    targetTimeType: 'arrival',
  };
  await provider.computeTravelTimes(args);
  await provider.computeTravelTimes(args);
  await provider.computeTravelTimes({
    ...args,
    estimateContext: createTravelEstimateContext({ targetTime: '2026-09-04T08:00:00.000Z' }),
    targetTime: '2026-09-04T08:00:00.000Z',
  });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].arrivalTime, '2026-09-03T08:00:00.000Z');
  assert.equal(bodies[1].arrivalTime, '2026-09-04T08:00:00.000Z');
});

test('Google route matrix ROUTE_EXISTS is success and parses duration and distance', () => {
  assert.deepEqual(normalizeRouteMatrixElement({
    originIndex: 0,
    destinationIndex: 0,
    status: {},
    condition: 'ROUTE_EXISTS',
    duration: '1234s',
    distanceMeters: 5678,
  }), {
    durationMinutes: 1234 / 60,
    distanceMeters: 5678,
  });
});

test('Google route matrix ROUTE_NOT_FOUND is unavailable without leaking condition as reason', () => {
  assert.deepEqual(normalizeRouteMatrixElement({
    originIndex: 0,
    destinationIndex: 0,
    condition: 'ROUTE_NOT_FOUND',
  }), {
    status: 'unavailable',
    reason: 'route_not_found',
  });
});

test('Google route matrix non-OK element status is a route error', () => {
  assert.deepEqual(normalizeRouteMatrixElement({
    originIndex: 0,
    destinationIndex: 0,
    status: {
      code: 7,
      message: 'Route element permission denied.',
      status: 'PERMISSION_DENIED',
    },
    condition: 'ROUTE_EXISTS',
  }), {
    status: 'unavailable',
    reason: 'Route element permission denied.',
  });
});

test('Google route matrix success with missing duration or distance stays factual nulls', () => {
  assert.deepEqual(normalizeRouteMatrixElement({
    originIndex: 0,
    destinationIndex: 0,
    condition: 'ROUTE_EXISTS',
  }), {
    durationMinutes: null,
    distanceMeters: null,
  });
});

test('Google route matrix provider uses required field mask', async () => {
  let fieldMask;
  const provider = new GoogleMapsProvider({
    apiKey: 'test-api-key-not-real',
    cache: new TtlCache(),
    fetchImpl: async (url, init) => {
      fieldMask = init.headers['X-Goog-FieldMask'];
      return new Response(JSON.stringify([{
        originIndex: 0,
        destinationIndex: 0,
        condition: 'ROUTE_EXISTS',
        duration: '600s',
        distanceMeters: 2000,
      }]), { status: 200 });
    },
  });

  await provider.computeTravelTimes({
    origin: USYD,
    destinations: [{ lat: -33.88, lng: 151.18 }],
    mode: TRAVEL_MODES.WALK,
  });

  for (const field of ['originIndex', 'destinationIndex', 'status', 'condition', 'duration', 'distanceMeters']) {
    assert.equal(fieldMask.split(',').includes(field), true);
  }
});

test('radius policy uses initial 3000 deterministic ladder and max bound', () => {
  assert.equal(getInitialRadiusMeters(), INITIAL_RADIUS_METERS);
  assert.equal(getNextRadius(3000), 5000);
  assert.equal(getNextRadius(12000), 12000);
});

test('agent searchScope compatibility and switch area executor need no LLM', async () => {
  const filePath = await tempJsonFile({
    version: 1,
    areas: [{
      id: 'usyd',
      label: 'USYD',
      center: USYD,
      defaultRadiusMeters: 3000,
    }, {
      id: 'home',
      label: 'Home',
      center: { lat: -33, lng: 151 },
      defaultRadiusMeters: 5000,
    }],
  });
  const state = createInitialAgentState({
    goal: 'find next tennis session',
    preferences: {},
    searchScope: {
      location: { label: 'USYD', ...USYD, source: 'saved_area' },
      activeAreaId: 'usyd',
      radiusMeters: 3000,
      travelMode: 'TRANSIT',
    },
    candidates: [],
    rejectedCandidates: [],
    failedConstraints: [],
    actionsTaken: [],
  });

  assert.equal(normalizeSearchScope({}).travelMode, TRAVEL_MODES.TRANSIT);
  assert.equal(normalizeSearchScope(state.searchScope).activeAreaId, 'usyd');
  assert.equal(expandSearchRadius(state).searchScope.radiusMeters, 5000);

  const switched = await switchSearchArea(state, 'home', { savedAreasPath: filePath });
  assert.equal(switched.searchScope.activeAreaId, 'home');
  assert.equal(switched.searchScope.location.source, 'saved_area');
  assert.equal(switched.searchScope.radiusMeters, 5000);
});

test('core venue compatibility keeps Venue separate from bookable slot candidate', () => {
  const venue = {
    id: 'google_places:abc',
    name: 'Local Tennis Club',
    address: null,
    location: { lat: -33.88, lng: 151.18 },
    availability: { status: 'unknown', source: null },
    geoDistanceMeters: 100,
    travel: {
      durationMinutes: 12,
      mode: 'TRANSIT',
      source: 'google_routes',
      valueSource: 'product_default',
    },
  };
  const feature = venueToCandidateVenueFeature(venue);
  assert.equal(feature.travelTimeMinutes, 12);
  assert.equal(feature.availability.status, 'unknown');

  const candidate = attachVenueToCandidate({
    id: 'slot',
    venue: 'SUSF',
    features: {},
  }, venue);
  assert.equal(candidate.features.travelTimeMinutes, 12);
  assert.equal(candidate.venue, 'SUSF');
});

test('missing Google Maps key and provider errors do not leak key-like values', async () => {
  assert.throws(
    () => getGoogleMapsApiKey({}),
    (error) => error.code === MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED,
  );

  const provider = new GoogleMapsProvider({
    apiKey: 'fake-google-maps-test-secret-value-12345',
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'request denied for fake-google-maps-test-secret-value-12345' },
    }), { status: 403, statusText: 'Forbidden' }),
  });

  await assert.rejects(
    () => provider.geocode({ query: 'USYD' }),
    (error) => {
      assert.equal(error instanceof MapsError, true);
      assert.equal(error.code, MAPS_ERROR_CODES.MAPS_PROVIDER_ERROR);
      assert.equal(error.message.includes('fake-google-maps-test-secret-value-12345'), false);
      return true;
    },
  );
});
