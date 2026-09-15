import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCandidateEligibilityGate,
  buildCandidates,
  canonicalAvailability,
  evaluateCandidateEligibility,
  legacyAvailabilityFromCanonical,
} from '../packages/core/src/index.mjs';

function candidate({
  provider = 'sportlogic',
  venue = {
    id: 'sportlogic-burwood-tennis-courts',
    name: 'Burwood Tennis Courts',
    providerVenueId: '1',
  },
  eligibility = {
    sport: {
      type: 'tennis',
      proof: 'provider_venue',
    },
  },
} = {}) {
  const canonical = canonicalAvailability({
    provider,
    venue,
    court: {
      id: `${provider}-court-1`,
      name: 'Court 1',
      providerCourtId: 'court-1',
      surface: null,
    },
    startTime: '2026-09-13T20:00:00+10:00',
    durationMinutes: 60,
    eligibility,
    provenance: {
      source: 'live',
      auth: 'public',
      observedAt: '2026-09-12T10:00:00+10:00',
      availabilityMethod: 'test_fixture',
    },
  });
  return buildCandidates([legacyAvailabilityFromCanonical(canonical)])[0];
}

test('sport eligibility requires positive tennis proof', () => {
  const result = evaluateCandidateEligibility(candidate({ eligibility: null }));

  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons.map((reason) => reason.reason), [
    'sport_eligibility_insufficient',
  ]);
});

test('tennis resource proof passes sport eligibility when no explicit target exists', () => {
  const result = evaluateCandidateEligibility(candidate({
    provider: 'bookable',
    eligibility: {
      sport: {
        type: 'tennis',
        proof: 'provider_resource',
      },
    },
  }));

  assert.equal(result.eligible, true);
});

test('golf provider result is removed before the final candidate pool', () => {
  const [golf] = buildCandidates([{
    provider: 'fixture',
    venue: 'Centennial Park Golf Course',
    court: 'Driving Range Bay 1',
    startTime: '2026-09-13T20:00:00+10:00',
    durationMinutes: 60,
    sport: 'golf',
    category: 'golf course',
    venueType: 'driving range',
  }]);

  const gate = applyCandidateEligibilityGate({ candidates: [golf] });

  assert.equal(gate.accepted.length, 0);
  assert.equal(gate.rejected.length, 1);
  assert.equal(gate.rejected[0].reasons[0].reason, 'sport_eligibility_excluded');
});

test('explicit tennis provider result is retained by the eligibility gate', () => {
  const [tennis] = buildCandidates([{
    provider: 'fixture',
    venue: 'Zetland Tennis Centre',
    court: 'Court 1',
    startTime: '2026-09-13T20:00:00+10:00',
    durationMinutes: 60,
    sport: 'tennis',
    category: 'tennis court',
  }]);

  const gate = applyCandidateEligibilityGate({ candidates: [tennis] });

  assert.deepEqual(gate.accepted.map((entry) => entry.venue), ['Zetland Tennis Centre']);
  assert.equal(gate.rejected.length, 0);
});

test('explicit configured target accepts only matched venue candidates', () => {
  const burwood = candidate();
  const susf = candidate({
    provider: 'susf',
    venue: {
      id: 'susf',
      name: 'SUSF',
      providerVenueId: 'susf',
    },
    eligibility: {
      sport: {
        type: 'tennis',
        proof: 'verified_booking_page',
      },
    },
  });

  const gate = applyCandidateEligibilityGate({
    candidates: [burwood, susf],
    searchScope: {
      targetLocation: { text: 'burwood附近' },
      locationRouting: {
        status: 'matched_configured_venue',
        matchedVenues: [
          {
            id: 'sportlogic-burwood-tennis-courts',
            name: 'Burwood Tennis Courts',
            provider: 'sportlogic',
          },
        ],
      },
    },
  });

  assert.deepEqual(gate.accepted.map((entry) => entry.venue), ['Burwood Tennis Courts']);
  assert.equal(gate.rejected.length, 1);
  assert.equal(gate.rejected[0].candidate.venue, 'SUSF');
  assert.equal(gate.rejected[0].reasons[0].reason, 'candidate_outside_target_scope');
});

test('explicit configured target accepts provider candidates with matching normalized venue id', () => {
  const susf = candidate({
    provider: 'susf',
    venue: {
      id: 'susf-tennis',
      name: 'Sydney Uni Sport Tennis Courts',
      providerVenueId: 'susf',
      location: { lat: -33.8886, lng: 151.1873 },
    },
    eligibility: {
      sport: {
        type: 'tennis',
        proof: 'verified_booking_page',
      },
    },
  });

  const gate = applyCandidateEligibilityGate({
    candidates: [susf],
    searchScope: {
      targetLocation: { text: '悉大', center: { lat: -33.8884215, lng: 151.1873883 } },
      locationRouting: {
        status: 'matched_geographic_scope',
        matchedVenues: [
          {
            id: 'susf-tennis',
            name: 'Sydney Uni Sport Tennis Courts',
            provider: 'susf',
          },
        ],
      },
    },
  });

  assert.equal(gate.rejected.length, 0);
  assert.deepEqual(gate.accepted.map((entry) => entry.venue), ['Sydney Uni Sport Tennis Courts']);
});

test('explicit unresolved target rejects instead of silently accepting unknown geography', () => {
  const result = evaluateCandidateEligibility(candidate(), {
    targetLocation: { text: 'some unknown tennis suburb' },
    locationRouting: {
      status: 'unmatched',
      matchedVenues: [],
    },
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons.map((reason) => reason.reason), [
    'target_scope_unresolved',
  ]);
});

test('explicit coordinate target rejects candidates without venue coordinates', () => {
  const result = evaluateCandidateEligibility(candidate(), {
    targetLocation: {
      text: 'near a resolved point',
      center: { lat: -33.877, lng: 151.103 },
      radiusMeters: 3000,
    },
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons.map((reason) => reason.reason), [
    'geographic_eligibility_insufficient',
  ]);
});

test('input "在 city 打" rejects Cavanagh Reserve when city scope is unresolved', () => {
  const cavanagh = candidate({
    provider: 'bookable',
    venue: {
      id: 'bookable-blacktown-cavanagh-reserve',
      name: 'Cavanagh Reserve',
      providerVenueId: '38',
    },
    eligibility: {
      sport: {
        type: 'tennis',
        proof: 'provider_resource',
      },
    },
  });

  const gate = applyCandidateEligibilityGate({
    candidates: [cavanagh],
    searchScope: {
      location: 'city',
      sourceText: '在 city 打',
      source: 'user',
      isExplicit: true,
      targetLocation: { text: 'city' },
      locationRouting: {
        status: 'unmatched',
        query: 'city',
        matchedVenues: [],
      },
    },
  });

  assert.equal(gate.accepted.length, 0);
  assert.equal(gate.rejected.length, 1);
  assert.equal(gate.rejected[0].candidate.venue, 'Cavanagh Reserve');
  assert.deepEqual(gate.rejected[0].reasons.map((reason) => reason.reason), [
    'target_scope_unresolved',
  ]);
});
