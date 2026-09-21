import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCanonicalVenueContract,
  buildCandidate,
  validateCanonicalAvailability,
} from '../packages/core/src/index.mjs';
import {
  buildCourtBookingUrl,
  buildRankedCandidates,
  defaultSearchHeadlessMode,
  discoverTennisCourtsFromFacilities,
  extractRateTableFromHtml,
  selectSusfSlotPrice,
  isAvailabilityTriggerText,
  normalizeAvailability,
  prepareAvailabilityRequest,
  toPublicAvailability,
} from '../packages/susf/src/index.mjs';
import { createPublicHttpSession, verificationTokenFromHtml } from '../packages/susf/src/public-client.mjs';

test('builds a stable provider court page from the configured SUSF booking URL', () => {
  const url = buildCourtBookingUrl(
    'https://susf.perfectmind.com/39161/Clients/BookMe4FacilityList/List?calendarId=calendar-fixture&widgetId=widget-fixture&embed=False',
    'facility-4',
  );

  assert.equal(
    url,
    'https://susf.perfectmind.com/39161/Clients/BookMe4LandingPages/Facility?facilityId=facility-4&widgetId=widget-fixture&calendarId=calendar-fixture',
  );
});

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

test('SUSF slot price selects off-peak rates on weekdays and peak rates on weekends', () => {
  const court123Rates = [
    { name: 'Tennis Peak Fee', amount: 50, currency: 'AUD', durationMinutes: 60 },
    { name: 'Tennis Off-Peak Fee', amount: 39, currency: 'AUD', durationMinutes: 60 },
  ];
  const court456Rates = [
    { name: 'Tennis Off-Peak Fee', amount: 29, currency: 'AUD', durationMinutes: 60 },
    { name: 'Tennis Peak Fee', amount: 39, currency: 'AUD', durationMinutes: 60 },
  ];

  assert.deepEqual(selectSusfSlotPrice('2026-09-18', court123Rates), {
    amount: 39,
    currency: 'AUD',
    confidence: 'verified',
  });
  assert.equal(selectSusfSlotPrice('2026-09-19', court123Rates).amount, 50);
  assert.equal(selectSusfSlotPrice('2026-09-18', court456Rates).amount, 29);
  assert.equal(selectSusfSlotPrice('2026-09-20', court456Rates).amount, 39);
});

test('SUSF slot price stays unknown when the applicable named rate is absent', () => {
  assert.deepEqual(selectSusfSlotPrice('2026-09-19', [
    { name: 'Tennis Off-Peak Fee', amount: 29, currency: 'AUD', durationMinutes: 60 },
  ]), {
    amount: null,
    currency: 'AUD',
    confidence: 'unknown',
  });
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

test('public HTTP session extracts anti-forgery token and cookies without Chromium', async () => {
  const calls = [];
  const session = await createPublicHttpSession('https://example.test/booking', {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        url,
        headers: { getSetCookie: () => ['PMSessionId=session; Path=/; HttpOnly', 'ClusterId=default; Path=/'] },
        async text() {
          return '<input name="__RequestVerificationToken" type="hidden" value="public-token">';
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(session.token, 'public-token');
  assert.equal(session.cookie, 'PMSessionId=session; ClusterId=default');
});

test('verification token extraction supports value-before-name markup', () => {
  assert.equal(
    verificationTokenFromHtml('<input value="token-two" type="hidden" name="__RequestVerificationToken">'),
    'token-two',
  );
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

test('SUSF availability discovery does not treat booking or login controls as search triggers', () => {
  assert.equal(isAvailabilityTriggerText('Choose Tennis Synthetic Court 4'), true);
  assert.equal(isAvailabilityTriggerText('View availability'), true);
  assert.equal(isAvailabilityTriggerText('Book Tennis Synthetic Court 4'), false);
  assert.equal(isAvailabilityTriggerText('Reserve Court 4'), false);
  assert.equal(isAvailabilityTriggerText('Sign in to book'), false);
});

test('SUSF search availability defaults to headless unless explicitly disabled', () => {
  const previous = process.env.HEADLESS;
  try {
    delete process.env.HEADLESS;
    assert.equal(defaultSearchHeadlessMode(), true);
    process.env.HEADLESS = '0';
    assert.equal(defaultSearchHeadlessMode(), false);
  } finally {
    if (previous === undefined) {
      delete process.env.HEADLESS;
    } else {
      process.env.HEADLESS = previous;
    }
  }
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
    officialUrl: 'https://susf.perfectmind.com/39161/Clients/BookMe4FacilityList/List?calendarId=fixture',
  });

  assert.equal(validateCanonicalAvailability(slot.canonical), slot.canonical);
  assertCanonicalVenueContract(slot, {
    configuredVenue: {
      id: 'susf-tennis',
      name: 'Sydney Uni Sport Tennis Courts',
      provider: 'susf',
      providerVenueId: 'susf',
      location: { lat: -33.8886, lng: 151.1873 },
    },
  });
  assert.deepEqual(slot.canonical, {
    provider: 'susf',
    venue: {
      id: 'susf-tennis',
      name: 'Sydney Uni Sport Tennis Courts',
      providerVenueId: 'susf',
      location: {
        lat: -33.8886,
        lng: 151.1873,
      },
      suburb: 'Camperdown',
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
    eligibility: {
      sport: {
        type: 'tennis',
        proof: 'verified_booking_page',
      },
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
  const bookingUrl = 'https://susf.perfectmind.com/39161/Clients/BookMe4LandingPages/Facility?facilityId=facility-4&widgetId=widget-fixture&calendarId=calendar-fixture';
  const slot = toPublicAvailability({
    court: 'Court 4',
    facilityId: 'facility-4',
    date: '2026-09-04',
    start_time: '08:00',
    duration_minutes: 60,
    next_hour_also_available: true,
    price_options: [{ name: 'Tennis Off-Peak Fee', amount: 29, currency: 'AUD', durationMinutes: 60 }],
    observedAt: '2026-09-04T00:00:00.000Z',
    officialUrl: 'https://susf.perfectmind.com/39161/Clients/BookMe4FacilityList/List?calendarId=fixture',
    bookingUrl,
  });

  const candidate = buildCandidate({
    ...slot,
    venue: 'DRIFTED',
    court: 'DRIFTED',
    startTime: '2099-01-01T00:00:00Z',
    durationMinutes: 999,
  });

  assert.equal(candidate.venue, 'Sydney Uni Sport Tennis Courts');
  assert.equal(candidate.court, 'Court 4');
  assert.equal(candidate.startTime, '2026-09-04T08:00:00+10:00');
  assert.equal(candidate.durationMinutes, 60);
  assert.equal(candidate.features.price, 29);
  assert.equal(candidate.source.availability.availabilityMethod, 'direct');
  assert.deepEqual(candidate.booking, {
    url: bookingUrl,
    capability: 'booking_page',
    provider: 'susf',
  });
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
