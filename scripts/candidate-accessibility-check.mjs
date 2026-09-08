#!/usr/bin/env node
import {
  enrichCandidateAccessibility,
} from '../packages/core/src/index.mjs';
import {
  MAPS_ERROR_CODES,
  createGoogleMapsProvider,
} from '../packages/maps/src/index.mjs';

function nextSlotStartIso() {
  const date = new Date(Date.now() + 2 * 60 * 60 * 1000);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function candidate(id, venue, startTime) {
  return {
    id,
    venue,
    court: 'Synthetic Court',
    startTime,
    durationMinutes: 60,
    features: {
      nextHourFree: null,
      localDate: null,
      localTime: null,
      price: null,
      venue: {
        id,
        name: venue,
        address: venue,
        location: null,
        placeId: null,
      },
    },
  };
}

function printMode(label, value) {
  console.log(`  ${label}: ${value.durationMinutes ?? 'unavailable'} min, ${value.distanceMeters ?? 'unavailable'} m`);
  if (value.unavailableReason) console.log(`    unavailableReason: ${value.unavailableReason}`);
}

const originText = process.argv[2] ?? 'The University of Sydney, Camperdown NSW 2006, Australia';
const venueTexts = process.argv.length > 3
  ? process.argv.slice(3)
  : [
    'Burwood Tennis Courts, Burwood NSW, Australia',
    'Strathfield Sports Club, Strathfield NSW, Australia',
    'Moore Park Tennis Courts, Moore Park NSW, Australia',
  ];
const startTime = nextSlotStartIso();

try {
  const provider = createGoogleMapsProvider();
  const candidates = venueTexts.map((venue, index) => candidate(`candidate-${index + 1}`, venue, startTime));
  const enriched = await enrichCandidateAccessibility({
    candidates,
    originText,
    provider,
  });

  console.log(`Origin: ${enriched[0]?.accessibility.origin.label ?? originText}`);
  console.log(`Candidate slot startTime: ${startTime}`);
  console.log('');
  for (const item of enriched) {
    console.log(`- ${item.id} | ${item.venue}`);
    printMode('WALK', item.accessibility.walk);
    printMode('TRANSIT', item.accessibility.transit);
    console.log(`    departureTime: ${item.accessibility.transit.departureTime ?? 'provider_default'}`);
    printMode('DRIVE', item.accessibility.drive);
  }
} catch (error) {
  if (error.code === MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED) {
    console.error(`${MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED}: GOOGLE_MAPS_API_KEY is not configured.`);
  } else {
    console.error(`${error.code ?? 'CANDIDATE_ACCESSIBILITY_CHECK_FAILED'}: ${error.message}`);
  }
  process.exitCode = 1;
}
