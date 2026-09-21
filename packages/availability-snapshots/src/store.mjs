import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SNAPSHOT_VERSION = 1;
const DEFAULT_LOCAL_PATH = resolve('data/availability-snapshots.json');

class AvailabilitySnapshotError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'AvailabilitySnapshotError';
    this.code = code;
  }
}

function snapshotKey(providerId, venueId) {
  return `${providerId}:${venueId}`;
}

function supabaseConfig({ write = false } = {}) {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = write
    ? process.env.SUPABASE_SERVICE_ROLE_KEY
    : process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function remoteSnapshotConfig() {
  const url = process.env.AVAILABILITY_SNAPSHOT_BASE_URL?.replace(/\/$/, '');
  const token = process.env.AVAILABILITY_SNAPSHOT_TOKEN;
  return url && token ? { url, token } : null;
}

function headersForSupabase(key, extra = {}) {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    ...extra,
  };
}

async function readLocalSnapshots(filePath = process.env.AVAILABILITY_SNAPSHOT_PATH ?? DEFAULT_LOCAL_PATH) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed?.version === SNAPSHOT_VERSION && parsed.snapshots ? parsed : { version: SNAPSHOT_VERSION, snapshots: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: SNAPSHOT_VERSION, snapshots: {} };
    throw error;
  }
}

async function writeLocalSnapshot(snapshot, filePath = process.env.AVAILABILITY_SNAPSHOT_PATH ?? DEFAULT_LOCAL_PATH) {
  const store = await readLocalSnapshots(filePath);
  store.snapshots[snapshotKey(snapshot.providerId, snapshot.venueId)] = snapshot;
  store.updatedAt = new Date().toISOString();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`);
  return snapshot;
}

async function writeSupabaseSnapshot(snapshot, config) {
  const row = {
    provider_id: snapshot.providerId,
    venue_id: snapshot.venueId,
    status: snapshot.status,
    collected_at: snapshot.collectedAt,
    slot_count: snapshot.availability.length,
    payload: snapshot.availability,
    error: snapshot.error,
    version: SNAPSHOT_VERSION,
  };
  const response = await fetch(`${config.url}/rest/v1/availability_snapshots?on_conflict=provider_id,venue_id`, {
    method: 'POST',
    headers: headersForSupabase(config.key, { prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!response.ok) {
    throw new AvailabilitySnapshotError('SNAPSHOT_WRITE_FAILED', `Supabase snapshot write returned HTTP ${response.status}: ${await response.text()}`);
  }
  return snapshot;
}

async function publishSnapshot(snapshot, options = {}) {
  const normalized = {
    version: SNAPSHOT_VERSION,
    providerId: snapshot.providerId,
    venueId: snapshot.venueId,
    status: snapshot.status ?? 'success',
    collectedAt: snapshot.collectedAt ?? new Date().toISOString(),
    availability: Array.isArray(snapshot.availability) ? snapshot.availability : [],
    error: snapshot.error ?? null,
  };
  const config = supabaseConfig({ write: true });
  if (config) return writeSupabaseSnapshot(normalized, config);
  return writeLocalSnapshot(normalized, options.filePath);
}

function rowsToSnapshots(rows) {
  return rows.map((row) => ({
    version: row.version,
    providerId: row.provider_id,
    venueId: row.venue_id,
    status: row.status,
    collectedAt: row.collected_at,
    availability: row.payload ?? [],
    error: row.error ?? null,
  }));
}

async function loadProviderSnapshots(providerId, options = {}) {
  const remote = remoteSnapshotConfig();
  if (remote) {
    const query = new URLSearchParams({ providerId });
    const response = await fetch(`${remote.url}/snapshots?${query}`, {
      headers: { authorization: `Bearer ${remote.token}` },
      signal: options.signal,
    });
    if (!response.ok) {
      throw new AvailabilitySnapshotError('SNAPSHOT_READ_FAILED', `Remote snapshot read returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    return Array.isArray(payload.snapshots) ? payload.snapshots : [];
  }
  const config = supabaseConfig();
  if (!config) {
    const store = await readLocalSnapshots(options.filePath);
    return Object.values(store.snapshots).filter((snapshot) => snapshot.providerId === providerId);
  }
  const query = new URLSearchParams({
    select: 'provider_id,venue_id,status,collected_at,slot_count,payload,error,version',
    provider_id: `eq.${providerId}`,
  });
  const response = await fetch(`${config.url}/rest/v1/availability_snapshots?${query}`, {
    headers: headersForSupabase(config.key),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new AvailabilitySnapshotError('SNAPSHOT_READ_FAILED', `Supabase snapshot read returned HTTP ${response.status}`);
  }
  return rowsToSnapshots(await response.json());
}

function requestedVenueIds(options = {}) {
  if (!Array.isArray(options.venues)) return null;
  return new Set(options.venues.map((venue) => venue.id).filter(Boolean));
}

function withinWindow(slot, options = {}) {
  const start = slot?.canonical?.slot?.start ?? slot?.startTime;
  if (!start) return false;
  const localDate = start.slice(0, 10);
  const localTime = start.slice(11, 16);
  const dateStart = options.date ?? options.dateStart ?? null;
  const days = Number(options.days ?? 1);
  const dateEnd = options.dateEnd ?? (dateStart
    ? new Date(`${dateStart}T00:00:00Z`).toISOString().slice(0, 10)
    : null);
  let effectiveEnd = dateEnd;
  if (dateStart && !options.dateEnd && days > 1) {
    const end = new Date(`${dateStart}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + days - 1);
    effectiveEnd = end.toISOString().slice(0, 10);
  }
  if (dateStart && localDate < dateStart) return false;
  if (effectiveEnd && localDate > effectiveEnd) return false;
  if (options.timeStart && localTime < options.timeStart) return false;
  if (options.timeEnd && localTime > options.timeEnd) return false;
  if (options.durationMinutes && Number(slot?.canonical?.slot?.durationMinutes ?? slot?.durationMinutes) !== Number(options.durationMinutes)) return false;
  return true;
}

async function getSnapshotAvailability(providerId, options = {}) {
  const snapshots = await loadProviderSnapshots(providerId, options);
  if (snapshots.length === 0) {
    throw new AvailabilitySnapshotError('SNAPSHOT_UNAVAILABLE', `No published availability snapshot exists for ${providerId}`);
  }
  const venueIds = requestedVenueIds(options);
  const selected = venueIds ? snapshots.filter((snapshot) => venueIds.has(snapshot.venueId)) : snapshots;
  const maxAgeMs = Number(process.env.AVAILABILITY_SNAPSHOT_MAX_AGE_MS ?? 30 * 60 * 1000);
  const usable = selected.filter((snapshot) => snapshot.status === 'success' && Array.isArray(snapshot.availability));
  if (usable.length === 0) {
    throw new AvailabilitySnapshotError('SNAPSHOT_UNAVAILABLE', `No successful availability snapshot exists for ${providerId}`);
  }
  const availability = usable.flatMap((snapshot) => snapshot.availability).filter((slot) => withinWindow(slot, options));
  const oldestMs = Math.min(...usable.map((snapshot) => Date.parse(snapshot.collectedAt)).filter(Number.isFinite));
  availability.snapshot = {
    providerId,
    venueCount: usable.length,
    collectedAt: new Date(oldestMs).toISOString(),
    stale: Date.now() - oldestMs > maxAgeMs,
  };
  return availability;
}

function snapshotFetcher(providerId) {
  return (options = {}) => getSnapshotAvailability(providerId, options);
}

export {
  AvailabilitySnapshotError,
  DEFAULT_LOCAL_PATH,
  SNAPSHOT_VERSION,
  getSnapshotAvailability,
  loadProviderSnapshots,
  publishSnapshot,
  snapshotFetcher,
};
