import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertConfiguredVenueContract,
  configuredVenueContractIssues,
} from '../packages/core/src/index.mjs';
import { DEFAULT_BOOKABLE_VENUES } from '../packages/bookable/src/index.mjs';
import { DEFAULT_INTRAC_VENUES } from '../packages/intrac/src/index.mjs';
import { DEFAULT_SPORTLOGIC_VENUES } from '../packages/sportlogic/src/index.mjs';
import { DEFAULT_UNIFIED_BOOKINGS_VENUES } from '../packages/unified-bookings/src/index.mjs';
import {
  canonicalVenueInventory,
  venueInventorySummary,
} from '../packages/agent/src/venue-inventory.mjs';

const SUSF_CONFIGURED_VENUE = {
  id: 'susf-tennis',
  name: 'Sydney Uni Sport Tennis Courts',
  suburb: 'Camperdown',
  provider: 'susf',
  providerVenueId: 'susf',
  sport: 'tennis',
  location: { lat: -33.8886, lng: 151.1873 },
  enabled: true,
};

const CONFIGURED_VENUES = [
  SUSF_CONFIGURED_VENUE,
  ...DEFAULT_BOOKABLE_VENUES,
  ...DEFAULT_INTRAC_VENUES,
  ...DEFAULT_SPORTLOGIC_VENUES,
  ...DEFAULT_UNIFIED_BOOKINGS_VENUES,
].filter((venue) => venue.enabled !== false);

test('configured provider venue registries satisfy the normalized venue metadata contract', () => {
  for (const venue of CONFIGURED_VENUES) {
    assertConfiguredVenueContract(venue);
  }
});

test('geo-routeable configured venues carry verified tennis identity and coordinates', () => {
  const routeable = CONFIGURED_VENUES.filter((venue) => venue.location);
  assert.equal(routeable.length > 0, true);

  for (const venue of routeable) {
    assert.deepEqual(configuredVenueContractIssues(venue, {
      requireGeo: true,
      requireTennis: true,
    }), []);
  }
});

test('canonical venue inventory separates static coverage from realtime availability', () => {
  const venues = canonicalVenueInventory();
  const summary = venueInventorySummary(venues);
  assert.equal(summary.verifiedVenues >= 30, true);
  assert.equal(summary.verifiedVenues <= 50, true);
  assert.equal(summary.realtimeVenues < summary.verifiedVenues, true);

  const ids = new Set();
  for (const venue of venues) {
    assert.equal(typeof venue.id, 'string');
    assert.equal(ids.has(venue.id), false);
    ids.add(venue.id);

    if (venue.booking.url !== null) {
      const url = new URL(venue.booking.url);
      assert.equal(['http:', 'https:'].includes(url.protocol), true);
    }

    if (venue.verificationStatus === 'verified') {
      assert.equal(venue.sport, 'tennis');
      assert.equal(Number.isFinite(venue.lat), true);
      assert.equal(Number.isFinite(venue.lng), true);
    }

    if (venue.realtimeAvailability) {
      assert.equal(['susf', 'bookable', 'intrac', 'sportlogic', 'unified-bookings'].includes(venue.provider), true);
    }
  }
});
