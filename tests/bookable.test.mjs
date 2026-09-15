import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCanonicalVenueContract,
  validateCanonicalAvailability,
  buildCandidate,
  buildCandidates,
} from '../packages/core/src/index.mjs';
import {
  BookableAvailabilityError,
  DEFAULT_BOOKABLE_VENUES,
  buildBookableUrls,
  discoverVenues,
  normalizeAvailability,
  parseBookableVenueUrl,
  readAvailability,
} from '../packages/bookable/src/index.mjs';

const venueConfig = {
  id: 'fixture-tennis-courts',
  name: 'Fixture Tennis Courts',
  council: 'Fixture Council',
  url: 'https://fixture.bookable.net.au/venues/40/fixture-tennis-courts',
  organisationId: 1,
};

const rawBookables = [
  {
    BookableID: 'SC-107',
    ItemID: 107,
    VenueID: 40,
    OrganisationID: 1,
    Name: 'Court 1',
    ActivityTypes: [{ name: 'Tennis' }],
    ExternalSearchable: true,
    BookingMinDuration: 30,
    BookingMaxDuration: 120,
    LeadDateTime: '2026-09-04T07:00:00',
    HourlyRate: null,
  },
  {
    BookableID: 'SC-108',
    ItemID: 108,
    VenueID: 40,
    OrganisationID: 1,
    Name: 'Court 2',
    ActivityTypes: [{ name: 'Tennis' }],
    ExternalSearchable: true,
    BookingMinDuration: 30,
    BookingMaxDuration: 120,
    LeadDateTime: '2026-09-04T07:00:00',
    HourlyRate: 25,
  },
];

const rawBookablesWithNonCourtResource = [
  ...rawBookables,
  {
    BookableID: 'SC-999',
    ItemID: 999,
    VenueID: 40,
    OrganisationID: 1,
    Name: 'Tennis Caretaker - Fixture',
    ActivityTypes: [{ name: 'Tennis' }],
    ExternalSearchable: true,
    BookingMinDuration: 30,
    BookingMaxDuration: 120,
    LeadDateTime: '2026-09-04T07:00:00',
  },
];

const rawOpeningHours = [
  {
    Key: 'SC-107',
    Value: [{
      Date: '2026-09-04T00:00:00',
      Available: true,
      IsOpen: true,
      OpenTime: '07:00:00',
      CloseTime: '10:00:00',
    }],
  },
  {
    Key: 'SC-108',
    Value: [{
      Date: '2026-09-04T00:00:00',
      Available: true,
      IsOpen: true,
      OpenTime: '07:00:00',
      CloseTime: '09:00:00',
    }],
  },
];

const rawBookings = [
  {
    BookableID: 'SC-107',
    Start_Date: '2026-09-04T08:00:00',
    End_Date: '2026-09-04T08:30:00',
    Buffer_Start: '2026-09-04T08:00:00',
    Buffer_End: '2026-09-04T08:30:00',
    BookingStatusName: 'Confirmed',
  },
];

const rawSettings = [
  { key: 'StepMinutes', value: '30' },
  { key: 'MaxItemsPerBooking', value: '700' },
];

function mockBookableFetch({ failOpeningHours = false, emptyBookings = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/bookables?')) return Response.json(rawBookables);
    if (url.includes('/bookingbookablesinperiod?')) return Response.json(emptyBookings ? [] : rawBookings);
    if (url.includes('/getopeninghours?')) {
      if (failOpeningHours) return new Response('nope', { status: 503 });
      return Response.json(rawOpeningHours);
    }
    if (url.includes('/getsettings?')) return Response.json(rawSettings);
    return new Response('not found', { status: 404 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('Bookable venue URL parsing extracts tenant origin and venue id', () => {
  assert.deepEqual(parseBookableVenueUrl(venueConfig.url), {
    origin: 'https://fixture.bookable.net.au',
    venueId: 40,
    slug: 'fixture-tennis-courts',
    officialUrl: 'https://fixture.bookable.net.au/venues/40/fixture-tennis-courts',
  });
});

test('Bookable discovery keeps venue config easy to extend', () => {
  const [venue] = discoverVenues({ venues: [venueConfig] });

  assert.equal(venue.provider, 'bookable');
  assert.equal(venue.name, 'Fixture Tennis Courts');
  assert.equal(venue.venueId, 40);
  assert.equal(venue.organisationId, 1);
});

test('default Bookable venue registry is deduped and contains required production metadata', () => {
  assert.equal(DEFAULT_BOOKABLE_VENUES.length, 34);

  const ids = new Set();
  const urls = new Set();
  for (const venue of DEFAULT_BOOKABLE_VENUES) {
    assert.equal(typeof venue.id, 'string');
    assert.equal(venue.id.length > 0, true);
    assert.equal(typeof venue.name, 'string');
    assert.equal(typeof venue.suburb, 'string');
    assert.equal(venue.provider, 'bookable');
    assert.equal(typeof venue.officialUrl, 'string');
    assert.equal(Number.isInteger(venue.venueId), true);
    assert.equal(Number.isInteger(venue.organisationId), true);
    assert.equal(venue.enabled, true);

    assert.equal(ids.has(venue.id), false);
    assert.equal(urls.has(venue.officialUrl), false);
    ids.add(venue.id);
    urls.add(venue.officialUrl);
  }
});

test('Bookable discovery ignores disabled configured venues', () => {
  const venues = discoverVenues({
    venues: [
      venueConfig,
      {
        ...venueConfig,
        id: 'disabled-fixture',
        officialUrl: 'https://fixture.bookable.net.au/venues/41/disabled-fixture',
        enabled: false,
      },
    ],
  });

  assert.equal(venues.length, 1);
  assert.equal(venues[0].venueId, 40);
});

test('Bookable request construction uses public GET endpoints and date range', () => {
  const urls = buildBookableUrls({
    origin: 'https://fixture.bookable.net.au',
    venueId: 40,
    organisationId: 1,
    fromDate: '2026-09-04',
    days: 2,
  });

  assert.equal(urls.bookables, 'https://fixture.bookable.net.au/api/v2/venues/40/bookables?externalOnly=true&excludeResource=true&hideNotInSeason=true&date=2026-09-04&capacity=null');
  assert.match(urls.bookings, /fromDate=2026-09-04/);
  assert.match(urls.bookings, /toDate=2026-09-06/);
  assert.match(urls.openingHours, /toDate=2026-09-05/);
  assert.equal(urls.settings, 'https://fixture.bookable.net.au/api/v2/organisations/1/getsettings?keysstr=StepMinutes,MaxItemsPerBooking,SeasonalSeasonalLabelText&asDictionary=false');
});

test('Bookable anonymous acquisition sends no cookie or anti-forgery headers', async () => {
  const fetchImpl = mockBookableFetch();
  await readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    days: 1,
    durationMinutes: 60,
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 4);
  for (const call of fetchImpl.calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.headers.cookie, undefined);
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(call.options.headers['x-csrf-token'], undefined);
  }
});

test('Bookable normalization preserves venue/resource identity and provenance', () => {
  const slots = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables,
    rawOpeningHours,
    rawBookings,
    rawSettings,
    durationMinutes: 60,
    observedAt: '2026-09-04T00:00:00.000Z',
  });

  const slot = slots.find((candidate) => candidate.resourceId === 'SC-107' && candidate.startTime === '2026-09-04T07:00:00+10:00');
  assert.equal(slot.provider, 'bookable');
  assert.equal(slot.venue, 'Fixture Tennis Courts');
  assert.equal(slot.court, 'Court 1');
  assert.equal(slot.officialUrl, venueConfig.url);
  assert.deepEqual(slot.provenance, {
    status: 'verified',
    source: 'bookable',
    access: 'public',
    freshness: 'live',
    availabilityMethod: 'derived_first_party',
  });
});

test('Bookable availability exposes provider-agnostic canonical schema', () => {
  const venue = discoverVenues({ venues: [venueConfig] })[0];
  const slot = normalizeAvailability({
    venue,
    rawBookables,
    rawOpeningHours,
    rawBookings,
    rawSettings,
    durationMinutes: 60,
    observedAt: '2026-09-04T00:00:00.000Z',
  }).find((candidate) => candidate.resourceId === 'SC-108' && candidate.startTime === '2026-09-04T07:00:00+10:00');

  assert.equal(validateCanonicalAvailability(slot.canonical), slot.canonical);
  assertCanonicalVenueContract(slot, { configuredVenue: venue });
  assert.deepEqual(slot.canonical, {
    provider: 'bookable',
    venue: {
      id: 'fixture-tennis-courts',
      name: 'Fixture Tennis Courts',
      providerVenueId: '40',
    },
    court: {
      id: 'bookable-court-SC-108',
      name: 'Court 2',
      providerCourtId: 'SC-108',
      surface: null,
    },
    slot: {
      start: '2026-09-04T07:00:00+10:00',
      end: '2026-09-04T08:00:00+10:00',
      durationMinutes: 60,
      available: true,
    },
    price: {
      amount: 25,
      currency: 'AUD',
      confidence: 'verified',
    },
    eligibility: {
      sport: {
        type: 'tennis',
        proof: 'provider_resource',
      },
    },
    provenance: {
      source: 'live',
      auth: 'public',
      observedAt: '2026-09-04T00:00:00.000Z',
      availabilityMethod: 'derived_first_party',
    },
  });

  for (const providerSpecificKey of ['resourceId', 'venueId', 'facilityId', 'organisationId', 'OrganisationID', 'serviceId']) {
    assert.equal(Object.hasOwn(slot.canonical, providerSpecificKey), false);
  }
});

test('Bookable 60-minute semantics exclude overlapping bookings', () => {
  const slots = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables,
    rawOpeningHours,
    rawBookings,
    rawSettings,
    durationMinutes: 60,
    observedAt: '2026-09-04T00:00:00.000Z',
  }).filter((slot) => slot.resourceId === 'SC-107');

  assert.deepEqual(slots.map((slot) => slot.startTime), [
    '2026-09-04T07:00:00+10:00',
    '2026-09-04T08:30:00+10:00',
    '2026-09-04T09:00:00+10:00',
  ]);
});

test('Bookable resource discovery excludes non-court operational tennis resources', () => {
  const slots = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables: rawBookablesWithNonCourtResource,
    rawOpeningHours: [
      ...rawOpeningHours,
      {
        Key: 'SC-999',
        Value: [{
          Date: '2026-09-04T00:00:00',
          Available: true,
          IsOpen: true,
          OpenTime: '07:00:00',
          CloseTime: '09:00:00',
        }],
      },
    ],
    rawBookings: [],
    rawSettings,
    durationMinutes: 60,
    observedAt: '2026-09-04T00:00:00.000Z',
  });

  assert.equal(slots.some((slot) => slot.resourceId === 'SC-999'), false);
});


test('Bookable 120-minute semantics compose continuous open intervals deterministically', () => {
  const slots = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables,
    rawOpeningHours,
    rawBookings: [],
    rawSettings,
    durationMinutes: 120,
    observedAt: '2026-09-04T00:00:00.000Z',
  }).filter((slot) => slot.resourceId === 'SC-107');

  assert.deepEqual(slots.map((slot) => slot.startTime), [
    '2026-09-04T07:00:00+10:00',
    '2026-09-04T07:30:00+10:00',
    '2026-09-04T08:00:00+10:00',
  ]);
});

test('Bookable successful acquisition with no feasible slots is distinct from provider failure', () => {
  const slots = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables,
    rawOpeningHours,
    rawBookings: [],
    rawSettings,
    durationMinutes: 240,
    observedAt: '2026-09-04T00:00:00.000Z',
  });

  assert.deepEqual(slots, []);
});

test('Bookable acquisition failure is raised with venue context', async () => {
  const fetchImpl = mockBookableFetch({ failOpeningHours: true });

  await assert.rejects(() => readAvailability({
    venues: [venueConfig],
    date: '2026-09-04',
    days: 1,
    durationMinutes: 60,
    fetchImpl,
  }), (error) => {
    assert.equal(error instanceof BookableAvailabilityError, true);
    assert.equal(error.code, 'BOOKABLE_PARTIAL_FAILURE');
    assert.equal(error.failures[0].venue, 'Fixture Tennis Courts');
    assert.equal(error.availability.length, 0);
    return true;
  });
});

test('Bookable slots flow through existing candidate pipeline without provider-specific logic', () => {
  const [slot] = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables,
    rawOpeningHours,
    rawBookings: [],
    rawSettings,
    durationMinutes: 60,
    observedAt: '2026-09-04T00:00:00.000Z',
  });
  const candidate = buildCandidate(slot);

  assert.equal(candidate.venue, 'Fixture Tennis Courts');
  assert.equal(candidate.source.provider, 'bookable');
  assert.equal(candidate.source.availability.source, 'live');
  assert.equal(candidate.source.availability.availabilityMethod, 'derived_first_party');
  assert.deepEqual(candidate.booking, {
    url: 'https://fixture.bookable.net.au/venues/40/fixture-tennis-courts',
    capability: 'booking_page',
    provider: 'bookable',
  });
});

test('existing candidate pipeline can consume SUSF and Bookable normalized slots together', () => {
  const [bookableSlot] = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables,
    rawOpeningHours,
    rawBookings: [],
    rawSettings,
    durationMinutes: 60,
    observedAt: '2026-09-04T00:00:00.000Z',
  });
  const candidates = buildCandidates([
    {
      venue: 'SUSF',
      court: 'Court 4',
      startTime: '2026-09-04T08:00:00',
      durationMinutes: 60,
      nextHourAlsoAvailable: true,
      priceOptions: [],
      provenance: { status: 'verified', source: 'susf_perfectmind', access: 'public', freshness: 'live' },
    },
    bookableSlot,
  ]);

  assert.deepEqual(candidates.map((candidate) => candidate.source.provider).sort(), ['SUSF', 'bookable']);
});

test('Bookable slot step follows the public organisation StepMinutes setting', () => {
  const slots = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables,
    rawOpeningHours,
    rawBookings: [],
    rawSettings: [{ key: 'StepMinutes', value: '60' }],
    durationMinutes: 60,
    observedAt: '2026-09-04T00:00:00.000Z',
  }).filter((slot) => slot.resourceId === 'SC-107');

  assert.deepEqual(slots.map((slot) => slot.startTime), [
    '2026-09-04T07:00:00+10:00',
    '2026-09-04T08:00:00+10:00',
    '2026-09-04T09:00:00+10:00',
  ]);
});

test('Bookable legacy compatibility fields are derived from canonical', () => {
  const [slot] = normalizeAvailability({
    venue: discoverVenues({ venues: [venueConfig] })[0],
    rawBookables,
    rawOpeningHours,
    rawBookings: [],
    rawSettings,
    durationMinutes: 60,
    observedAt: '2026-09-04T00:00:00.000Z',
  });

  assert.equal(slot.provider, slot.canonical.provider);
  assert.equal(slot.venue, slot.canonical.venue.name);
  assert.equal(slot.court, slot.canonical.court.name);
  assert.equal(slot.resourceId, slot.canonical.court.providerCourtId);
  assert.equal(slot.venueId, Number(slot.canonical.venue.providerVenueId));
  assert.equal(slot.startTime, slot.canonical.slot.start);
  assert.equal(slot.durationMinutes, slot.canonical.slot.durationMinutes);
  assert.deepEqual(slot.priceOptions, []);
});
