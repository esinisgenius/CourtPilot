#!/usr/bin/env node
import {
  MAPS_ERROR_CODES,
  createGoogleMapsProvider,
  enrichVenueAccessibility,
} from '../packages/maps/src/index.mjs';

function nextHourIso() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function printMode(label, value) {
  const duration = value.durationMinutes ?? 'unavailable';
  const distance = value.distanceMeters ?? 'unavailable';
  console.log(`  ${label}: ${duration} min, ${distance} m`);
  if (value.unavailableReason) console.log(`    unavailableReason: ${value.unavailableReason}`);
}

const args = process.argv.slice(2);
const originText = args[0] ?? 'University of Sydney';
const venueTexts = args.length > 1 ? args.slice(1) : ['Burwood', 'Strathfield', 'Moore Park'];
const transitDepartureTime = nextHourIso();

try {
  const provider = createGoogleMapsProvider();
  const venues = venueTexts.map((text) => ({
    id: `smoke:${text.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: text,
  }));
  const enriched = await enrichVenueAccessibility({
    originText,
    venues,
    provider,
    transitDepartureTime,
  });

  console.log(`Origin: ${enriched[0]?.accessibility.origin.label ?? originText}`);
  console.log(`Transit departureTime: ${transitDepartureTime}`);
  console.log('');

  for (const venue of enriched) {
    console.log(`- ${venue.name}`);
    printMode('WALK', venue.accessibility.walk);
    printMode('TRANSIT', venue.accessibility.transit);
    console.log(`    departureTime: ${venue.accessibility.transit.departureTime ?? 'provider_default'}`);
    printMode('DRIVE', venue.accessibility.drive);
  }
} catch (error) {
  if (error.code === MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED) {
    console.error(`${MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED}: GOOGLE_MAPS_API_KEY is not configured.`);
  } else {
    console.error(`${error.code ?? 'MAPS_ACCESSIBILITY_CHECK_FAILED'}: ${error.message}`);
  }
  process.exitCode = 1;
}
