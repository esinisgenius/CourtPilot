import {
  DEFAULT_INTRAC_VENUES,
  discoverCourtIdentity,
  discoverVenues,
  readVenueAvailability,
} from '../packages/intrac/src/index.mjs';

const date = process.env.INTRAC_DATE ?? todaySydneyIsoDate();
const durationMinutes = Number(process.env.INTRAC_DURATION ?? 60);
const identityDiscoveryDays = Number(process.env.INTRAC_IDENTITY_DAYS ?? 14);
const venues = discoverVenues({ venues: DEFAULT_INTRAC_VENUES });

function todaySydneyIsoDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

const successes = [];
const failures = [];
let total = 0;
let samples = [];

for (const venue of venues) {
  try {
    const discovery = await discoverCourtIdentity({
      venue,
      date,
      days: identityDiscoveryDays,
    });
    const { courtMap } = discovery;
    const availability = await readVenueAvailability(venue, {
      date,
      durationMinutes,
      identityDiscoveryDays,
      discovery,
    });
    total += availability.length;
    samples = samples.concat(availability.slice(0, Math.max(0, 5 - samples.length)));

    const courts = new Map();
    for (const slot of availability) {
      courts.set(slot.canonical.court.providerCourtId, slot.court);
    }

    successes.push({
      id: venue.id,
      name: venue.name,
      suburb: venue.suburb,
      officialUrl: venue.officialUrl,
      locationId: venue.locationId,
      auditCourtCount: venue.auditCourtCount,
      dynamicCourtCount: courtMap.size,
      auditCountMatchesDynamic: venue.auditCourtCount === courtMap.size,
      dynamicCourtsWithAvailability: courts.size,
      slotCount: availability.length,
      discoveredCourts: [...courtMap.values()].map((court) => ({
        name: court.name,
        providerCourtId: court.providerCourtId,
      })),
      courtsWithAvailability: [...courts.values()],
    });
  } catch (error) {
    failures.push({
      id: venue.id,
      name: venue.name,
      officialUrl: venue.officialUrl,
      code: error.code ?? 'INTRAC_PROVIDER_ERROR',
      message: error.message,
    });
  }
}

console.log(JSON.stringify({
  date,
  durationMinutes,
  identityDiscoveryDays,
  venueCount: venues.length,
  successCount: successes.length,
  failureCount: failures.length,
  total,
  successes,
  failures,
  samples,
}, null, 2));

if (failures.length > 0) process.exitCode = 1;
