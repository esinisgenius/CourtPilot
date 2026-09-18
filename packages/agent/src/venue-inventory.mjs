import { DEFAULT_BOOKABLE_VENUES } from '../../bookable/src/index.mjs';
import { DEFAULT_INTRAC_VENUES } from '../../intrac/src/index.mjs';
import { DEFAULT_CLUBSPARK_VENUES } from '../../clubspark/src/index.mjs';
import { DEFAULT_MINDBODY_VENUES } from '../../mindbody/src/index.mjs';
import { DEFAULT_SPORTLOGIC_VENUES } from '../../sportlogic/src/index.mjs';
import { DEFAULT_UNIFIED_BOOKINGS_VENUES } from '../../unified-bookings/src/index.mjs';

const SUSF_BOOKING_URL = 'https://susf.perfectmind.com/39161/Clients/BookMe4FacilityList/List?calendarId=7cb1945d-e899-4e40-96c4-8ee784ccfc2d&widgetId=c5b8cc8a-09fe-48ae-a693-df5c09f81adb&embed=False';

const REALTIME_PROVIDERS = new Set([
  'susf',
  'bookable',
  'intrac',
  'clubspark',
  'mindbody',
  'sportlogic',
  'unified-bookings',
]);

const BOOKABLE_VERIFICATION_OVERRIDES = Object.freeze({
  'bookable-krg-hamilton-park': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7468, lng: 151.1379 },
    surface: null,
    verificationSourceUrl: 'https://www.krg.nsw.gov.au/Community/Sport-and-recreation/Sports-facilities/Tennis-courts',
  },
  'bookable-krg-st-ives-village-green': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7298, lng: 151.1602 },
    verificationSourceUrl: 'https://www.krg.nsw.gov.au/Community/Sport-and-recreation/Sports-facilities/Tennis-courts',
  },
  'bookable-krg-warrimoo-oval': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7169, lng: 151.1691 },
    verificationSourceUrl: 'https://www.krg.nsw.gov.au/Community/Sport-and-recreation/Sports-facilities/Tennis-courts',
  },
  'bookable-krg-loyal-henry-park': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7815, lng: 151.1856 },
    verificationSourceUrl: 'https://www.krg.nsw.gov.au/Community/Sport-and-recreation/Sports-facilities/Tennis-courts',
  },
  'bookable-krg-the-glade-reserve': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7164, lng: 151.1213 },
    verificationSourceUrl: 'https://www.krg.nsw.gov.au/Community/Sport-and-recreation/Sports-facilities/Tennis-courts',
  },
  'bookable-krg-allan-small-park': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7634, lng: 151.1637 },
    verificationSourceUrl: 'https://www.krg.nsw.gov.au/Community/Sport-and-recreation/Sports-facilities/Tennis-courts',
  },
  'bookable-krg-turramurra-memorial-park': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7318, lng: 151.1299 },
    verificationSourceUrl: 'https://www.krg.nsw.gov.au/Community/Sport-and-recreation/Sports-facilities/Tennis-courts',
  },
  'bookable-krg-roseville-park': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7848, lng: 151.1845 },
    verificationSourceUrl: 'https://www.krg.nsw.gov.au/Community/Sport-and-recreation/Sports-facilities/Tennis-courts',
  },
  'bookable-krg-canoon-road-recreation-area': {
    verificationStatus: 'verified',
    area: 'North Shore',
    location: { lat: -33.7575, lng: 151.1055 },
    surface: 'hard',
    verificationSourceUrl: 'https://krg.bookable.net.au/venues/43/canoon-road-recreation-area-courts',
  },
  'bookable-bayside-bexley': {
    verificationStatus: 'verified',
    area: 'South / Bayside / Sutherland',
    location: { lat: -33.9514, lng: 151.1251 },
    verificationSourceUrl: 'https://bayside.bookable.net.au/venues/114/bexley-tennis-courts',
  },
  'bookable-bayside-scarborough-park': {
    verificationStatus: 'verified',
    area: 'South / Bayside / Sutherland',
    location: { lat: -33.9867, lng: 151.1392 },
    verificationSourceUrl: 'https://bayside.bookable.net.au/venues/113/scarborough-park-tennis-courts',
  },
  'bookable-sutherland-seymour-shaw': {
    verificationStatus: 'verified',
    area: 'South / Bayside / Sutherland',
    location: { lat: -34.0358, lng: 151.0971 },
    verificationSourceUrl: 'https://sutherland.bookable.net.au/venues/140/seymour-shaw-tennis-courts-miranda',
  },
  'bookable-georgesriver-quarry-reserve': {
    verificationStatus: 'verified',
    area: 'Western / Inner West Fringe',
    location: { lat: -33.9762, lng: 151.1036 },
    verificationSourceUrl: 'https://georgesriver.bookable.net.au/venues/81/quarry-reserve-tennis-courts',
  },
  'bookable-blacktown-cavanagh-reserve': {
    verificationStatus: 'verified',
    area: 'Western Sydney',
    location: { lat: -33.7589, lng: 150.9235 },
    surface: 'synthetic',
    verificationSourceUrl: 'https://www.blacktownaustralia.com.au/visitor-information/things-to-see-and-do/tennis-courts-facilities/',
  },
  'bookable-blacktown-pearce-reserve': {
    verificationStatus: 'verified',
    area: 'Western Sydney',
    location: { lat: -33.7479, lng: 150.9389 },
    courtCount: 4,
    surface: 'synthetic',
    verificationSourceUrl: 'https://www.blacktownaustralia.com.au/visitor-information/things-to-see-and-do/tennis-courts-facilities/',
  },
  'bookable-blacktown-glenwood-reserve': {
    verificationStatus: 'verified',
    area: 'Western Sydney',
    location: { lat: -33.7339, lng: 150.9289 },
    surface: 'synthetic',
    verificationSourceUrl: 'https://www.blacktown.nsw.gov.au/Sport-recreation/Parks-and-recreation-directory/Glenwood-Reserve',
  },
  'bookable-blacktown-quakers-hill-park': {
    verificationStatus: 'verified',
    area: 'Western Sydney',
    location: { lat: -33.7308, lng: 150.8839 },
    surface: 'synthetic',
    verificationSourceUrl: 'https://blacktown.bookable.net.au/venues/80/quakers-hill-park',
  },
});

const STATIC_TENNIS_VENUES = Object.freeze([
  {
    id: 'static-city-prince-alfred-park',
    name: 'Prince Alfred Park Tennis Courts',
    suburb: 'Surry Hills',
    area: 'CBD / Inner City / Central',
    location: { lat: -33.8873, lng: 151.2066 },
    officialUrl: 'https://www.citycommunitytennis.com.au/locations',
    courtCount: null,
    surface: 'hard',
    priceKnown: false,
    verificationSourceUrl: 'https://www.cityofsydney.nsw.gov.au/sports-facility-booking-services/book-tennis-court',
  },
  {
    id: 'static-city-alexandria-park',
    name: 'Alexandria Park Tennis Courts',
    suburb: 'Alexandria',
    area: 'Zetland / Waterloo / Alexandria / Green Square / Mascot',
    location: { lat: -33.9003, lng: 151.1943 },
    officialUrl: 'https://www.citycommunitytennis.com.au/locations',
    courtCount: 2,
    surface: 'hard',
    priceKnown: false,
    verificationSourceUrl: 'https://www.cityofsydney.nsw.gov.au/sports-facility-booking-services/book-tennis-court',
  },
  {
    id: 'static-city-beaconsfield-park',
    name: 'Beaconsfield Park Tennis Courts',
    suburb: 'Beaconsfield',
    area: 'Zetland / Waterloo / Alexandria / Green Square / Mascot',
    location: { lat: -33.9131, lng: 151.1994 },
    officialUrl: 'https://www.citycommunitytennis.com.au/locations',
    courtCount: 2,
    surface: 'hard',
    priceKnown: false,
    verificationSourceUrl: 'https://www.cityofsydney.nsw.gov.au/sports-facility-booking-services/book-tennis-court',
  },
  {
    id: 'static-city-turruwul-park',
    name: 'Turruwul Park Tennis Court',
    suburb: 'Rosebery',
    area: 'Zetland / Waterloo / Alexandria / Green Square / Mascot',
    location: { lat: -33.9173, lng: 151.2042 },
    officialUrl: 'https://www.citycommunitytennis.com.au/locations',
    courtCount: 1,
    surface: 'hard',
    priceKnown: false,
    verificationSourceUrl: 'https://www.cityofsydney.nsw.gov.au/sports-facility-booking-services/book-tennis-court',
  },
  {
    id: 'static-city-st-james-park-glebe',
    name: 'St James Park Tennis Courts',
    suburb: 'Glebe',
    area: 'Inner West',
    location: { lat: -33.8802, lng: 151.1842 },
    officialUrl: 'https://www.citycommunitytennis.com.au/locations',
    courtCount: 2,
    surface: 'hard',
    priceKnown: false,
    verificationSourceUrl: 'https://www.citycommunitytennis.com.au/locations',
  },
  {
    id: 'static-trumper-park-tennis-centre',
    name: 'Trumper Park Tennis Centre',
    suburb: 'Paddington',
    area: 'CBD / Inner City / Central',
    location: { lat: -33.8848, lng: 151.2295 },
    officialUrl: 'https://www.wentworthtennis.com/',
    courtCount: null,
    surface: null,
    priceKnown: true,
    verificationSourceUrl: 'https://www.wentworthtennis.com/',
  },
  {
    id: 'static-white-city-tennis-centre',
    name: 'White City Tennis Centre',
    suburb: 'Paddington',
    area: 'CBD / Inner City / Central',
    location: { lat: -33.8825, lng: 151.229 },
    officialUrl: 'https://whitecity.intennis.com.au/secure/customer/booking/v2/public/venue/1',
    courtCount: 6,
    surface: 'artificial grass',
    priceKnown: false,
    verificationSourceUrl: 'https://www.whitecitytennis.com.au/court-hire',
  },
  {
    id: 'static-eastside-tennis-centre',
    name: 'Eastside Tennis Centre',
    suburb: 'Kingsford',
    area: 'Eastern Suburbs',
    location: { lat: -33.9228, lng: 151.2218 },
    officialUrl: 'https://eastsidetennis.com.au/',
    courtCount: null,
    surface: null,
    priceKnown: false,
    verificationSourceUrl: 'https://eastsidetennis.com.au/',
  },
  {
    id: 'static-coogee-beach-tennis',
    name: 'Coogee Beach Tennis',
    suburb: 'Coogee',
    area: 'Eastern Suburbs',
    location: { lat: -33.9223, lng: 151.2576 },
    officialUrl: 'https://cbtennis.com.au/',
    courtCount: null,
    surface: null,
    priceKnown: true,
    verificationSourceUrl: 'https://cbtennis.com.au/',
  },
  {
    id: 'static-baker-park-tennis-courts',
    name: 'Baker Park Tennis Courts',
    suburb: 'Coogee',
    area: 'Eastern Suburbs',
    location: { lat: -33.9208, lng: 151.2522 },
    officialUrl: 'https://www.randwick.nsw.gov.au/facilities-and-recreation/parks/parks-by-suburb/coogee/baker-park',
    bookingCapability: null,
    courtCount: null,
    surface: null,
    priceKnown: false,
    verificationSourceUrl: 'https://www.randwick.nsw.gov.au/facilities-and-recreation/parks/parks-by-suburb/coogee/baker-park',
    settings: ['coastal', 'scenic', 'beach_nearby'],
  },
  {
    id: 'static-langham-sydney-tennis-court',
    name: 'The Langham Sydney Tennis Court',
    suburb: 'Millers Point',
    area: 'Sydney CBD / Inner City',
    location: { lat: -33.8599, lng: 151.2037 },
    officialUrl: 'https://langham.intrac.com.au/tennis/book.cfm',
    bookingCapability: 'booking_page',
    courtCount: 1,
    surface: 'hard',
    priceKnown: true,
    verificationSourceUrl: 'https://www.langhamhotels.com/en/the-langham/sydney/wellness/tennis/',
    needsProviderFeasibility: true,
    settings: ['scenic', 'harbour', 'city_view'],
  },
  {
    id: 'static-mutch-park-tennis-centre',
    name: 'Mutch Park Tennis Centre',
    suburb: 'Pagewood',
    area: 'Zetland / Waterloo / Alexandria / Green Square / Mascot',
    location: { lat: -33.9454, lng: 151.2206 },
    officialUrl: 'https://www.mutchparksports.com.au/',
    courtCount: 6,
    surface: null,
    priceKnown: true,
    verificationSourceUrl: 'https://www.mutchparksports.com.au/',
  },
  {
    id: 'static-marrickville-hardcourt-tennis-club',
    name: 'Marrickville Hardcourt Tennis Club',
    suburb: 'Marrickville',
    area: 'Inner West',
    location: { lat: -33.9051, lng: 151.1556 },
    officialUrl: 'https://www.marrickvilletennisclub.org.au/',
    courtCount: null,
    surface: 'hard',
    priceKnown: false,
    verificationSourceUrl: 'https://www.marrickvilletennisclub.org.au/',
  },
  {
    id: 'static-innerwest-darrell-jackson-gardens',
    name: 'Darrell Jackson Gardens Tennis Court',
    suburb: 'Summer Hill',
    area: 'Inner West',
    location: { lat: -33.8906, lng: 151.1358 },
    officialUrl: 'https://www.innerwest.nsw.gov.au/sport-and-recreation/tennis-and-multi-purpose-courts',
    bookingCapability: null,
    courtCount: 1,
    surface: null,
    priceKnown: false,
    verificationSourceUrl: 'https://www.innerwest.nsw.gov.au/sport-and-recreation/tennis-and-multi-purpose-courts',
  },
  {
    id: 'static-innerwest-hammond-park',
    name: 'Hammond Park Tennis Court',
    suburb: 'Ashfield',
    area: 'Inner West',
    location: { lat: -33.8791, lng: 151.1284 },
    officialUrl: 'https://www.innerwest.nsw.gov.au/sport-and-recreation/tennis-and-multi-purpose-courts',
    bookingCapability: null,
    courtCount: 1,
    surface: null,
    priceKnown: false,
    verificationSourceUrl: 'https://www.innerwest.nsw.gov.au/sport-and-recreation/tennis-and-multi-purpose-courts',
  },
  {
    id: 'static-innerwest-richard-murden-reserve',
    name: 'Richard Murden Reserve Tennis Courts',
    suburb: 'Haberfield',
    area: 'Inner West',
    location: { lat: -33.8817, lng: 151.1444 },
    officialUrl: 'https://www.innerwest.nsw.gov.au/sport-and-recreation/tennis-and-multi-purpose-courts',
    bookingCapability: null,
    courtCount: null,
    surface: null,
    priceKnown: false,
    verificationSourceUrl: 'https://www.innerwest.nsw.gov.au/sport-and-recreation/tennis-and-multi-purpose-courts',
  },
  {
    id: 'static-sydney-olympic-park-tennis-centre',
    name: 'Sydney Olympic Park Tennis Centre',
    suburb: 'Sydney Olympic Park',
    area: 'Western / Inner West Fringe',
    location: { lat: -33.8548, lng: 151.0726 },
    officialUrl: 'https://www.tennisworld.net.au/locations/sydney/',
    courtCount: null,
    surface: null,
    priceKnown: false,
    verificationSourceUrl: 'https://www.tennisworld.net.au/locations/sydney/',
  },
  {
    id: 'static-cintra-park-tennis-sports-centre',
    name: 'Cintra Park Tennis and Sports Centre',
    suburb: 'Concord',
    area: 'Western / Inner West Fringe',
    location: { lat: -33.8625, lng: 151.0972 },
    officialUrl: 'https://www.cpsports.com.au/',
    courtCount: null,
    surface: null,
    priceKnown: true,
    verificationSourceUrl: 'https://www.cpsports.com.au/',
  },
  {
    id: 'static-croydon-tennis-centre',
    name: 'Croydon Tennis Centre',
    suburb: 'Croydon',
    area: 'Western / Inner West Fringe',
    location: { lat: -33.8799, lng: 151.1162 },
    officialUrl: 'https://www.croydontenniscentre.com.au/facilities-grass-courts',
    courtCount: 4,
    surface: 'synthetic grass',
    priceKnown: true,
    verificationSourceUrl: 'https://www.croydontenniscentre.com.au/facilities-grass-courts',
  },
]);

const SUSF_CONFIGURED_VENUE = Object.freeze({
  id: 'susf-tennis',
  name: 'Sydney Uni Sport Tennis Courts',
  suburb: 'Camperdown',
  area: 'USYD / Inner West',
  provider: 'susf',
  providerVenueId: 'susf',
  sport: 'tennis',
  verificationStatus: 'verified',
  location: { lat: -33.8886, lng: 151.1873 },
  officialUrl: SUSF_BOOKING_URL,
  realtimeAvailability: true,
  courtCount: 6,
  surface: null,
  priceKnown: true,
});

function hasCoordinate(location) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
}

function areaForVenue(venue) {
  if (venue.area) return venue.area;
  if (['Camperdown'].includes(venue.suburb)) return 'USYD / Inner West';
  if (['Alexandria', 'Beaconsfield', 'Rosebery', 'Mascot'].includes(venue.suburb)) {
    return 'Zetland / Waterloo / Alexandria / Green Square / Mascot';
  }
  if (['Moore Park', 'Rushcutters Bay', 'Kingsford', 'Coogee', 'Randwick'].includes(venue.suburb)) return 'Eastern Suburbs';
  if (['Glebe', 'Marrickville', 'Summer Hill', 'Ashfield', 'Haberfield'].includes(venue.suburb)) return 'Inner West';
  if (['Burwood', 'Strathfield', 'Sydney Olympic Park', 'Concord', 'Croydon', 'South Hurstville'].includes(venue.suburb)) {
    return 'Western / Inner West Fringe';
  }
  if (['Pymble', 'St Ives', 'Roseville', 'Wahroonga', 'Lindfield', 'Killara', 'North Turramurra', 'Turramurra', 'South Turramurra', 'West Pymble'].includes(venue.suburb)) {
    return 'North Shore';
  }
  if (['Bexley', 'Ramsgate', 'Illawong', 'Bonnet Bay', 'Engadine', 'Como', 'Waterfall', 'Woronora Heights', 'Bangor', 'Bundeena', 'Miranda'].includes(venue.suburb)) {
    return 'South / Bayside / Sutherland';
  }
  if (['Ropes Crossing', 'Lalor Park', 'Kings Langley', 'Glenwood', 'Quakers Hill'].includes(venue.suburb)) return 'Western Sydney';
  return 'Other';
}

function bookingCapabilityForProvider(provider, venue) {
  if (!venue.officialUrl) return null;
  if (provider === 'sportlogic') return 'court_date_time_preselected';
  if (provider === 'intrac') return 'date_time_preselected';
  if (provider === 'clubspark') return 'court_date_time_preselected';
  return 'booking_page';
}

function verificationStatusForVenue(venue, override) {
  if (override?.verificationStatus) return override.verificationStatus;
  if (venue.verificationStatus) return venue.verificationStatus;
  if (venue.sport === 'tennis' && hasCoordinate(venue.location)) return 'verified';
  return 'unknown';
}

function normalizeVenue(venue, {
  source = 'provider_config',
  realtimeAvailability = REALTIME_PROVIDERS.has(venue.provider),
  overrides = {},
} = {}) {
  const merged = { ...venue, ...overrides };
  const verificationStatus = verificationStatusForVenue(merged, overrides);
  const bookingCapability = merged.bookingCapability === undefined
    ? bookingCapabilityForProvider(merged.provider, merged)
    : merged.bookingCapability;
  const bookingUrl = bookingCapability ? merged.officialUrl ?? null : null;
  return {
    id: merged.id,
    name: merged.name,
    suburb: merged.suburb ?? null,
    area: areaForVenue(merged),
    lat: merged.location?.lat ?? null,
    lng: merged.location?.lng ?? null,
    location: merged.location ?? null,
    sport: verificationStatus === 'verified' ? 'tennis' : merged.sport ?? null,
    verificationStatus,
    provider: merged.provider,
    providerVenueId: merged.providerVenueId ?? merged.venueId ?? merged.locationId ?? merged.clientId ?? merged.locationUuid ?? null,
    source,
    realtimeAvailability,
    booking: {
      url: bookingUrl,
      capability: bookingUrl ? bookingCapability : null,
    },
    venueUrl: merged.officialUrl ?? null,
    settings: [...new Set(merged.settings ?? [])],
    courtCount: merged.courtCount ?? merged.auditCourtCount ?? null,
    surface: merged.surface ?? null,
    priceKnown: Boolean(merged.priceKnown ?? ['susf', 'bookable', 'sportlogic'].includes(merged.provider)),
    needsProviderFeasibility: Boolean(merged.needsProviderFeasibility ?? !realtimeAvailability),
    verificationSourceUrl: merged.verificationSourceUrl ?? merged.officialUrl ?? null,
  };
}

function configuredRealtimeVenues() {
  return [
    SUSF_CONFIGURED_VENUE,
    ...DEFAULT_INTRAC_VENUES,
    ...DEFAULT_CLUBSPARK_VENUES,
    ...DEFAULT_MINDBODY_VENUES,
    ...DEFAULT_SPORTLOGIC_VENUES,
    ...DEFAULT_UNIFIED_BOOKINGS_VENUES,
    ...DEFAULT_BOOKABLE_VENUES,
  ].filter((venue) => venue.enabled !== false);
}

function canonicalVenueInventory() {
  const realtime = configuredRealtimeVenues().map((venue) => normalizeVenue(venue, {
    source: 'provider_config',
    realtimeAvailability: true,
    overrides: BOOKABLE_VERIFICATION_OVERRIDES[venue.id] ?? {},
  }));
  const staticVenues = STATIC_TENNIS_VENUES.map((venue) => normalizeVenue({
    ...venue,
    provider: 'static',
    sport: 'tennis',
    verificationStatus: 'verified',
  }, {
    source: 'static_official_source',
    realtimeAvailability: false,
  }));
  return [...realtime, ...staticVenues];
}

function venueInventorySummary(venues = canonicalVenueInventory()) {
  const verified = venues.filter((venue) => venue.verificationStatus === 'verified');
  return {
    total: venues.length,
    verifiedVenues: verified.length,
    realtimeVenues: verified.filter((venue) => venue.realtimeAvailability).length,
    bookingEnabledVenues: verified.filter((venue) => venue.booking.url && venue.booking.capability).length,
    unknownVenues: venues.filter((venue) => venue.verificationStatus === 'unknown').length,
  };
}

export {
  BOOKABLE_VERIFICATION_OVERRIDES,
  STATIC_TENNIS_VENUES,
  SUSF_CONFIGURED_VENUE,
  canonicalVenueInventory,
  configuredRealtimeVenues,
  venueInventorySummary,
};
