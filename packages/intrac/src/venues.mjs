const DEFAULT_INTRAC_VENUES = Object.freeze([
  {
    id: 'intrac-moore-park-tennis-courts',
    name: 'Moore Park Tennis Courts',
    suburb: 'Moore Park',
    provider: 'intrac',
    officialUrl: 'https://parklands.intrac.com.au/sports/schedule.cfm?location=72',
    locationId: '72',
    enabled: true,
    auditCourtCount: 4,
  },
  {
    id: 'intrac-camperdown-tennis',
    name: 'Camperdown Tennis',
    suburb: 'Camperdown',
    provider: 'intrac',
    officialUrl: 'https://camperdowntennis.intrac.com.au/tennis/book.cfm?location=70',
    locationId: '70',
    enabled: true,
    auditCourtCount: 6,
  },
  {
    id: 'intrac-centennial-parklands-sports-centre',
    name: 'Centennial Parklands Sports Centre Courts',
    suburb: 'Moore Park',
    provider: 'intrac',
    officialUrl: 'https://parklands.intrac.com.au/sports/schedule.cfm?location=55',
    referer: 'https://parklandssports.com.au/online-court-bookings/',
    locationId: '55',
    enabled: true,
    auditCourtCount: 11,
  },
]);

export {
  DEFAULT_INTRAC_VENUES,
};
