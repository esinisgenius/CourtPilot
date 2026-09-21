import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getSnapshotAvailability,
  publishSnapshot,
} from '../packages/availability-snapshots/src/store.mjs';

function slot({ venueId = 'venue-one', start = '2026-09-22T10:00:00+10:00', durationMinutes = 60 } = {}) {
  return {
    venue: 'Fixture Tennis',
    court: 'Court 1',
    startTime: start,
    durationMinutes,
    canonical: {
      provider: 'fixture',
      venue: { id: venueId },
      slot: { start, durationMinutes },
    },
  };
}

test('local snapshot store publishes per venue without replacing other venues', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'courtpilot-snapshots-'));
  const filePath = join(directory, 'snapshots.json');
  await publishSnapshot({ providerId: 'fixture', venueId: 'venue-one', availability: [slot()] }, { filePath });
  await publishSnapshot({ providerId: 'fixture', venueId: 'venue-two', availability: [slot({ venueId: 'venue-two' })] }, { filePath });
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(Object.keys(stored.snapshots).sort(), ['fixture:venue-one', 'fixture:venue-two']);
});

test('snapshot reader filters venue date time and duration deterministically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'courtpilot-snapshots-'));
  const filePath = join(directory, 'snapshots.json');
  await publishSnapshot({
    providerId: 'fixture',
    venueId: 'venue-one',
    availability: [
      slot(),
      slot({ start: '2026-09-22T18:00:00+10:00' }),
      slot({ start: '2026-09-23T10:00:00+10:00', durationMinutes: 120 }),
    ],
  }, { filePath });
  const rows = await getSnapshotAvailability('fixture', {
    filePath,
    venues: [{ id: 'venue-one' }],
    date: '2026-09-22',
    days: 1,
    timeStart: '17:00',
    durationMinutes: 60,
  });
  assert.deepEqual(rows.map((row) => row.startTime), ['2026-09-22T18:00:00+10:00']);
  assert.equal(rows.snapshot.venueCount, 1);
});
