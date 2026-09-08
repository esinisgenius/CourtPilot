import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichCandidateAccessibility,
  enrichCandidates,
} from '../packages/core/src/index.mjs';
import { TRAVEL_MODES } from '../packages/maps/src/index.mjs';

function candidate({
  id,
  venue = 'Burwood Tennis Courts',
  startTime = '2026-09-08T09:00:00.000Z',
  location = { lat: -33.88, lng: 151.1 },
  placeId = `${venue.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-place`,
} = {}) {
  return {
    id,
    venue,
    court: 'Court 1',
    startTime,
    durationMinutes: 60,
    features: {
      nextHourFree: true,
      localDate: '2026-09-08',
      localTime: '19:00',
      price: null,
      venue: {
        id: venue.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: venue,
        address: `${venue}, NSW, Australia`,
        location,
        placeId,
      },
    },
  };
}

function accessibilityAdapter({ venues }) {
  accessibilityAdapter.calls.push(venues);
  return venues.map((venue, index) => ({
    ...venue,
    accessibility: {
      origin: {
        placeId: 'origin-place',
        label: 'USYD',
      },
      walk: {
        durationMinutes: 50 + index,
        distanceMeters: 3000 + index,
        unavailableReason: null,
      },
      transit: {
        durationMinutes: 25 + index,
        distanceMeters: 4000 + index,
        departureTime: '2026-09-08T08:15:00.000Z',
        unavailableReason: null,
      },
      drive: {
        durationMinutes: 15 + index,
        distanceMeters: 3500 + index,
        unavailableReason: null,
      },
      source: 'google_routes',
      observedAt: '2026-09-08T00:00:00.000Z',
    },
  }));
}
accessibilityAdapter.calls = [];

test('same venue same slot bucket is enriched once and fan-out attaches facts to candidates', async () => {
  accessibilityAdapter.calls = [];
  const candidates = [
    candidate({ id: 'burwood-1' }),
    candidate({ id: 'burwood-2', court: 'Court 2' }),
  ];

  const enriched = await enrichCandidateAccessibility({
    candidates,
    origin: {
      label: 'USYD',
      lat: -33.8886,
      lng: 151.1873,
      placeId: 'origin-place',
    },
    accessibilityAdapter,
    observedAt: '2026-09-08T00:00:00.000Z',
  });

  assert.equal(accessibilityAdapter.calls.length, 1);
  assert.equal(accessibilityAdapter.calls[0].length, 1);
  assert.deepEqual(enriched[0].accessibility, enriched[1].accessibility);
  assert.equal(enriched[0].features.accessibility.walk.durationMinutes, 50);
  assert.equal(enriched[0].features.accessibility.transit.departureTime, '2026-09-08T08:15:00.000Z');
  assert.equal(enriched[0].features.accessibility.drive.durationMinutes, 15);
});

test('different venue candidates receive WALK TRANSIT DRIVE facts', async () => {
  accessibilityAdapter.calls = [];
  const enriched = await enrichCandidateAccessibility({
    candidates: [
      candidate({ id: 'burwood', venue: 'Burwood Tennis Courts' }),
      candidate({ id: 'strathfield', venue: 'Strathfield Sports Club', location: { lat: -33.87, lng: 151.08 } }),
    ],
    originText: 'USYD',
    accessibilityAdapter,
  });

  assert.equal(accessibilityAdapter.calls[0].length, 2);
  assert.equal(enriched[0].accessibility.walk.distanceMeters, 3000);
  assert.equal(enriched[0].accessibility.transit.durationMinutes, 25);
  assert.equal(enriched[0].accessibility.drive.durationMinutes, 15);
  assert.equal(enriched[1].accessibility.walk.distanceMeters, 3001);
});

test('single mode unavailable remains scoped to that mode on candidate', async () => {
  const [enriched] = await enrichCandidateAccessibility({
    candidates: [candidate({ id: 'burwood' })],
    originText: 'USYD',
    accessibilityAdapter: async ({ venues }) => venues.map((venue) => ({
      ...venue,
      accessibility: {
        origin: { placeId: 'origin-place', label: 'USYD' },
        walk: { durationMinutes: null, distanceMeters: null, unavailableReason: 'route_not_found' },
        transit: { durationMinutes: 25, distanceMeters: 4000, departureTime: '2026-09-08T08:15:00.000Z', unavailableReason: null },
        drive: { durationMinutes: 15, distanceMeters: 3500, unavailableReason: null },
        source: 'google_routes',
        observedAt: '2026-09-08T00:00:00.000Z',
      },
    })),
  });

  assert.equal(enriched.accessibility.walk.durationMinutes, null);
  assert.equal(enriched.accessibility.walk.unavailableReason, 'route_not_found');
  assert.equal(enriched.accessibility.transit.durationMinutes, 25);
  assert.equal(enriched.accessibility.drive.durationMinutes, 15);
});

test('maps provider failure marks accessibility unavailable without dropping candidate', async () => {
  const [enriched] = await enrichCandidateAccessibility({
    candidates: [candidate({ id: 'burwood' })],
    originText: 'USYD',
    observedAt: '2026-09-08T00:00:00.000Z',
    accessibilityAdapter: async () => {
      const error = new Error('routes failed');
      error.code = 'ROUTES_PROVIDER_ERROR';
      throw error;
    },
  });

  assert.equal(enriched.id, 'burwood');
  assert.equal(enriched.accessibility.walk.durationMinutes, null);
  assert.equal(enriched.accessibility.walk.unavailableReason, 'ROUTES_PROVIDER_ERROR');
  assert.equal(enriched.accessibility.transit.departureTime, '2026-09-08T08:15:00.000Z');
  assert.equal(enriched.features.accessibility.drive.unavailableReason, 'ROUTES_PROVIDER_ERROR');
});

test('no origin keeps deterministic unavailable accessibility when Maps is unavailable', async () => {
  const [enriched] = await enrichCandidateAccessibility({
    candidates: [candidate({ id: 'burwood' })],
    observedAt: '2026-09-08T00:00:00.000Z',
    accessibilityAdapter: async () => {
      const error = new Error('origin missing');
      error.code = 'LOCATION_UNRESOLVED';
      throw error;
    },
  });

  assert.equal(enriched.accessibility.origin.label, null);
  assert.equal(enriched.accessibility.transit.departureTime, '2026-09-08T08:15:00.000Z');
  assert.equal(enriched.accessibility.walk.unavailableReason, 'LOCATION_UNRESOLVED');
});

test('enrichCandidates can attach accessibility after weather and calendar facts', async () => {
  const [enriched] = await enrichCandidates({
    candidates: [candidate({ id: 'schema' })],
    weatherAdapter: async ({ slots }) => slots.map((slot) => ({
      candidateId: slot.id,
      startTime: slot.startTime,
      temperatureC: 21,
      feelsLikeC: 21,
      precipitationProbability: 0,
      precipitationMm: 0,
      windKph: 12,
      weatherCode: '0',
      source: 'test-weather',
      forecastAvailable: true,
    })),
    calendarAdapter: async () => ({ busy: [] }),
    accessibilityAdapter,
    accessibilityOptions: {
      originText: 'USYD',
    },
  });

  assert.equal(enriched.features.weather.temperatureC, 21);
  assert.equal(enriched.features.calendar.free, true);
  assert.equal(enriched.features.accessibility.source, 'google_routes');
});

test('real maps adapter groups by departure bucket rather than per candidate', async () => {
  const calls = [];
  const [first, second] = await enrichCandidateAccessibility({
    candidates: [
      candidate({ id: 'burwood-1' }),
      candidate({ id: 'burwood-2' }),
    ],
    origin: {
      label: 'USYD',
      lat: -33.8886,
      lng: 151.1873,
      placeId: 'origin-place',
    },
    provider: {
      async computeTravelTimes({ destinations, mode }) {
        calls.push({ mode, count: destinations.length });
        return destinations.map(() => ({
          durationMinutes: mode === TRAVEL_MODES.WALK ? 50 : mode === TRAVEL_MODES.TRANSIT ? 25 : 15,
          distanceMeters: 3000,
        }));
      },
    },
  });

  assert.deepEqual(calls.map((call) => `${call.mode}:${call.count}`).sort(), [
    'DRIVE:1',
    'TRANSIT:1',
    'WALK:1',
  ]);
  assert.equal(first.accessibility.transit.durationMinutes, 25);
  assert.deepEqual(first.accessibility, second.accessibility);
});
