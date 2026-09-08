import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHardConstraints } from '../packages/core/src/index.mjs';
import {
  buildRankerInput,
  fallbackRankCandidates,
  rankCandidates,
  validateRankerOutput,
} from '../packages/ranking/src/index.mjs';

function candidate({
  id,
  price,
  transitMinutes,
  walkMinutes = 18,
  driveMinutes = 10,
  nextHourFree = false,
  startTime = '2026-09-10T07:00:00.000Z',
}) {
  const accessibility = {
    walk: {
      durationMinutes: walkMinutes,
      distanceMeters: Number.isFinite(walkMinutes) ? walkMinutes * 90 : null,
      unavailableReason: Number.isFinite(walkMinutes) ? null : 'route_not_found',
    },
    transit: {
      durationMinutes: transitMinutes,
      distanceMeters: Number.isFinite(transitMinutes) ? transitMinutes * 120 : null,
      unavailableReason: Number.isFinite(transitMinutes) ? null : 'route_not_found',
    },
    drive: {
      durationMinutes: driveMinutes,
      distanceMeters: Number.isFinite(driveMinutes) ? driveMinutes * 220 : null,
      unavailableReason: Number.isFinite(driveMinutes) ? null : 'route_not_found',
    },
  };

  return {
    id,
    venue: 'SUSF',
    court: `Court ${id}`,
    startTime,
    durationMinutes: 60,
    accessibility,
    features: {
      nextHourFree,
      price,
      priceOptions: [],
      localDate: '2026-09-10',
      localTime: '17:00',
      accessibility,
      calendar: { free: true, source: 'synthetic' },
      weather: { forecastAvailable: true, precipitationProbability: 0, precipitationMm: 0 },
    },
    source: {
      availability: { status: 'verified', source: 'synthetic' },
    },
  };
}

function abcCandidates() {
  return [
    candidate({ id: 'A', price: 23, transitMinutes: 35, nextHourFree: true }),
    candidate({ id: 'B', price: 39, transitMinutes: 24, nextHourFree: true }),
    candidate({ id: 'C', price: 30, transitMinutes: 26, nextHourFree: false }),
  ];
}

function softTradeoffProfile() {
  return {
    version: 2,
    sourceText: '便宜一点，公交最好30分钟内，远一点也行，最好连续两小时',
    transportPreference: {
      maxTransitMinutes: 30,
      preferredTransportModes: ['TRANSIT'],
    },
    hardConstraints: [],
    preferences: [
      {
        feature: 'travel_time',
        type: 'soft',
        priority: 'high',
        importance: 'high',
        relaxable: true,
        rule: { maxTransitMinutes: 30, preferredTransportModes: ['TRANSIT'] },
      },
      {
        feature: 'consecutive_availability',
        type: 'soft',
        priority: 'high',
        importance: 'high',
        relaxable: true,
        rule: { preferredMinutes: 120 },
      },
      {
        feature: 'price',
        type: 'soft',
        priority: 'medium',
        importance: 'medium',
        direction: 'lower',
        relaxable: true,
      },
    ],
    objectives: [],
    unresolvedPreferences: [],
  };
}

test('hard rejected candidates do not enter the bounded LLM ranker', async () => {
  const candidates = abcCandidates();
  const preferenceProfile = {
    ...softTradeoffProfile(),
    hardConstraints: [{
      feature: 'travel_time',
      type: 'hard',
      priority: 'high',
      importance: 'high',
      rule: { maxTransitMinutes: 30 },
    }],
  };
  const hardFiltered = applyHardConstraints({
    candidates,
    preferenceProfile,
    defaultCalendarBusyIsHard: true,
  });
  const seenByProvider = [];

  const result = await rankCandidates({
    preferenceProfile,
    candidates: hardFiltered.accepted,
    provider: ({ input }) => {
      seenByProvider.push(...input.candidates.map((item) => item.candidateId));
      return {
        rankedCandidates: input.candidates.map((item, index) => ({
          candidateId: item.candidateId,
          rank: index + 1,
          reasons: ['Uses only provided facts.'],
          tradeoffs: ['No replanning action proposed.'],
        })),
      };
    },
  });

  assert.deepEqual(hardFiltered.rejected.map((item) => item.candidate.id), ['A']);
  assert.deepEqual(seenByProvider.sort(), ['B', 'C']);
  assert.deepEqual(result.rankedCandidates.map((item) => item.candidateId).sort(), ['B', 'C']);
});

test('ranker input contains factual candidate snapshots only', () => {
  const [first] = abcCandidates();
  const input = buildRankerInput({
    preferenceProfile: softTradeoffProfile(),
    candidates: [first],
  });

  assert.equal(input.candidates[0].candidateId, 'A');
  assert.equal(input.candidates[0].price.amount, 23);
  assert.equal(input.candidates[0].continuousDurationMinutes, 120);
  assert.equal(input.candidates[0].accessibility.TRANSIT.durationMinutes, 35);
  assert.equal(input.candidates[0].weather.precipitationProbability, 0);
  assert.equal(input.candidates[0].calendar.free, true);
  assert.equal(input.candidates[0].source, undefined);
});

test('LLM factual value rewrites are rejected and fall back deterministically', async () => {
  const candidates = abcCandidates();
  const result = await rankCandidates({
    preferenceProfile: softTradeoffProfile(),
    candidates,
    provider: () => ({
      rankedCandidates: [
        {
          candidateId: 'A',
          rank: 1,
          reasons: ['Price is $1 and transit is 5 minutes.'],
          tradeoffs: ['Invented facts should not pass.'],
        },
        { candidateId: 'B', rank: 2, reasons: ['Price is $39.'], tradeoffs: ['Transit is 24 minutes.'] },
        { candidateId: 'C', rank: 3, reasons: ['Price is $30.'], tradeoffs: ['Transit is 26 minutes.'] },
      ],
    }),
  });

  const text = JSON.stringify(result);
  assert.equal(text.includes('$1'), false);
  assert.equal(text.includes('transit is 5 minutes'), false);
  assert.deepEqual(result.rankedCandidates.map((item) => item.candidateId), ['B', 'A', 'C']);
});

test('fallback explains the soft price, transit, and continuous-duration tradeoff', () => {
  const result = fallbackRankCandidates({
    preferenceProfile: softTradeoffProfile(),
    candidates: abcCandidates(),
  });

  assert.deepEqual(result.rankedCandidates.map((item) => item.candidateId), ['B', 'A', 'C']);
  assert.match(result.rankedCandidates[0].reasons.join(' '), /Transit fact is 24 minutes/);
  assert.match(result.rankedCandidates[1].tradeoffs.join(' '), /35 minutes over the preferred 30 minutes/);
  assert.match(result.rankedCandidates[2].tradeoffs.join(' '), /only 60 minutes/);
});

test('invalid LLM response falls back without failing the agent', async () => {
  const result = await rankCandidates({
    preferenceProfile: softTradeoffProfile(),
    candidates: abcCandidates(),
    provider: () => ({
      rankedCandidates: [
        { candidateId: 'A', rank: 1, reasons: ['ok'], tradeoffs: ['ok'] },
        { candidateId: 'A', rank: 2, reasons: ['duplicate'], tradeoffs: ['duplicate'] },
        { candidateId: 'D', rank: 3, reasons: ['unknown'], tradeoffs: ['unknown'] },
      ],
    }),
  });

  assert.deepEqual(result.rankedCandidates.map((item) => item.candidateId), ['B', 'A', 'C']);
});

test('provider errors and timeouts fall back', async () => {
  const providerError = await rankCandidates({
    preferenceProfile: softTradeoffProfile(),
    candidates: abcCandidates(),
    provider: () => {
      throw new Error('provider_error');
    },
  });

  const timeout = await rankCandidates({
    preferenceProfile: softTradeoffProfile(),
    candidates: abcCandidates(),
    timeoutMs: 5,
    provider: () => new Promise(() => {}),
  });

  assert.deepEqual(providerError.rankedCandidates.map((item) => item.candidateId), ['B', 'A', 'C']);
  assert.deepEqual(timeout.rankedCandidates.map((item) => item.candidateId), ['B', 'A', 'C']);
});

test('fallback ranking is deterministic and repeatable', () => {
  const first = fallbackRankCandidates({
    preferenceProfile: softTradeoffProfile(),
    candidates: abcCandidates(),
  });
  const second = fallbackRankCandidates({
    preferenceProfile: structuredClone(softTradeoffProfile()),
    candidates: structuredClone(abcCandidates()),
  });

  assert.deepEqual(first, second);
});

test('ranker output validator rejects facts outside the candidate set', () => {
  const candidates = abcCandidates();
  const input = buildRankerInput({
    preferenceProfile: softTradeoffProfile(),
    candidates,
  });

  assert.throws(() => validateRankerOutput({
    rankedCandidates: [
      { candidateId: 'A', rank: 1, reasons: ['Price is $23.'], tradeoffs: ['ok'] },
      { candidateId: 'B', rank: 2, reasons: ['Price is $39.'], tradeoffs: ['ok'] },
      { candidateId: 'C', rank: 3, reasons: ['Transit is 999 minutes.'], tradeoffs: ['ok'] },
    ],
  }, {
    candidateFacts: input.candidates,
    preferenceProfile: softTradeoffProfile(),
  }), /Invalid ranker output/);
});
