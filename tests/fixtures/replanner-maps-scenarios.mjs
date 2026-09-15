const USYD = Object.freeze({ lat: -33.8886, lng: 151.1873 });
const HOME = Object.freeze({ lat: -33, lng: 151 });

const savedAreasDocument = Object.freeze({
  version: 1,
  areas: [{
    id: 'usyd',
    label: 'USYD',
    center: USYD,
    defaultRadiusMeters: 3000,
  }, {
    id: 'home',
    label: 'Home',
    center: HOME,
    defaultRadiusMeters: 3000,
  }],
});

function mapsVenue({
  id,
  name,
  location = USYD,
  availabilityStatus = 'unknown',
  travelTimeMinutes = 12,
} = {}) {
  return {
    id,
    name,
    address: null,
    location,
    source: 'google_places',
    placeId: id,
    geoDistanceMeters: 1000,
    availability: {
      status: availabilityStatus,
      source: availabilityStatus === 'verified' ? 'susf' : null,
    },
    travel: {
      mode: 'TRANSIT',
      durationMinutes: travelTimeMinutes,
      distanceMeters: travelTimeMinutes * 100,
      source: 'google_routes',
      valueSource: 'product_default',
    },
  };
}

function verifiedSlotCandidate({ id = 'verified-home-slot', venue = mapsVenue({
  id: 'susf-home',
  name: 'Sydney Uni Sport Tennis Courts',
  availabilityStatus: 'verified',
  travelTimeMinutes: 14,
}) } = {}) {
  return {
    id,
    venue: 'SUSF',
    court: 'Court 4',
    startTime: '2026-09-20T08:00:00.000Z',
    durationMinutes: 60,
    features: {
      localDate: '2026-09-20',
      localTime: '18:00',
      nextHourFree: true,
      price: null,
      travelTimeMinutes: venue.travel.durationMinutes,
      venue: {
        id: venue.id,
        name: venue.name,
        availability: venue.availability,
        travelTimeMinutes: venue.travel.durationMinutes,
        travel: venue.travel,
      },
    },
  };
}

export {
  HOME,
  USYD,
  mapsVenue,
  savedAreasDocument,
  verifiedSlotCandidate,
};
