import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidate,
  validateCanonicalAvailability,
} from '../packages/core/src/index.mjs';
import {
  DEFAULT_INTRAC_VENUES,
  IntracAvailabilityError,
  buildScheduleUrl,
  discoverVenues,
  parseScheduleHtml,
  readAvailability,
} from '../packages/intrac/src/index.mjs';

const venueConfig = {
  id: 'fixture-intrac-moore-park',
  name: 'Fixture Moore Park',
  suburb: 'Moore Park',
  provider: 'intrac',
  officialUrl: 'https://parklands.intrac.com.au/sports/schedule.cfm?location=72',
  auditCourtCount: 4,
};

const fixtureSchedule = `
  <table>
    <tr align="center" valign="middle"><td></td><td colspan=4><b>Moore Park</b></td></tr>
    <tr align="center" valign="middle">
      <td class="book">Time</td>
      <td class="book"><b>Court 1</b></td>
      <td class="book"><b>Court 2</b></td>
      <td class="book"><b>Court 3</b></td>
      <td class="book"><b>Court 4</b></td>
    </tr>
    <tr>
      <td class="book">2:30pm</td>
      <td class="book"><a class="book" href="javascript:pop('book.cfm?location=72&amp;date=2026-09-04&amp;start=14:30&amp;court=479%27)"> </a></td>
      <td bgcolor="#f6891f" class="book">&nbsp;</td>
      <td bgcolor="#dddddd" class="book">&nbsp;</td>
      <td class="book"><a class="book" href="javascript:pop('book.cfm?location=72&amp;date=2026-09-04&amp;start=14:30&amp;court=482%27)"> </a></td>
    </tr>
    <tr>
      <td class="book">3:00pm</td>
      <td colspan="2" bgcolor="#f6891f" class="book">&nbsp;</td>
      <td class="book"><a class="book" href="javascript:pop('book.cfm?location=72&amp;date=2026-09-04&amp;start=15:00&amp;court=481%27)"> </a></td>
      <td class="book"><a class="book" href="javascript:pop('book.cfm?location=72&amp;date=2026-09-04&amp;start=15:00&amp;court=482%27)"> </a></td>
    </tr>
    <tr>
      <td class="book">3:30pm</td>
      <td bgcolor="#dddddd" class="book">&nbsp;</td>
      <td class="book"><a class="book" href="javascript:pop('book.cfm?location=72&amp;date=2026-09-04&amp;start=15:30&amp;court=480%27)"> </a></td>
      <td class="book"><a class="book" href="javascript:pop('book.cfm?location=72&amp;date=2026-09-04&amp;start=15:30&amp;court=481%27)"> </a></td>
      <td bgcolor="#f6891f" class="book">&nbsp;</td>
    </tr>
  </table>
`;

const incompleteIdentitySchedule = `
  <table>
    <tr><td class="book">Time</td><td class="book"><b>Court 1</b></td><td class="book"><b>Court 2</b></td></tr>
    <tr>
      <td class="book">2:30pm</td>
      <td class="book"><a class="book" href="javascript:pop('book.cfm?location=72&amp;date=2026-09-04&amp;start=14:30&amp;court=479%27)"> </a></td>
      <td bgcolor="#f6891f" class="book">&nbsp;</td>
    </tr>
  </table>
`;

const camperdownSchedule = `
  <table>
    <tr><td class="book">Time</td><td class="book"><b>Court 1</b></td><td class="book"><b>Court 2</b></td></tr>
    <tr>
      <td class="book">8:00am</td>
      <td class="book"><a class="book" href="javascript:pop('reserve.cfm?location=70&amp;date=2026-09-09&amp;start=08:00&amp;court=439')"> </a></td>
      <td bgcolor="#cccccc" class="book">Closed</td>
    </tr>
    <tr>
      <td class="book">8:30am</td>
      <td bgcolor="#ff9900" class="book">&nbsp;</td>
      <td class="book"><a class="book" href="javascript:pop('reserve.cfm?location=70&amp;date=2026-09-09&amp;start=08:30&amp;court=438')"> </a></td>
    </tr>
  </table>
`;

function mockFetch({ html = fixtureSchedule, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(status === 200 ? html : 'Forbidden', {
      status,
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('Intrac default registry contains production metadata for enabled venues', () => {
  assert.equal(DEFAULT_INTRAC_VENUES.length, 3);
  assert.deepEqual(DEFAULT_INTRAC_VENUES.map((venue) => venue.id), [
    'intrac-moore-park-tennis-courts',
    'intrac-camperdown-tennis',
    'intrac-centennial-parklands-sports-centre',
  ]);
  for (const venue of DEFAULT_INTRAC_VENUES) {
    assert.equal(venue.provider, 'intrac');
    assert.equal(venue.enabled, true);
    assert.equal(typeof venue.locationId, 'string');
    assert.equal(typeof venue.auditCourtCount, 'number');
  }
});

test('Intrac discovery reads location id from schedule URL', () => {
  const [venue] = discoverVenues({ venues: [venueConfig] });

  assert.equal(venue.provider, 'intrac');
  assert.equal(venue.origin, 'https://parklands.intrac.com.au');
  assert.equal(venue.locationId, '72');
});

test('Intrac schedule URL uses public location/date endpoint', () => {
  const [venue] = discoverVenues({ venues: [venueConfig] });
  assert.equal(buildScheduleUrl({ venue, date: '2026-09-04' }), 'https://parklands.intrac.com.au/sports/schedule.cfm?location=72&date=2026-09-04');
});

test('Intrac parses available, booked, and unavailable schedule states', () => {
  const schedule = parseScheduleHtml(fixtureSchedule, { locationId: '72' });

  assert.deepEqual(schedule.courts, [
    { index: 0, name: 'Court 1' },
    { index: 1, name: 'Court 2' },
    { index: 2, name: 'Court 3' },
    { index: 3, name: 'Court 4' },
  ]);
  assert.equal(schedule.slotStates.find((state) => state.courtName === 'Court 1' && state.time === '1430').status, 'available');
  assert.equal(schedule.slotStates.find((state) => state.courtName === 'Court 2' && state.time === '1430').status, 'booked');
  assert.equal(schedule.slotStates.find((state) => state.courtName === 'Court 3' && state.time === '1430').status, 'unavailable');
  assert.deepEqual(schedule.slotStates.filter((state) => state.time === '1500').map((state) => state.status), [
    'booked',
    'booked',
    'available',
    'available',
  ]);
});

test('Intrac parses reserve.cfm availability links used by Camperdown', () => {
  const schedule = parseScheduleHtml(camperdownSchedule, { locationId: '70' });

  assert.equal(schedule.availableLinks.length, 2);
  assert.deepEqual(schedule.availableLinks.map((link) => link.providerCourtId), ['439', '438']);
  assert.equal(schedule.slotStates.find((state) => state.courtName === 'Court 2' && state.time === '0800').status, 'unavailable');
  assert.equal(schedule.slotStates.find((state) => state.courtName === 'Court 1' && state.time === '0830').status, 'booked');
});

test('Intrac anonymous acquisition sends browser-like UA and no cookies/auth headers', async () => {
  const fetchImpl = mockFetch();
  await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].options.method, 'GET');
  assert.match(fetchImpl.calls[0].options.headers['user-agent'], /Chrome/);
  assert.equal(fetchImpl.calls[0].options.headers.cookie, undefined);
  assert.equal(fetchImpl.calls[0].options.headers.authorization, undefined);
  assert.equal(fetchImpl.calls[0].options.headers['x-csrf-token'], undefined);
});

test('Intrac venue-specific referer is sent only when configured', async () => {
  const fetchImpl = mockFetch();
  await readAvailability({
    venues: [{
      ...venueConfig,
      referer: 'https://parklandssports.com.au/online-court-bookings/',
    }],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl,
  });

  assert.equal(fetchImpl.calls[0].options.headers.referer, 'https://parklandssports.com.au/online-court-bookings/');
});

test('Intrac availability emits canonical schema with stable venue/court identity', async () => {
  const [slot] = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch(),
  });

  assert.equal(validateCanonicalAvailability(slot.canonical), slot.canonical);
  assert.deepEqual(slot.canonical, {
    provider: 'intrac',
    venue: {
      id: 'fixture-intrac-moore-park',
      name: 'Fixture Moore Park',
      providerVenueId: '72',
    },
    court: {
      id: 'intrac-court-72-479',
      name: 'Court 1',
      providerCourtId: '479',
      surface: null,
    },
    slot: {
      start: '2026-09-04T14:30:00+10:00',
      end: '2026-09-04T15:30:00+10:00',
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
      availabilityMethod: 'direct_first_party_html',
    },
  });
  assert.equal(slot.resourceId, '479');
  assert.equal(slot.locationId, '72');
  assert.equal(slot.bookingUrl, 'https://parklands.intrac.com.au/book.cfm?location=72&date=2026-09-04&start=14:30&court=479%27');
});

test('Intrac next-hour availability is derived from same-court adjacent starts', async () => {
  const availability = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 30,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch(),
  });
  const court4At1430 = availability.find((slot) => slot.resourceId === '482' && slot.startTime === '2026-09-04T14:30:00+10:00');
  const court1At1430 = availability.find((slot) => slot.resourceId === '479' && slot.startTime === '2026-09-04T14:30:00+10:00');

  assert.equal(court4At1430.nextHourAlsoAvailable, true);
  assert.equal(court1At1430.nextHourAlsoAvailable, false);
});

test('Intrac slots flow through existing candidate pipeline', async () => {
  const [slot] = await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch(),
  });
  const candidate = buildCandidate(slot);

  assert.equal(candidate.venue, 'Fixture Moore Park');
  assert.equal(candidate.source.provider, 'intrac');
  assert.equal(candidate.source.availability.source, 'live');
  assert.equal(candidate.source.availability.availabilityMethod, 'direct_first_party_html');
  assert.equal(candidate.features.price, null);
});

test('Intrac incomplete court id discovery fails explicitly instead of dropping a court', async () => {
  await assert.rejects(() => readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch({ html: incompleteIdentitySchedule }),
  }), (error) => {
    assert.equal(error instanceof IntracAvailabilityError, true);
    assert.equal(error.code, 'INTRAC_PARTIAL_FAILURE');
    assert.equal(error.failures[0].code, 'INTRAC_COURT_ID_INCOMPLETE');
    assert.match(error.failures[0].message, /Court 2/);
    return true;
  });
});

test('Intrac HTTP 403 is explicit browser-UA/provider failure', async () => {
  await assert.rejects(() => readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    durationMinutes: 60,
    identityDiscoveryDays: 1,
    fetchImpl: mockFetch({ status: 403 }),
  }), (error) => {
    assert.equal(error.code, 'INTRAC_PARTIAL_FAILURE');
    assert.equal(error.failures[0].code, 'INTRAC_BROWSER_UA_REQUIRED');
    return true;
  });
});
