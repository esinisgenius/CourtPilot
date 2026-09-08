import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidate,
  validateCanonicalAvailability,
} from '../packages/core/src/index.mjs';
import {
  buildRankedCandidates,
  discoverTennisCourtsFromFacilities,
  extractRateTableFromHtml,
  normalizeAvailability,
  prepareAvailabilityRequest,
  toPublicAvailability,
} from '../packages/susf/src/index.mjs';

test('dynamically discovers multiple Tennis Courts', () => {
  const courts = discoverTennisCourtsFromFacilities([
    { facilityId: 'hard-1', label: 'Choose Tennis Hard Court 1 Read more Location: Sports and Aquatic Centre' },
    { facilityId: 'hard-2', label: 'Choose Tennis Hard Court 2 Read more Location: Sports and Aquatic Centre' },
    { facilityId: 'synthetic-4', label: 'Choose Tennis Synthetic Court 4 Read more Location: Sports and Aquatic Centre' },
    { facilityId: 'synthetic-5', label: 'Choose Tennis Synthetic Court 5 Read more Location: Sports and Aquatic Centre' },
    { facilityId: 'synthetic-6', label: 'Choose Tennis Synthetic Court 6 Read more Location: Sports and Aquatic Centre' },
  ]);

  assert.deepEqual(courts.map((court) => court.court), ['Court 1', 'Court 2', 'Court 4', 'Court 5', 'Court 6']);
});

test('dynamic discovery does not assume fixed Court count', () => {
  const courts = discoverTennisCourtsFromFacilities([
    { facilityId: 'only-2', label: 'Choose Tennis Hard Court 2' },
    { facilityId: 'only-8', label: 'Choose Tennis Synthetic Court 8' },
  ]);

  assert.deepEqual(courts.map((court) => court.court), ['Court 2', 'Court 8']);
});

test('dynamic discovery dedupes repeated nodes by facilityId', () => {
  const courts = discoverTennisCourtsFromFacilities([
    { facilityId: 'court-4', label: 'Choose Tennis Synthetic Court 4' },
    { facilityId: 'court-4', label: 'Choose Choose' },
    { facilityId: 'court-5', label: 'Choose Tennis Synthetic Court 5' },
  ]);

  assert.deepEqual(courts.map((court) => court.court), ['Court 4', 'Court 5']);
});

test('60min peak/offpeak rate table parses from serialized Prices', () => {
  const html = `
    <script>
      window.model = {"Prices":[
        {"Name":"Tennis Peak Fee","Amount":39.00},
        {"Name":"Tennis Off-Peak Fee","Amount":29.00}
      ]};
    </script>
  `;
  const rates = extractRateTableFromHtml(html);

  assert.deepEqual(rates, [
    { name: 'Tennis Peak Fee', amount: 39, currency: 'AUD', durationMinutes: 60 },
    { name: 'Tennis Off-Peak Fee', amount: 29, currency: 'AUD', durationMinutes: 60 },
  ]);
});

test('rate amount is number and currency is AUD', () => {
  const [rate] = extractRateTableFromHtml('{"Prices":[{"Name":"Tennis Off-Peak Fee","Amount":29.00}]}');

  assert.equal(typeof rate.amount, 'number');
  assert.equal(rate.currency, 'AUD');
});

test('missing rate table returns empty options clearly', () => {
  assert.deepEqual(extractRateTableFromHtml('<html>No prices here</html>'), []);
});

test('availability request construction uses public anti-forgery token and strips auth-specific headers', () => {
  const captured = {
    url: 'https://susf.perfectmind.com/39161/Clients/BookMe4LandingPages/FacilityAvailability',
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      authorization: 'Bearer should-not-copy',
      cookie: 'PMSessionId=should-not-copy',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: 'https://susf.perfectmind.com/some/facility/page',
      'x-requested-with': 'XMLHttpRequest',
    },
    postData: new URLSearchParams({
      facilityId: 'captured-facility',
      date: '2026-09-04T00:00:00.000Z',
      daysCount: '1',
      duration: '60',
      serviceId: 'runtime-service',
      __RequestVerificationToken: 'captured-token',
    }).toString() + '&durationIds%5B%5D=duration-a&durationIds%5B%5D=duration-b',
  };

  const request = prepareAvailabilityRequest(captured, {
    facilityId: 'runtime-facility',
    date: '2026-09-05',
    token: 'public-page-token',
    daysCount: 7,
    durationMinutes: 120,
  });
  const body = new URLSearchParams(request.body);

  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers.referer, undefined);
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.equal(body.get('facilityId'), 'runtime-facility');
  assert.equal(body.get('date'), '2026-09-05');
  assert.equal(body.get('daysCount'), '7');
  assert.equal(body.get('duration'), '120');
  assert.equal(body.get('serviceId'), 'runtime-service');
  assert.deepEqual(body.getAll('durationIds[]'), ['duration-a', 'duration-b']);
  assert.equal(body.get('__RequestVerificationToken'), 'public-page-token');
});

test('availability request construction fails when public anti-forgery token is unavailable', () => {
  const captured = {
    url: 'https://susf.perfectmind.com/39161/Clients/BookMe4LandingPages/FacilityAvailability',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    postData: 'facilityId=f&daysCount=7&duration=60&serviceId=s&durationIds%5B%5D=d',
  };

  assert.throws(() => prepareAvailabilityRequest(captured, {
    facilityId: 'f',
    date: '2026-09-05',
    token: null,
    daysCount: 7,
    durationMinutes: 60,
  }), /Missing public anti-forgery token/);
});

test('availability request construction fails when required runtime metadata is unavailable', () => {
  const captured = {
    url: 'https://susf.perfectmind.com/39161/Clients/BookMe4LandingPages/FacilityAvailability',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    postData: 'facilityId=f&daysCount=7&duration=60&__RequestVerificationToken=t',
  };

  assert.throws(() => prepareAvailabilityRequest(captured, {
    facilityId: 'f',
    date: '2026-09-05',
    token: 't',
    daysCount: 7,
    durationMinutes: 60,
  }), /serviceId, durationIds/);
});

test('60-minute availability normalization preserves start-time semantics', () => {
  const rows = normalizeAvailability({
    availabilities: [{
      Date: '/Date(1788544800000)/',
      BookingGroups: [{
        AvailableSpots: [
          { Time: { Hours: 8, Minutes: 0 }, Duration: { TotalMinutes: 60 } },
          { Time: { Hours: 9, Minutes: 0 }, Duration: { TotalMinutes: 60 } },
        ],
      }],
    }],
  }, 'Court 4', { durationMinutes: 60 });

  assert.deepEqual(rows.map((row) => row.start_time), ['08:00', '09:00']);
  assert.deepEqual(rows.map((row) => row.duration_minutes), [60, 60]);
});

test('successful SUSF acquisition with no available spots normalizes to empty rows', () => {
  const rows = normalizeAvailability({
    availabilities: [{
      Date: '/Date(1788544800000)/',
      BookingGroups: [{
        AvailableSpots: [],
      }],
    }],
  }, 'Court 4', { durationMinutes: 60 });

  assert.deepEqual(rows, []);
});

test('SUSF public availability exposes provider-agnostic canonical schema', () => {
  const slot = toPublicAvailability({
    court: 'Court 4',
    facilityId: 'facility-4',
    date: '2026-09-04',
    start_time: '08:00',
    duration_minutes: 60,
    next_hour_also_available: true,
    price_options: [{ name: 'Tennis Off-Peak Fee', amount: 29, currency: 'AUD', durationMinutes: 60 }],
    observedAt: '2026-09-04T00:00:00.000Z',
  });

  assert.equal(validateCanonicalAvailability(slot.canonical), slot.canonical);
  assert.deepEqual(slot.canonical, {
    provider: 'susf',
    venue: {
      id: 'susf',
      name: 'SUSF',
      providerVenueId: 'susf',
    },
    court: {
      id: 'susf-court-4',
      name: 'Court 4',
      providerCourtId: 'facility-4',
      surface: null,
    },
    slot: {
      start: '2026-09-04T08:00:00+10:00',
      end: '2026-09-04T09:00:00+10:00',
      durationMinutes: 60,
      available: true,
    },
    price: {
      amount: 29,
      currency: 'AUD',
      confidence: 'verified',
    },
    provenance: {
      source: 'live',
      auth: 'public',
      observedAt: '2026-09-04T00:00:00.000Z',
      availabilityMethod: 'direct',
    },
  });

  for (const providerSpecificKey of ['facilityId', 'resourceId', 'venueId', 'serviceId', 'durationIds']) {
    assert.equal(Object.hasOwn(slot.canonical, providerSpecificKey), false);
  }
});

test('SUSF legacy compatibility fields are derived from canonical', () => {
  const slot = toPublicAvailability({
    court: 'Court 5',
    facilityId: 'facility-5',
    date: '2026-09-04',
    start_time: '09:30',
    duration_minutes: 60,
    next_hour_also_available: false,
    price_options: [],
    observedAt: '2026-09-04T00:00:00.000Z',
  });

  assert.equal(slot.provider, slot.canonical.provider);
  assert.equal(slot.venue, slot.canonical.venue.name);
  assert.equal(slot.court, slot.canonical.court.name);
  assert.equal(slot.facilityId, slot.canonical.court.providerCourtId);
  assert.equal(slot.startTime, slot.canonical.slot.start);
  assert.equal(slot.durationMinutes, slot.canonical.slot.durationMinutes);
  assert.equal(slot.provenance.availabilityMethod, slot.canonical.provenance.availabilityMethod);
});

test('candidate builder uses canonical facts when legacy fields drift', () => {
  const slot = toPublicAvailability({
    court: 'Court 4',
    facilityId: 'facility-4',
    date: '2026-09-04',
    start_time: '08:00',
    duration_minutes: 60,
    next_hour_also_available: true,
    price_options: [{ name: 'Tennis Off-Peak Fee', amount: 29, currency: 'AUD', durationMinutes: 60 }],
    observedAt: '2026-09-04T00:00:00.000Z',
  });

  const candidate = buildCandidate({
    ...slot,
    venue: 'DRIFTED',
    court: 'DRIFTED',
    startTime: '2099-01-01T00:00:00Z',
    durationMinutes: 999,
  });

  assert.equal(candidate.venue, 'SUSF');
  assert.equal(candidate.court, 'Court 4');
  assert.equal(candidate.startTime, '2026-09-04T08:00:00+10:00');
  assert.equal(candidate.durationMinutes, 60);
  assert.equal(candidate.features.price, 29);
  assert.equal(candidate.source.availability.availabilityMethod, 'direct');
});

test('120-minute native availability is represented as 120-minute starts without synthesizing adjacent 60-minute rows', () => {
  const rows = normalizeAvailability({
    availabilities: [{
      Date: '/Date(1788544800000)/',
      BookingGroups: [{
        AvailableSpots: [
          { Time: { Hours: 8, Minutes: 0 }, Duration: { TotalMinutes: 120 } },
          { Time: { Hours: 10, Minutes: 0 }, Duration: { TotalMinutes: 120 } },
        ],
      }],
    }],
  }, 'Court 4', { durationMinutes: 120 }).map((row) => ({
    ...row,
    facilityId: 'facility-4',
  }));

  const ranked = buildRankedCandidates(rows, { durationMinutes: 120 });

  assert.deepEqual(ranked.map((row) => row.start_time), ['08:00', '10:00']);
  assert.deepEqual(ranked.map((row) => row.duration_minutes), [120, 120]);
  assert.equal(ranked[0].next_hour_start_time, '10:00');
  assert.equal(ranked[0].next_hour_also_available, true);
});

test('SUSF availability provenance flows into candidate source metadata', () => {
  const candidate = buildCandidate({
    venue: 'SUSF',
    court: 'Court 4',
    startTime: '2026-09-05T08:00:00',
    durationMinutes: 60,
    nextHourAlsoAvailable: true,
    priceOptions: [],
    provenance: {
      status: 'verified',
      source: 'susf_perfectmind',
      access: 'public',
      freshness: 'live',
    },
  });

  assert.deepEqual(candidate.source.availability, {
    status: 'verified',
    source: 'susf_perfectmind',
    access: 'public',
    freshness: 'live',
  });
});
