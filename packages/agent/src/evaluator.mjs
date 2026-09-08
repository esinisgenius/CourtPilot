import {
  candidateMatchesTransportPreference,
  candidatePreferredTransportModes,
  matchesStartTimeRule,
} from '../../core/src/index.mjs';

function preferencePriority(preference) {
  return preference.priority ?? preference.importance ?? 'uncertain';
}

function preferenceMatchesCandidate(preference, candidate) {
  const directMatch = candidate.matches?.[preference.feature];
  if (typeof directMatch === 'boolean') return directMatch;

  if (preference.feature === 'next_hour_free') {
    return candidate.features?.nextHourFree === preference.target;
  }

  if (preference.feature === 'consecutive_availability') {
    const minutes = preference.rule?.minMinutes ?? preference.rule?.preferredMinutes;
    if (minutes === 120 && typeof candidate.features?.nextHourFree === 'boolean') {
      return candidate.features.nextHourFree;
    }
    return null;
  }

  if (preference.feature === 'start_time' && preference.rule && candidate.features?.localTime) {
    return matchesStartTimeRule(candidate.features.localTime, preference.rule) === true;
  }

  if (preference.feature === 'court' && preference.value !== undefined) {
    return candidate.court === preference.value;
  }

  if (preference.feature === 'venue' && preference.value !== undefined) {
    return candidate.venue === preference.value;
  }

  if (preference.feature === 'price') {
    return candidate.features?.price !== null && candidate.features?.price !== undefined;
  }

  if (preference.feature === 'travel_time') {
    const thresholdMatch = candidateMatchesTransportPreference(candidate, preference.rule ?? {});
    if (thresholdMatch !== null) return thresholdMatch;
    const modeMatch = candidatePreferredTransportModes(candidate, preference.rule ?? {});
    return modeMatch?.matches ?? null;
  }

  return null;
}

function failedHardConstraintsFromRejected(rejectedCandidates = [], failedConstraints = []) {
  const failed = [...failedConstraints];

  for (const candidate of rejectedCandidates) {
    for (const constraint of candidate.failedConstraints ?? candidate.reasons ?? []) {
      failed.push(constraint);
    }
  }

  return failed;
}

function evaluateCandidateSet({
  candidates = [],
  rejectedCandidates = [],
  preferences = {},
  failedConstraints = [],
  factualObservations = {},
  minCandidates = 1,
} = {}) {
  const hardFailures = failedHardConstraintsFromRejected(rejectedCandidates, failedConstraints);
  const softPreferences = preferences.preferences ?? [];
  const weakPreferences = [];
  const observationIssues = [];
  const observedVenues = factualObservations.maps?.venues ?? factualObservations.venues ?? [];
  const unknownAvailabilityVenues = observedVenues.filter((venue) => venue.availability?.status === 'unknown');

  if (candidates.length === 0 && unknownAvailabilityVenues.length > 0) {
    observationIssues.push({
      code: 'maps_venue_availability_not_verified',
      reason: 'Maps venue observations are venue-level only and do not verify bookable court availability.',
      count: unknownAvailabilityVenues.length,
    });
  }

  for (const preference of softPreferences) {
    const matches = candidates
      .map((candidate) => preferenceMatchesCandidate(preference, candidate))
      .filter((match) => match !== null);

    const priority = preferencePriority(preference);
    const matchedByAnyCandidate = matches.some(Boolean);

    if (priority !== 'low' && matches.length > 0 && !matchedByAnyCandidate) {
      weakPreferences.push({
        feature: preference.feature,
        priority,
        relaxable: preference.relaxable ?? true,
        reason: 'No current candidate satisfies this soft preference.',
      });
    }

    if (priority === 'high' && matches.length === 0) {
      weakPreferences.push({
        feature: preference.feature,
        priority,
        relaxable: preference.relaxable ?? true,
        reason: 'Candidate facts are insufficient to judge this high-priority preference.',
      });
    }
  }

  const reasons = [];
  if (candidates.length < minCandidates) reasons.push('candidate_count_below_minimum');
  if (hardFailures.length > 0) reasons.push('hard_constraints_failed');
  if (observationIssues.length > 0) reasons.push('factual_observations_insufficient');
  if (weakPreferences.some((preference) => preference.priority === 'high')) {
    reasons.push('high_priority_preferences_weak');
  }

  return {
    satisfactory: reasons.length === 0,
    reasons,
    failedConstraints: hardFailures,
    weakPreferences,
    observationIssues,
  };
}

export {
  evaluateCandidateSet,
  preferenceMatchesCandidate,
};
