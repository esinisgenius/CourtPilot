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
  {
    id: 'sportlogic-collaroy-tennis-club',
    name: 'Collaroy Tennis Club',
    suburb: 'Collaroy',
    address: 'Griffith Park, Anzac Avenue, Collaroy NSW 2097',
    location: { lat: -33.73948, lng: 151.303764 },
    geoSource: 'tennisvenues_venue_page',
    geoConfidence: 'high',
    provider: 'sportlogic',
    sport: 'tennis',
    officialUrl: 'https://www.tennisvenues.com.au/booking/collaroy-tc',
    clientId: 'collaroy-tc',
    enabled: true,
    auditCourtCount: 6,
    aliases: ['Long Reef Point tennis', 'Collaroy Beach tennis'],
    settings: ['coastal', 'scenic', 'beach_nearby'],
  },
]);

export {
  DEFAULT_SPORTLOGIC_VENUES,
};
