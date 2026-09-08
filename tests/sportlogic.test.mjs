import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidate,
  validateCanonicalAvailability,
} from '../packages/core/src/index.mjs';
import {
  DEFAULT_SPORTLOGIC_VENUES,
  SportLogicAvailabilityError,
  buildAvailabilityUrl,
  discoverVenues,
  parseBootstrapMetadata,
  parseGridFragment,
  readAvailability,
} from '../packages/sportlogic/src/index.mjs';

const venueConfig = {
  id: 'fixture-sportlogic-burwood',
  name: 'Fixture SportLogic Courts',
  suburb: 'Fixture',
  provider: 'sportlogic',
  officialUrl: 'https://www.tennisvenues.com.au/booking/fixture-courts',
  auditCourtCount: 2,
};

const bootstrapHtml = `
  <script>
    $.ajax({
      url: '/booking/fixture-courts/fetch-booking-data',
      data: { client_id: 'fixture-courts', venue_id: '1', resource_id: '', date: v4_current_date_str, view: 'v4' }
    });
  </script>
  <p><b>Court Hire rates</b><br>$23 per hour<br><b>Hours of operation</b><br>8am to 10pm - Mon to Sun</p>
`;

const fixtureFragment = `
  <table class="v4-grid" id="v4_grid">
    <thead>
      <tr>
        <th class="v4-time-col">&nbsp;</th>
        <th class="v4-court-col" data-court-index="0">Court 1</th>
        <th class="v4-court-col" data-court-index="1">Court 2</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="v4-time-col">2pm</td>
        <td class="v4-court-col v4-slot-unavailable" data-court-index="0">&nbsp;</td>
        <td class="v4-court-col v4-slot-unavailable" data-court-index="1">&nbsp;</td>
      </tr>
      <tr>
        <td class="v4-time-col">&nbsp;</td>
        <td class="v4-court-col v4-slot-available" data-court-index="0"><a href="/booking/request?v=fixture-courts&amp;id=C1&amp;d=20260904&amp;t=1430&amp;cm=true">2:30pm</a></td>
        <td class="v4-court-col v4-slot-available" data-court-index="1"><a href="/booking/request?v=fixture-courts&amp;id=C2&amp;d=20260904&amp;t=1430&amp;cm=true">2:30pm</a></td>
      </tr>
      <tr>
        <td class="v4-time-col">3pm</td>
        <td class="v4-court-col v4-slot-available" data-court-index="0"><a href="/booking/request?v=fixture-courts&amp;id=C1&amp;d=20260904&amp;t=1500&amp;cm=true">3:00pm</a></td>
        <td class="v4-court-col v4-slot-unavailable" data-court-index="1">Booked</td>
      </tr>
    </tbody>
  </table>
`;

const incompleteIdentityFragment = `
  <table class="v4-grid" id="v4_grid">
    <thead>
      <tr>
        <th class="v4-time-col">&nbsp;</th>
        <th class="v4-court-col" data-court-index="0">Court 1</th>
        <th class="v4-court-col" data-court-index="1">Court 2</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="v4-time-col">2pm</td>
        <td class="v4-court-col v4-slot-available" data-court-index="0"><a href="/booking/request?v=fixture-courts&amp;id=C1&amp;d=20260904&amp;t=1430&amp;cm=true">2:30pm</a></td>
        <td class="v4-court-col v4-slot-unavailable" data-court-index="1">Booked</td>
      </tr>
    </tbody>
  </table>
`;

function mockBootstrap() {
  return async () => ({
    html: bootstrapHtml,
    cookieHeader: 'aws-waf-token=anonymous; SESSION=anonymous',
  });
}

function mockFetch({ fragment = fixtureFragment, wafChallenge = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (wafChallenge) return new Response('<html>AWS WAF</html>', { status: 202 });
    return new Response(fragment, {
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('SportLogic default registry contains Burwood production metadata', () => {
  assert.equal(DEFAULT_SPORTLOGIC_VENUES.length, 1);
  const [venue] = DEFAULT_SPORTLOGIC_VENUES;
  assert.equal(venue.provider, 'sportlogic');
  assert.equal(venue.name, 'Burwood Tennis Courts');
  assert.equal(venue.clientId, 'burwood-tennis-courts');
  assert.equal(venue.venueId, '1');
  assert.equal(venue.enabled, true);
  assert.equal(venue.auditCourtCount, 2);
});

test('SportLogic discovery reads client id from public booking URL', () => {
  const [venue] = discoverVenues({ venues: [venueConfig] });

  assert.equal(venue.provider, 'sportlogic');
  assert.equal(venue.origin, 'https://www.tennisvenues.com.au');
  assert.equal(venue.clientId, 'fixture-courts');
});

test('SportLogic bootstrap metadata extracts endpoint, public venue id and price', () => {
  const [venue] = discoverVenues({ venues: [venueConfig] });
  assert.deepEqual(parseBootstrapMetadata(bootstrapHtml, venue), {
    endpointUrl: 'https://www.tennisvenues.com.au/booking/fixture-courts/fetch-booking-data',
    clientId: 'fixture-courts',
    venueId: '1',
    price: {
      amount: 23,
      currency: 'AUD',
      confidence: 'verified',
    },
  });
});

test('SportLogic availability URL uses public v4 HTML fragment endpoint', () => {
  assert.equal(buildAvailabilityUrl({
    endpointUrl: 'https://www.tennisvenues.com.au/booking/fixture-courts/fetch-booking-data',
    clientId: 'fixture-courts',
    venueId: '1',
    date: '2026-09-04',
  }).replace(/_=\d+$/, '_=CACHE'), 'https://www.tennisvenues.com.au/booking/fixture-courts/fetch-booking-data?client_id=fixture-courts&venue_id=1&resource_id=&date=20260904&view=v4&_=CACHE');
});

test('SportLogic parses court headers and available booking links from grid HTML', () => {
  assert.deepEqual(parseGridFragment(fixtureFragment), {
    courts: [
      { index: 0, name: 'Court 1' },
      { index: 1, name: 'Court 2' },
    ],
    availableLinks: [
      {
        courtIndex: 0,
        courtId: 'C1',
        date: '2026-09-04',
        time: '1430',
        label: '2:30pm',
        href: '/booking/request?v=fixture-courts&id=C1&d=20260904&t=1430&cm=true',
      },
      {
        courtIndex: 1,
        courtId: 'C2',
        date: '2026-09-04',
        time: '1430',
        label: '2:30pm',
        href: '/booking/request?v=fixture-courts&id=C2&d=20260904&t=1430&cm=true',
      },
      {
        courtIndex: 0,
        courtId: 'C1',
        date: '2026-09-04',
        time: '1500',
        label: '3:00pm',
        href: '/booking/request?v=fixture-courts&id=C1&d=20260904&t=1500&cm=true',
      },
    ],
  });
});

test('SportLogic anonymous acquisition uses bootstrap cookies and no auth headers', async () => {
  const fetchImpl = mockFetch();
  await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl,
    bootstrapSessionImpl: mockBootstrap(),
  });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].options.method, 'GET');
  assert.equal(fetchImpl.calls[0].options.headers.cookie, 'aws-waf-token=anonymous; SESSION=anonymous');
  assert.equal(fetchImpl.calls[0].options.headers.authorization, undefined);
  assert.equal(fetchImpl.calls[0].options.headers['x-csrf-token'], undefined);
});

test('SportLogic availability emits canonical schema with stable venue/court identity', async () => {
  const [slot] = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch(),
    bootstrapSessionImpl: mockBootstrap(),
  });

  assert.equal(validateCanonicalAvailability(slot.canonical), slot.canonical);
  assert.deepEqual(slot.canonical, {
    provider: 'sportlogic',
    venue: {
      id: 'fixture-sportlogic-burwood',
      name: 'Fixture SportLogic Courts',
      providerVenueId: 'fixture-courts',
    },
    court: {
      id: 'sportlogic-court-fixture-courts-C1',
      name: 'Court 1',
      providerCourtId: 'C1',
      surface: null,
    },
    slot: {
      start: '2026-09-04T14:30:00+10:00',
      end: '2026-09-04T15:30:00+10:00',
      durationMinutes: 60,
      available: true,
    },
    price: {
      amount: 23,
      currency: 'AUD',
      confidence: 'verified',
    },
    provenance: {
      source: 'live',
      auth: 'public',
      observedAt: slot.canonical.provenance.observedAt,
      availabilityMethod: 'direct_first_party_html',
    },
  });
  assert.equal(slot.resourceId, 'C1');
  assert.equal(slot.bookingUrl, 'https://www.tennisvenues.com.au/booking/request?v=fixture-courts&id=C1&d=20260904&t=1430&cm=true');
});

test('SportLogic next-hour availability is derived from same-court adjacent starts', async () => {
  const availability = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 30,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch(),
    bootstrapSessionImpl: mockBootstrap(),
  });
  const court1At1430 = availability.find((slot) => slot.resourceId === 'C1' && slot.startTime === '2026-09-04T14:30:00+10:00');
  const court2At1430 = availability.find((slot) => slot.resourceId === 'C2' && slot.startTime === '2026-09-04T14:30:00+10:00');

  assert.equal(court1At1430.nextHourAlsoAvailable, true);
  assert.equal(court2At1430.nextHourAlsoAvailable, false);
});

test('SportLogic slots flow through existing candidate pipeline', async () => {
  const [slot] = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch(),
    bootstrapSessionImpl: mockBootstrap(),
  });
  const candidate = buildCandidate(slot);

  assert.equal(candidate.venue, 'Fixture SportLogic Courts');
  assert.equal(candidate.source.provider, 'sportlogic');
  assert.equal(candidate.source.availability.source, 'live');
  assert.equal(candidate.source.availability.availabilityMethod, 'direct_first_party_html');
  assert.equal(candidate.features.price, 23);
});

test('SportLogic incomplete court id discovery fails explicitly instead of silently dropping a court', async () => {
  await assert.rejects(() => readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch({ fragment: incompleteIdentityFragment }),
    bootstrapSessionImpl: mockBootstrap(),
  }), (error) => {
    assert.equal(error instanceof SportLogicAvailabilityError, true);
    assert.equal(error.code, 'SPORTLOGIC_PARTIAL_FAILURE');
    assert.equal(error.failures[0].code, 'SPORTLOGIC_COURT_ID_INCOMPLETE');
    assert.match(error.failures[0].message, /Court 2/);
    return true;
  });
});

test('SportLogic WAF challenge after bootstrap is an explicit provider failure', async () => {
  await assert.rejects(() => readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch({ wafChallenge: true }),
    bootstrapSessionImpl: mockBootstrap(),
  }), (error) => {
    assert.equal(error.code, 'SPORTLOGIC_PARTIAL_FAILURE');
    assert.equal(error.failures[0].code, 'SPORTLOGIC_BOOTSTRAP_REQUIRED');
    return true;
  });
});
