import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CLUBSPARK_VENUES,
  buildBookingUrl,
  discoverVenues,
  readVenueAvailability,
} from '../packages/clubspark/src/index.mjs';
import { buildCandidate } from '../packages/core/src/index.mjs';

const fixtureVenue = {
  ...DEFAULT_CLUBSPARK_VENUES[0],
  id: 'clubspark-fixture',
  name: 'Fixture Seaside Tennis',
  venueSlug: 'fixture-tennis',
  officialUrl: 'https://play.tennis.com.au/fixture-tennis/booking/bookbydate',
};

const fixturePayload = {
  EarliestStartTime: 420,
  LatestEndTime: 600,
  MinimumInterval: 30,
  Resources: [{
    ID: 'court-one',
    Name: 'Court 1',
    Surface: 'Synthetic Grass',
    Days: [{
      Date: '2026-09-20T00:00:00',
      Sessions: [
        { Name: 'Default Schedule', StartTime: 420, EndTime: 600, Interval: 30, Capacity: 4, Cost: 15 },
        { Name: 'Booking', StartTime: 480, EndTime: 540, Interval: 60, Capacity: 0 },
      ],
    }],
  }],
};

test('ClubSpark registry contains verified public booking venues', () => {
  assert.deepEqual(DEFAULT_CLUBSPARK_VENUES.map((venue) => venue.name), [
    'Pinecourt Tennis Club',
    'Kiama Blowhole Tennis Club',
  ]);
  for (const venue of discoverVenues()) {
    assert.equal(venue.provider, 'clubspark');
    assert.equal(venue.sport, 'tennis');
    assert.equal(Number.isFinite(venue.location.lat), true);
  }
});

test('ClubSpark availability preserves price and court/date/time booking state', async () => {
  const slots = await readVenueAvailability(fixtureVenue, {
    date: '2026-09-20',
    observedAt: '2026-09-19T10:00:00+10:00',
    fetchImpl: async () => new Response(JSON.stringify(fixturePayload), {
      headers: { 'content-type': 'application/json' },
    }),
  });

  assert.deepEqual(slots.map((slot) => slot.startTime), [
    '2026-09-20T07:00:00+10:00',
    '2026-09-20T09:00:00+10:00',
  ]);
  assert.equal(slots[0].priceOptions[0].amount, 30);
  assert.equal(slots[0].bookingUrl, buildBookingUrl({
    venue: fixtureVenue,
    date: '2026-09-20',
    resourceIndex: 0,
    startMinutes: 420,
  }));

  const candidate = buildCandidate(slots[0]);
  assert.deepEqual(candidate.booking, {
    url: slots[0].bookingUrl,
    capability: 'court_date_time_preselected',
    provider: 'clubspark',
  });
});
