import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_BOOKABLE_VENUES } from '../packages/bookable/src/index.mjs';
import { DEFAULT_INTRAC_VENUES } from '../packages/intrac/src/index.mjs';
import { DEFAULT_SPORTLOGIC_VENUES } from '../packages/sportlogic/src/index.mjs';
import { DEFAULT_UNIFIED_BOOKINGS_VENUES } from '../packages/unified-bookings/src/index.mjs';

const venues = [
  ...DEFAULT_BOOKABLE_VENUES,
  ...DEFAULT_INTRAC_VENUES,
  ...DEFAULT_SPORTLOGIC_VENUES,
  ...DEFAULT_UNIFIED_BOOKINGS_VENUES,
];

function hasLatLng(venue) {
  return Number.isFinite(venue.location?.lat) && Number.isFinite(venue.location?.lng);
}

function row(venue) {
  const missing = [];
  if (!venue.address) missing.push('address');
  if (!venue.suburb) missing.push('suburb');
  if (!hasLatLng(venue)) missing.push('lat_lng');
  if (venue.sport !== 'tennis' && !/tennis/i.test(`${venue.name} ${venue.officialUrl}`)) missing.push('verified_tennis_status');
  if (!venue.provider) missing.push('provider');
  if (!venue.officialUrl) missing.push('booking_url');
  return {
    id: venue.id,
    name: venue.name,
    provider: venue.provider ?? null,
    suburb: venue.suburb ?? null,
    address: venue.address ?? null,
    lat: venue.location?.lat ?? null,
    lng: venue.location?.lng ?? null,
    verifiedTennisStatus: venue.sport === 'tennis' || /tennis/i.test(`${venue.name} ${venue.officialUrl}`),
    bookingUrl: venue.officialUrl ?? null,
    missing,
  };
}

const rows = venues.map(row);
const summary = {
  generatedAt: new Date().toISOString(),
  total: rows.length,
  missingGeoMetadata: rows.filter((item) => item.missing.includes('lat_lng')).length,
  missingAddress: rows.filter((item) => item.missing.includes('address')).length,
  missingVerifiedTennisStatus: rows.filter((item) => item.missing.includes('verified_tennis_status')).length,
  priorityPatchedThisRound: [
    'sportlogic-burwood-tennis-courts',
    'bookable-bayside-aloha-street',
    'intrac-moore-park-tennis-courts',
    'intrac-camperdown-tennis',
    'intrac-centennial-parklands-sports-centre',
    'bookable-krg-lindfield-soldiers-memorial-park',
  ],
};

const payload = { summary, venues: rows, missingGeoMetadata: rows.filter((item) => item.missing.length > 0) };
const jsonPath = resolve('eval/venue-metadata-audit.json');
await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Venue metadata audit: ${summary.total} venues, ${summary.missingGeoMetadata} missing lat/lng, ${summary.missingAddress} missing address.`);
console.log(`JSON: ${jsonPath}`);
