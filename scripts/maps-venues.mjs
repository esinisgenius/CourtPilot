#!/usr/bin/env node
import {
  MAPS_ERROR_CODES,
  createGoogleMapsProvider,
  getInitialRadiusMeters,
  resolveLocation,
  searchTennisVenues,
} from '../packages/maps/src/index.mjs';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: npm run maps:venues -- "USYD"');
  process.exit(1);
}

try {
  const provider = createGoogleMapsProvider();
  const location = await resolveLocation({ type: 'user_text', query }, { provider });
  const radiusMeters = getInitialRadiusMeters();
  const venues = await searchTennisVenues({
    center: location,
    radiusMeters,
    limit: 5,
    provider,
  });

  console.log(`Resolved location: ${location.label}`);
  console.log(`Radius: ${radiusMeters}m`);
  console.log(`Venue count: ${venues.length}`);
  for (const venue of venues) {
    console.log(`- ${venue.name ?? 'Unnamed venue'}`);
    console.log(`  address: ${venue.address ?? 'unknown'}`);
    console.log(`  availability: ${venue.availability.status}`);
  }
} catch (error) {
  if (error.code === MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED) {
    console.error(`${MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED}: GOOGLE_MAPS_API_KEY is not configured.`);
  } else {
    console.error(`${error.code ?? 'MAPS_VENUES_FAILED'}: ${error.message}`);
  }
  process.exitCode = 1;
}
