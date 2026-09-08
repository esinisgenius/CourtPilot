import {
  DEFAULT_SPORTLOGIC_VENUES,
  bootstrapAnonymousSession,
  discoverCourtIdentity,
  discoverVenues,
  parseBootstrapMetadata,
  readVenueAvailability,
} from '../packages/sportlogic/src/index.mjs';

const date = process.env.SPORTLOGIC_DATE ?? todaySydneyIsoDate();
const durationMinutes = Number(process.env.SPORTLOGIC_DURATION ?? 60);
const identityDiscoveryDays = Number(process.env.SPORTLOGIC_IDENTITY_DAYS ?? 14);
const venues = discoverVenues({ venues: DEFAULT_SPORTLOGIC_VENUES });

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
    const session = await bootstrapAnonymousSession(venue);
    const metadata = parseBootstrapMetadata(session.html, venue);
    const { courtMap } = await discoverCourtIdentity({
      venue,
      metadata,
      date,
      days: identityDiscoveryDays,
      cookieHeader: session.cookieHeader,
      fetchImpl: fetch,
    });
    const availability = await readVenueAvailability(venue, {
      date,
      durationMinutes,
      identityDiscoveryDays,
      bootstrapSessionImpl: async () => session,
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
      clientId: metadata.clientId,
      venueId: metadata.venueId,
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
      code: error.code ?? 'SPORTLOGIC_PROVIDER_ERROR',
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
