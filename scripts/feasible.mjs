import {
  applyHardConstraints,
  enrichCandidates,
  getCurrentSusfCandidates,
  summarizeCandidates,
} from '../packages/core/src/index.mjs';
import { loadPreferenceProfile } from '../packages/preferences/src/index.mjs';

function syntheticCandidates() {
  return [
    {
      id: 'synthetic-1',
      venue: 'SUSF',
      court: 'Court 4',
      startTime: '2026-09-03T09:00:00.000Z',
      durationMinutes: 60,
      features: {
        nextHourFree: true,
        localDate: '2026-09-03',
        localTime: '19:00',
        preferredTime: true,
        price: null,
        priceOptions: [],
      },
    },
    {
      id: 'synthetic-2',
      venue: 'SUSF',
      court: 'Court 5',
      startTime: '2026-09-03T10:00:00.000Z',
      durationMinutes: 60,
      features: {
        nextHourFree: false,
        localDate: '2026-09-03',
        localTime: '20:00',
        preferredTime: true,
        price: null,
        priceOptions: [],
      },
    },
  ];
}

function rejectionCount(rejected, feature, reason) {
  return rejected.filter((item) => item.reasons.some((candidateReason) => (
    candidateReason.feature === feature
    && (!reason || candidateReason.reason === reason)
  ))).length;
}

function summarizeCandidate(candidate) {
  return {
    id: candidate.id,
    court: candidate.court,
    startTime: candidate.startTime,
    localDate: candidate.features.localDate,
    localTime: candidate.features.localTime,
    nextHourFree: candidate.features.nextHourFree,
    price: candidate.features.price,
    priceOptions: candidate.features.priceOptions,
    weather: candidate.features.weather,
  };
}

const profile = await loadPreferenceProfile();
const syntheticMode = process.env.FEASIBLE_SYNTHETIC === '1';
const candidates = syntheticMode
  ? syntheticCandidates()
  : await getCurrentSusfCandidates({
    days: Number(process.env.SUSF_DAYS_COUNT ?? profile.searchWindowDays ?? 7),
    durationMinutes: Number(process.env.SUSF_DURATION ?? 60),
  });
const enriched = await enrichCandidates({
  candidates,
  weatherAdapter: syntheticMode
    ? async ({ slots }) => slots.map((slot) => ({
      candidateId: slot.id,
      startTime: slot.startTime,
      temperatureC: 21,
      feelsLikeC: 21,
      precipitationProbability: 0,
      precipitationMm: 0,
      windKph: 12,
      weatherCode: '0',
      source: 'synthetic',
      forecastAvailable: true,
    }))
    : undefined,
});
const { accepted, rejected } = applyHardConstraints({
  candidates: enriched,
  preferenceProfile: profile,
});
const summary = summarizeCandidates(candidates);

console.log(JSON.stringify({
  mode: syntheticMode ? 'synthetic' : 'real',
  susfCandidates: summary.total,
  byCourt: summary.byCourt,
  weatherEnriched: enriched.length,
  weatherHardRejects: rejectionCount(rejected, 'weather'),
  feasible: accepted.length,
  topFeasible: accepted.slice(0, 10).map(summarizeCandidate),
}, null, 2));
