import { open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DEFAULT_BOOKABLE_VENUES, getBookableAvailability } from '../packages/bookable/src/index.mjs';
import { DEFAULT_CLUBSPARK_VENUES, getClubSparkAvailability } from '../packages/clubspark/src/index.mjs';
import { DEFAULT_INTRAC_VENUES, getIntracAvailability } from '../packages/intrac/src/index.mjs';
import { DEFAULT_MINDBODY_VENUES, getMindbodyAvailability } from '../packages/mindbody/src/index.mjs';
import { DEFAULT_SPORTLOGIC_VENUES, getSportLogicAvailability } from '../packages/sportlogic/src/index.mjs';
import { getSusfAvailability } from '../packages/susf/src/index.mjs';
import { DEFAULT_UNIFIED_BOOKINGS_VENUES, getUnifiedBookingsAvailability } from '../packages/unified-bookings/src/index.mjs';
import { publishSnapshot } from '../packages/availability-snapshots/src/store.mjs';

const lockPath = resolve(process.env.COLLECTOR_LOCK_PATH ?? '.cache/availability-collector.lock');
const days = Number(process.env.COLLECTOR_DAYS ?? 7);
const durationMinutes = Number(process.env.COLLECTOR_DURATION_MINUTES ?? 60);
const venueTimeoutMs = Number(process.env.COLLECTOR_VENUE_TIMEOUT_MS ?? 120000);
const selectedProviders = new Set((process.env.COLLECTOR_PROVIDERS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const selectedVenues = new Set((process.env.COLLECTOR_VENUES ?? '').split(',').map((value) => value.trim()).filter(Boolean));

const providerJobs = [
  { providerId: 'susf', venues: [{ id: 'susf-tennis', name: 'Sydney Uni Sport Tennis Courts' }], fetcher: getSusfAvailability, single: true },
  { providerId: 'bookable', venues: DEFAULT_BOOKABLE_VENUES, fetcher: getBookableAvailability },
  { providerId: 'clubspark', venues: DEFAULT_CLUBSPARK_VENUES, fetcher: getClubSparkAvailability },
  { providerId: 'unified-bookings', venues: DEFAULT_UNIFIED_BOOKINGS_VENUES, fetcher: getUnifiedBookingsAvailability },
  { providerId: 'sportlogic', venues: DEFAULT_SPORTLOGIC_VENUES, fetcher: getSportLogicAvailability },
  { providerId: 'intrac', venues: DEFAULT_INTRAC_VENUES, fetcher: getIntracAvailability },
  { providerId: 'mindbody', venues: DEFAULT_MINDBODY_VENUES, fetcher: getMindbodyAvailability },
];

function compactError(error) {
  return { code: error.code ?? error.name ?? 'COLLECTION_FAILED', message: error.message };
}

async function withTimeout(fn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error(`Venue collection timed out after ${venueTimeoutMs}ms`);
    error.code = 'COLLECTION_TIMEOUT';
    controller.abort(error);
  }, venueTimeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function collectVenue(job, venue) {
  const startedMs = Date.now();
  try {
    const availability = await withTimeout((signal) => job.fetcher({
      ...(job.single ? {} : { venues: [venue] }),
      days,
      durationMinutes,
      forceRefresh: true,
      signal,
    }));
    const snapshot = await publishSnapshot({
      providerId: job.providerId,
      venueId: venue.id,
      status: 'success',
      collectedAt: new Date().toISOString(),
      availability,
    });
    console.log(JSON.stringify({ event: 'venue_collected', providerId: job.providerId, venueId: venue.id, slots: availability.length, durationMs: Date.now() - startedMs }));
    return snapshot;
  } catch (error) {
    console.error(JSON.stringify({ event: 'venue_failed', providerId: job.providerId, venueId: venue.id, error: compactError(error), durationMs: Date.now() - startedMs }));
    return null;
  }
}

async function main() {
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'ENOENT') {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dirname(lockPath), { recursive: true });
      lock = await open(lockPath, 'wx');
    } else if (error.code === 'EEXIST') {
      console.log(JSON.stringify({ event: 'collector_skipped', reason: 'already_running' }));
      return;
    } else throw error;
  }

  try {
    console.log(JSON.stringify({
      event: 'collector_started',
      days,
      durationMinutes,
      providers: selectedProviders.size > 0 ? [...selectedProviders] : 'all',
      venues: selectedVenues.size > 0 ? [...selectedVenues] : 'all',
    }));
    for (const job of providerJobs.filter((item) => selectedProviders.size === 0 || selectedProviders.has(item.providerId))) {
      for (const venue of job.venues.filter((item) => (
        item.enabled !== false && (selectedVenues.size === 0 || selectedVenues.has(item.id))
      ))) {
        await collectVenue(job, venue);
      }
    }
    console.log(JSON.stringify({ event: 'collector_completed' }));
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

await main();
