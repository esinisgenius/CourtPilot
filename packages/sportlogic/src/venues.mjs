const DEFAULT_SPORTLOGIC_VENUES = Object.freeze([
  {
    id: 'sportlogic-burwood-tennis-courts',
    name: 'Burwood Tennis Courts',
    suburb: 'Burwood',
    address: 'Park Ave, Burwood NSW 2134',
    location: { lat: -33.8739501, lng: 151.1018491 },
    geoSource: 'openstreetmap_road_centroid_verified_address',
    geoConfidence: 'medium',
    provider: 'sportlogic',
    sport: 'tennis',
    officialUrl: 'https://www.tennisvenues.com.au/booking/burwood-tennis-courts',
    clientId: 'burwood-tennis-courts',
    venueId: '1',
    enabled: true,
    auditCourtCount: 2,
  },
]);

export {
  DEFAULT_SPORTLOGIC_VENUES,
};
