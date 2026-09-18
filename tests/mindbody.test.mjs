import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCandidate } from '../packages/core/src/index.mjs';
import { locationProviderRouting } from '../packages/agent/src/recommendation-service.mjs';
import {
  DEFAULT_MINDBODY_VENUES,
  getMindbodyAvailability,
  normalizeAvailability,
  parseSchedulePage,
} from '../packages/mindbody/src/index.mjs';

const venue = DEFAULT_MINDBODY_VENUES[0];
const schedule = {
  availability: {
    '2026-09-19': {
      Morning: [
        { time: '2026-09-19T07:00:00', availableStaff: ['100000021', '100000022'] },
        { time: '2026-09-19T08:00:00', availableStaff: ['100000022'] },
      ],
      Afternoon: [],
      Evening: [],
    },
  },
  staffMembers: [
    { id: '100000021', displayLabel: 'Rushcutters Court 3' },
    { id: '100000022', displayLabel: 'Rushcutters Court 4' },
  ],
};

function fixtureHtml() {
  return `<script>{"initialAvailabilityData":${JSON.stringify(schedule.availability)},"appointmentDetailsData":{},"staffMembers":${JSON.stringify(schedule.staffMembers)},"displayStaffNameWhenChoosingAnyStaff":false}</script>`;
}

test('Mindbody schedule parser reads public Next.js availability metadata', () => {
  assert.deepEqual(parseSchedulePage(fixtureHtml()), schedule);
  assert.deepEqual(parseSchedulePage(JSON.stringify(fixtureHtml())), schedule);
});

test('Mindbody normalization preserves court-level realtime slots and deepest stable booking page', () => {
  const rows = normalizeAvailability({
    venue,
    schedule,
    date: '2026-09-19',
    days: 1,
    observedAt: '2026-09-18T00:00:00.000Z',
  });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].provider, 'mindbody');
  assert.equal(rows[0].court, 'Rushcutters Court 3');
  assert.match(rows[0].bookingUrl, /serviceId=30/);
  assert.match(rows[0].bookingUrl, /staffId=100000021/);
  assert.equal(rows.find((row) => row.court === 'Rushcutters Court 4' && row.startTime.includes('07:00')).nextHourAlsoAvailable, true);

  const candidate = buildCandidate(rows[0]);
  assert.equal(candidate.booking.capability, 'booking_page');
  assert.equal(candidate.booking.provider, 'mindbody');
});

test('Mindbody acquisition fetches the public schedule without authentication', async () => {
  const requests = [];
  const rows = await getMindbodyAvailability({
    venues: [venue],
    date: '2026-09-19',
    days: 1,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(fixtureHtml());
    },
  });

  assert.equal(rows.length, 3);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers, undefined);
});

test('Mindbody unsupported durations return no fabricated availability', async () => {
  const rows = await getMindbodyAvailability({ durationMinutes: 90 });
  assert.deepEqual(rows, []);
});

test('Rushcutters Bay location routing activates the Mindbody provider', () => {
  const routing = locationProviderRouting({
    location: 'Rushcutters Bay',
    locationSource: 'explicit',
  });
  assert.equal(routing.activeProviderIds.includes('mindbody'), true);
  assert.equal(routing.matchedVenues.some((item) => item.id === venue.id), true);
});
