import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TtlCache,
  TRAVEL_MODES,
  deriveTransitDepartureTime,
  enrichVenueAccessibility,
  resolveVenueLocation,
} from '../packages/maps/src/index.mjs';

const ORIGIN = {
  label: 'University of Sydney',
  lat: -33.8886,
  lng: 151.1873,
  placeId: 'origin-place',
};

function provider({ failModes = new Set() } = {}) {
  return {
    geocodeCalls: [],
    matrixCalls: [],
    async geocode({ query }) {
      this.geocodeCalls.push(query);
      const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return {
        label: query,
        lat: query === 'University of Sydney' ? ORIGIN.lat : -33.9,
        lng: query === 'University of Sydney' ? ORIGIN.lng : 151.1 + this.geocodeCalls.length / 100,
        placeId: `${slug}-place`,
      };
    },
    async computeTravelTimes({ origin, destinations, mode, targetTime, targetTimeType }) {
      this.matrixCalls.push({
        origin,
        destinationCount: destinations.length,
        mode,
        targetTime,
        targetTimeType,
      });
      if (failModes.has(mode)) throw new Error(`${mode} failed`);
      return destinations.map((_, index) => ({
        durationMinutes: mode === TRAVEL_MODES.WALK ? 40 + index : mode === TRAVEL_MODES.TRANSIT ? 20 + index : 12 + index,
        distanceMeters: 1000 + index,
      }));
    },
  };
}

test('venue location resolution caches geocoded venue locations', async () => {
  const mapsProvider = provider();
  const cache = new TtlCache();
  const venue = { id: 'burwood', name: 'Burwood' };

  const first = await resolveVenueLocation(venue, { provider: mapsProvider, cache });
  const second = await resolveVenueLocation(venue, { provider: mapsProvider, cache });

  assert.equal(first.placeId, 'burwood-place');
  assert.equal(second.placeId, 'burwood-place');
  assert.deepEqual(mapsProvider.geocodeCalls, ['Burwood']);
});

test('multimodal accessibility batches one origin to multiple venues per mode', async () => {
  const mapsProvider = provider();
  const enriched = await enrichVenueAccessibility({
    originText: 'University of Sydney',
    venues: [
      { id: 'burwood', name: 'Burwood' },
      { id: 'strathfield', name: 'Strathfield' },
      { id: 'moore-park', name: 'Moore Park' },
    ],
    provider: mapsProvider,
    cache: new TtlCache(),
    transitDepartureTime: '2026-09-08T08:00:00.000Z',
    observedAt: '2026-09-08T00:00:00.000Z',
  });

  assert.equal(enriched.length, 3);
  assert.equal(mapsProvider.matrixCalls.length, 3);
  assert.deepEqual(mapsProvider.matrixCalls.map((call) => call.mode).sort(), [
    TRAVEL_MODES.DRIVE,
    TRAVEL_MODES.TRANSIT,
    TRAVEL_MODES.WALK,
  ]);
  assert.equal(mapsProvider.matrixCalls.every((call) => call.destinationCount === 3), true);
  assert.equal(mapsProvider.matrixCalls.find((call) => call.mode === TRAVEL_MODES.TRANSIT).targetTime, '2026-09-08T08:00:00.000Z');
  assert.equal(enriched[0].accessibility.origin.placeId, 'university-of-sydney-place');
  assert.equal(enriched[0].accessibility.walk.durationMinutes, 40);
  assert.equal(enriched[0].accessibility.transit.departureTime, '2026-09-08T08:00:00.000Z');
  assert.equal(enriched[0].accessibility.drive.durationMinutes, 12);
  assert.equal(enriched[0].accessibility.source, 'google_routes');
  assert.equal(enriched[0].accessibility.observedAt, '2026-09-08T00:00:00.000Z');
});

test('candidate slot start time derives transit departure time deterministically', () => {
  assert.equal(deriveTransitDepartureTime({
    startTime: '2026-09-08T09:00:00.000Z',
  }), '2026-09-08T08:15:00.000Z');
});

test('different candidate slot departure times are grouped into separate transit batches', async () => {
  const mapsProvider = provider();
  await enrichVenueAccessibility({
    origin: ORIGIN,
    venues: [
      {
        id: 'a',
        name: 'A',
        location: { lat: -33.87, lng: 151.1 },
        placeId: 'a-place',
        startTime: '2026-09-08T09:00:00.000Z',
      },
      {
        id: 'b',
        name: 'B',
        location: { lat: -33.88, lng: 151.2 },
        placeId: 'b-place',
        startTime: '2026-09-08T10:00:00.000Z',
      },
    ],
    provider: mapsProvider,
    cache: new TtlCache(),
  });

  const transitCalls = mapsProvider.matrixCalls.filter((call) => call.mode === TRAVEL_MODES.TRANSIT);
  assert.equal(transitCalls.length, 2);
  assert.deepEqual(transitCalls.map((call) => call.targetTime), [
    '2026-09-08T08:15:00.000Z',
    '2026-09-08T09:15:00.000Z',
  ]);
});

test('mode provider failure marks only that accessibility mode unavailable', async () => {
  const mapsProvider = provider({ failModes: new Set([TRAVEL_MODES.WALK]) });
  const [venue] = await enrichVenueAccessibility({
    origin: ORIGIN,
    venues: [{
      id: 'burwood',
      name: 'Burwood',
      location: { lat: -33.87, lng: 151.1 },
      placeId: 'burwood-place',
    }],
    provider: mapsProvider,
    cache: new TtlCache(),
    transitDepartureTime: '2026-09-08T08:00:00.000Z',
  });

  assert.equal(venue.accessibility.walk.durationMinutes, null);
  assert.equal(venue.accessibility.walk.unavailableReason, 'ROUTES_PROVIDER_ERROR');
  assert.equal(venue.accessibility.transit.durationMinutes, 20);
  assert.equal(venue.accessibility.drive.durationMinutes, 12);
});
