import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidate,
  validateCanonicalAvailability,
} from '../packages/core/src/index.mjs';
import {
  DEFAULT_UNIFIED_BOOKINGS_VENUES,
  UnifiedBookingsAvailabilityError,
  buildUnifiedBookingsUrls,
  discoverVenues,
  extractRuntimeApiConfig,
  normalizeAvailability,
  normalizeBlockers,
  normalizeLocation,
  readAvailability,
} from '../packages/unified-bookings/src/index.mjs';

const venueConfig = {
  id: 'fixture-unified-tennis',
  name: 'Fixture Unified Tennis',
  suburb: 'Fixture',
  provider: 'unified-bookings',
  officialUrl: 'https://booking.fixture.example/booking?uuid=location-uuid',
  auditCourtCount: 2,
};

const rawLocation = {
  total: 1,
  results: [{
    id: '2',
    uuid: 'location-uuid',
    name: 'Fixture Unified Tennis',
    organisation: {
      id: 2,
      uuid: 'org-uuid',
      name: 'Fixture Sports Club',
    },
  }],
};

const rawResources = {
  total: 2,
  results: [
    {
      id: 12,
      uuid: 'court-uuid-12',
      name: 'Tennis Court 11',
      is_active: 1,
      display_online: 1,
      attributes: {
        resource_type: 'Tennis Court',
        surface_type: 'Synthetic Grass',
        max_duration: '120m',
        min_duration: '30m',
        default_start_time: '07:00',
        default_end_time: '10:00',
        duration_per_chunk: '30m',
        peak_price_per_chunk: '12.50',
        off_peak_price_per_chunk: '10.00',
      },
    },
    {
      id: 99,
      uuid: 'futsal-uuid',
      name: 'Futsal Pitch',
      is_active: 1,
      display_online: 1,
      attributes: {
        resource_type: 'Futsal Court',
        default_start_time: '07:00',
        default_end_time: '10:00',
      },
    },
  ],
};

const rawBookingsPublic = {
  results: {
    bookings: [{
      start_time: '2026-09-03T21:00:00Z',
      end_time: '2026-09-03T22:00:00Z',
      resource: {
        id: '12',
        uuid: 'court-uuid-12',
        name: 'Tennis Court 11',
      },
      is_booked: 1,
      is_available: 0,
    }],
    recurrings: [],
    locked: [],
    booking_requests: [],
    pending_recurring_schedules: [],
    calendar_blockings: [],
  },
};

function mockUnifiedFetch({ failBookings = false, noApiKey = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === venueConfig.officialUrl) {
      return new Response('<html><script src="/assets/index-fixture.js"></script></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url === 'https://booking.fixture.example/assets/index-fixture.js') {
      return new Response(noApiKey
        ? 'window.app = {}'
        : 'const env={REACT_APP_API_V1_URL:`https://api.fixture.example/Prod`,REACT_APP_API_V1_KEY:`public-fixture-key`};', {
        headers: { 'content-type': 'application/javascript' },
      });
    }
    if (url === 'https://api.fixture.example/Prod/search/locations?q=location-uuid') {
      return Response.json(rawLocation);
    }
    if (url === 'https://api.fixture.example/Prod/search/locations/location-uuid/resources?date=2026-09-04&version=2') {
      return Response.json(rawResources);
    }
    if (url.startsWith('https://api.fixture.example/Prod/resource/bookingspublic?')) {
      if (failBookings) return new Response('oops', { status: 503 });
      return Response.json(rawBookingsPublic);
    }
    return new Response('not found', { status: 404 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('Unified Bookings default registry contains Strathfield production metadata', () => {
  assert.equal(DEFAULT_UNIFIED_BOOKINGS_VENUES.length, 1);
  const [venue] = DEFAULT_UNIFIED_BOOKINGS_VENUES;
  assert.equal(venue.provider, 'unified-bookings');
  assert.equal(venue.name, 'Strathfield Sports Club Tennis');
  assert.equal(venue.locationUuid, 'ff5fe060-c9a2-11ea-b131-02cc617d54fa');
  assert.equal(venue.enabled, true);
  assert.equal(venue.auditCourtCount, 10);
});

test('Unified Bookings venue discovery reads location UUID from official URL', () => {
  const [venue] = discoverVenues({ venues: [venueConfig] });

  assert.equal(venue.provider, 'unified-bookings');
  assert.equal(venue.locationUuid, 'location-uuid');
  assert.equal(venue.origin, 'https://booking.fixture.example');
});

test('Unified Bookings public API config is extracted from frontend runtime bundle text', () => {
  assert.deepEqual(extractRuntimeApiConfig('REACT_APP_API_V1_URL:`https://api.example/Prod`,REACT_APP_API_V1_KEY:`public-key`'), {
    apiBaseUrl: 'https://api.example/Prod',
    apiKey: 'public-key',
  });
});

test('Unified Bookings endpoint construction uses public GET endpoints', () => {
  assert.deepEqual(buildUnifiedBookingsUrls({
    apiBaseUrl: 'https://api.fixture.example/Prod/',
    locationUuid: 'location-uuid',
    date: '2026-09-04',
  }), {
    location: 'https://api.fixture.example/Prod/search/locations?q=location-uuid',
    resources: 'https://api.fixture.example/Prod/search/locations/location-uuid/resources?date=2026-09-04&version=2',
  });

  assert.equal(buildUnifiedBookingsUrls({
    apiBaseUrl: 'https://api.fixture.example/Prod',
    locationUuid: 'location-uuid',
    date: '2026-09-04',
    locationId: '2',
    resource: { id: '12', uuid: 'court-uuid-12' },
  }).bookingsPublic, 'https://api.fixture.example/Prod/resource/bookingspublic?locationId=2&locationUuid=location-uuid&date=2026-09-04&resourceUuid=court-uuid-12&resourceId=12');
});

test('Unified Bookings anonymous acquisition sends dynamic public x-api-key and no cookies/auth', async () => {
  const fetchImpl = mockUnifiedFetch();
  await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    fetchImpl,
  });

  const apiCalls = fetchImpl.calls.filter((call) => call.url.startsWith('https://api.fixture.example'));
  assert.equal(apiCalls.length, 3);
  for (const call of apiCalls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.headers['x-api-key'], 'public-fixture-key');
    assert.equal(call.options.headers.cookie, undefined);
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(call.options.headers['x-csrf-token'], undefined);
  }
});

test('Unified Bookings reconstructs slots from public resources and bookingspublic blockers', async () => {
  const availability = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    fetchImpl: mockUnifiedFetch(),
  });

  assert.deepEqual(availability.map((slot) => slot.startTime), [
    '2026-09-04T08:00:00+10:00',
    '2026-09-04T08:30:00+10:00',
    '2026-09-04T09:00:00+10:00',
  ]);
  assert.equal(availability.every((slot) => slot.court === 'Tennis Court 11'), true);
});

test('Unified Bookings 120-minute semantics require continuous unblocked time', async () => {
  const availability = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 120,
    fetchImpl: mockUnifiedFetch(),
  });

  assert.deepEqual(availability.map((slot) => slot.startTime), [
    '2026-09-04T08:00:00+10:00',
  ]);
});

test('Unified Bookings canonical schema and provenance are provider-agnostic', async () => {
  const [slot] = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    fetchImpl: mockUnifiedFetch(),
  });

  assert.equal(validateCanonicalAvailability(slot.canonical), slot.canonical);
  assert.deepEqual(slot.canonical, {
    provider: 'unified-bookings',
    venue: {
      id: 'fixture-unified-tennis',
      name: 'Fixture Unified Tennis',
      providerVenueId: 'location-uuid',
    },
    court: {
      id: 'unified-bookings-court-court-uuid-12',
      name: 'Tennis Court 11',
      providerCourtId: 'court-uuid-12',
      surface: 'Synthetic Grass',
    },
    slot: {
      start: '2026-09-04T08:00:00+10:00',
      end: '2026-09-04T09:00:00+10:00',
      durationMinutes: 60,
      available: true,
    },
    price: {
      amount: null,
      currency: 'AUD',
      confidence: 'unknown',
    },
    provenance: {
      source: 'live',
      auth: 'public',
      observedAt: slot.canonical.provenance.observedAt,
      availabilityMethod: 'derived_first_party',
    },
  });
  assert.equal(slot.resourceUuid, 'court-uuid-12');
  assert.equal(slot.resourceId, '12');
  assert.equal(slot.locationId, '2');
  assert.equal(slot.officialUrl, venueConfig.officialUrl);
  assert.deepEqual(slot.priceMetadata, {
    durationPerChunk: '30m',
    peakPricePerChunk: '12.50',
    offPeakPricePerChunk: '10.00',
  });
});

test('Unified Bookings slots flow through existing candidate pipeline', async () => {
  const [slot] = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    fetchImpl: mockUnifiedFetch(),
  });
  const candidate = buildCandidate(slot);

  assert.equal(candidate.venue, 'Fixture Unified Tennis');
  assert.equal(candidate.source.provider, 'unified-bookings');
  assert.equal(candidate.source.availability.source, 'live');
  assert.equal(candidate.source.availability.availabilityMethod, 'derived_first_party');
  assert.equal(candidate.source.canonicalAvailability.court.providerCourtId, 'court-uuid-12');
});

test('Unified Bookings successful zero availability differs from acquisition failure', () => {
  const venue = discoverVenues({ venues: [venueConfig] })[0];
  const location = normalizeLocation(rawLocation, venue);
  const slots = normalizeAvailability({
    venue,
    location,
    resources: rawResources,
    bookingsByResourceUuid: new Map([['court-uuid-12', normalizeBlockers(rawBookingsPublic)]]),
    date: '2026-09-04',
    durationMinutes: 240,
    observedAt: '2026-09-04T00:00:00.000Z',
  });

  assert.deepEqual(slots, []);
});

test('Unified Bookings acquisition failure is raised with partial-failure context', async () => {
  await assert.rejects(() => readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    fetchImpl: mockUnifiedFetch({ failBookings: true }),
  }), (error) => {
    assert.equal(error instanceof UnifiedBookingsAvailabilityError, true);
    assert.equal(error.code, 'UNIFIED_PARTIAL_FAILURE');
    assert.equal(error.failures[0].venue, 'Fixture Unified Tennis');
    assert.equal(error.availability.length, 0);
    return true;
  });
});

test('Unified Bookings missing public API config fails explicitly', async () => {
  await assert.rejects(() => readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    fetchImpl: mockUnifiedFetch({ noApiKey: true }),
  }), (error) => {
    assert.equal(error.code, 'UNIFIED_PARTIAL_FAILURE');
    assert.equal(error.failures[0].code, 'UNIFIED_API_CONFIG_MISSING');
    return true;
  });
});
