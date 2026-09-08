#!/usr/bin/env node
import {
  MAPS_ERROR_CODES,
  TRAVEL_MODES,
  createGoogleMapsProvider,
  enrichVenueTravelTimes,
  getInitialRadiusMeters,
  resolveLocation,
  searchTennisVenues,
} from '../packages/maps/src/index.mjs';

function usage() {
  console.error('Usage: npm run maps:check -- "University of Sydney"');
}

function printLocation(location) {
  console.log(`Resolved location: ${location.label}`);
  console.log(`Coordinates: ${location.lat}, ${location.lng}`);
  console.log(`Source: ${location.source}`);
}

function printVenues(venues) {
  console.log(`Venues found: ${venues.length}`);
  console.log('');
  console.log('Top venues:');
  for (const venue of venues.slice(0, 5)) {
    console.log(`- ${venue.name ?? 'Unnamed venue'}`);
    console.log(`  address: ${venue.address ?? 'unknown'}`);
    console.log(`  travelTimeMinutes: ${venue.travel?.durationMinutes ?? 'unknown'}`);
    console.log(`  availability: ${venue.availability.status}`);
  }
}

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    usage();
    process.exitCode = 1;
    return;
  }

  let provider;
  try {
    provider = createGoogleMapsProvider();
  } catch (error) {
    if (error.code === MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED) {
      console.error(`${MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED}: GOOGLE_MAPS_API_KEY is not configured.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const location = await resolveLocation({
    type: 'user_text',
    query,
  }, { provider });
  const radiusMeters = getInitialRadiusMeters();
  const venues = await searchTennisVenues({
    center: location,
    radiusMeters,
    limit: 5,
    provider,
  });
  const withTravel = await enrichVenueTravelTimes({
    origin: location,
    venues,
    mode: TRAVEL_MODES.TRANSIT,
    modeValueSource: 'product_default',
    provider,
  });

  printLocation(location);
  console.log(`Radius: ${radiusMeters}m`);
  console.log(`Travel mode: ${TRAVEL_MODES.TRANSIT}`);
  console.log('');
  printVenues(withTravel);
}

main().catch((error) => {
  console.error(`${error.code ?? 'MAPS_CHECK_FAILED'}: ${error.message}`);
  process.exitCode = 1;
});
