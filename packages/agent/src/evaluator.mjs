import {
  candidateMatchesTransportPreference,
  candidatePreferredTransportModes,
  evaluateTransportThresholds,
  matchesStartTimeRule,
} from '../../core/src/index.mjs';

const EVALUATOR_STATUS = Object.freeze({
  SATISFACTORY: 'SATISFACTORY',
  NEEDS_REPLANNING: 'NEEDS_REPLANNING',
  NO_FEASIBLE_CANDIDATES: 'NO_FEASIBLE_CANDIDATES',
});

function preferencePriority(preference) {
  return preference.priority ?? preference.importance ?? 'uncertain';
}

function normalizedTransportRule(rule = {}) {
  if (Number.isFinite(rule.maxTransitMinutes) || !Number.isFinite(rule.maxMinutes)) return rule;
  return {
    ...rule,
    maxTransitMinutes: rule.maxMinutes,
  };
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
    const transportRule = normalizedTransportRule(preference.rule ?? {});
    const venueTravel = candidate.features?.venue?.travel ?? null;
    const venueTravelMinutes = candidate.features?.travelTimeMinutes ?? candidate.features?.venue?.travelTimeMinutes;
    if (Number.isFinite(transportRule.maxTransitMinutes)
      && Number.isFinite(venueTravelMinutes)
      && (!venueTravel?.mode || venueTravel.mode === 'TRANSIT')) {
      return venueTravelMinutes <= transportRule.maxTransitMinutes;
    }
    const thresholdChecks = evaluateTransportThresholds(candidate, transportRule);
    if (thresholdChecks.some((check) => check.accepted === null)) return null;
    const thresholdMatch = candidateMatchesTransportPreference(candidate, transportRule);
    if (thresholdMatch !== null) return thresholdMatch;
    const modeMatch = candidatePreferredTransportModes(candidate, transportRule);
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

function rankedCandidateIds(rankerResult = {}) {
  if (!Array.isArray(rankerResult.rankedCandidates)) return [];
  return [...rankerResult.rankedCandidates]
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.candidateId);
}

function candidateById(candidates = []) {
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

function topRankedCandidate(candidates = [], rankerResult = {}) {
  if (candidates.length === 0) return null;
  const byId = candidateById(candidates);
  const [topId] = rankedCandidateIds(rankerResult);
  return byId.get(topId) ?? candidates[0];
}

function transportViolationSeverity(preference, candidate) {
  const checks = evaluateTransportThresholds(candidate, normalizedTransportRule(preference.rule ?? {}));
  const failedChecks = checks.filter((check) => check.accepted === false);
  if (failedChecks.length === 0) return 'severe';

  const mild = failedChecks.every((check) => {
    if (!Number.isFinite(check.durationMinutes) || !Number.isFinite(check.maxMinutes)) return false;
    const overBy = check.durationMinutes - check.maxMinutes;
    return overBy <= 10 || overBy / check.maxMinutes <= 0.25;
  });

  return mild && preference.relaxable !== false ? 'mild' : 'severe';
}

function softPreferenceJudgement(preference, candidate) {
  const match = preferenceMatchesCandidate(preference, candidate);
  const priority = preferencePriority(preference);

  if (match === true) {
    return {
      feature: preference.feature,
      priority,
      relaxable: preference.relaxable ?? true,
      status: 'satisfied',
      severity: 'none',
    };
  }

  if (match === null) {
    return {
      feature: preference.feature,
      priority,
      relaxable: preference.relaxable ?? true,
      status: 'missing_fact',
      severity: 'unknown',
      reason: 'Candidate facts are insufficient to judge this soft preference.',
    };
  }

  return {
    feature: preference.feature,
    priority,
    relaxable: preference.relaxable ?? true,
    status: 'violation',
    severity: preference.feature === 'travel_time'
      ? transportViolationSeverity(preference, candidate)
      : 'severe',
    reason: 'Top ranked candidate does not satisfy this soft preference.',
  };
}

function relaxedFeaturesFromActions(actionsTaken = []) {
  const relaxed = new Set();
  for (const action of actionsTaken) {
    if (action.selectedAction === 'INCLUDE_NONPREFERRED_COURTS') relaxed.add('court');
  }
  return relaxed;
}

function relaxedPreferenceJudgement(preference) {
  return {
    feature: preference.feature,
    priority: preferencePriority(preference),
    relaxable: preference.relaxable ?? true,
    status: 'relaxed_by_replanning',
    severity: 'none',
    reason: 'This soft preference was explicitly relaxed by a prior replanning action in the current run.',
  };
}

function evaluateCandidateSet({
  candidates = [],
  rejectedCandidates = [],
  preferences = {},
  rankerResult = {},
  factualCandidateFeatures = [],
  failedConstraints = [],
  factualObservations = {},
  actionsTaken = [],
  minCandidates = 1,
} = {}) {
  const hardFailures = failedHardConstraintsFromRejected(rejectedCandidates, failedConstraints);
  const softPreferences = preferences.preferences ?? [];
  const relaxedFeatures = relaxedFeaturesFromActions(actionsTaken);
  const weakPreferences = [];
  const topCandidate = topRankedCandidate(candidates, rankerResult);
  const topCandidateSoftJudgements = topCandidate
    ? softPreferences.map((preference) => (
      relaxedFeatures.has(preference.feature)
        ? relaxedPreferenceJudgement(preference)
        : softPreferenceJudgement(preference, topCandidate)
    ))
    : [];
  const softViolations = topCandidateSoftJudgements.filter((judgement) => judgement.status === 'violation');
  const missingFacts = topCandidateSoftJudgements.filter((judgement) => judgement.status === 'missing_fact');
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
    if (relaxedFeatures.has(preference.feature)) continue;

    const matches = candidates
      .map((candidate) => preferenceMatchesCandidate(preference, candidate))
      .filter((match) => match !== null);

    const priority = preferencePriority(preference);
    const matchedByAnyCandidate = matches.some(Boolean);

    if (priority !== 'low' && matches.length > 0 && !matchedByAnyCandidate) {
      const topJudgement = topCandidateSoftJudgements.find((judgement) => judgement.feature === preference.feature);
      weakPreferences.push({
        feature: preference.feature,
        priority,
        relaxable: preference.relaxable ?? true,
        severity: topJudgement?.severity ?? 'severe',
        reason: 'No current candidate satisfies this soft preference.',
      });
    }

    if (priority === 'high' && matches.length === 0) {
      weakPreferences.push({
        feature: preference.feature,
        priority,
        relaxable: preference.relaxable ?? true,
        severity: 'unknown',
        reason: 'Candidate facts are insufficient to judge this high-priority preference.',
      });
    }
  }

  const reasons = [];
  const severeHighViolations = softViolations
    .filter((judgement) => judgement.priority === 'high' && judgement.severity === 'severe');
  const highViolations = softViolations.filter((judgement) => judgement.priority === 'high');
  const noCandidateSatisfiesProblemHigh = weakPreferences
    .some((preference) => preference.priority === 'high' && ['severe', 'unknown'].includes(preference.severity));

  if (candidates.length < minCandidates) reasons.push('candidate_count_below_minimum');
  if (hardFailures.length > 0) reasons.push('hard_constraints_failed');
  if (observationIssues.length > 0) reasons.push('factual_observations_insufficient');
  if (severeHighViolations.length >= 2 || highViolations.length >= 2) {
    reasons.push('top_candidate_multiple_high_priority_soft_violations');
  }
  if (noCandidateSatisfiesProblemHigh) {
    reasons.push('high_priority_preferences_weak');
  }

  const status = candidates.length === 0
    ? EVALUATOR_STATUS.NO_FEASIBLE_CANDIDATES
    : reasons.length === 0
      ? EVALUATOR_STATUS.SATISFACTORY
      : EVALUATOR_STATUS.NEEDS_REPLANNING;

  return {
    status,
    satisfactory: status === EVALUATOR_STATUS.SATISFACTORY,
    reasons,
    failedConstraints: hardFailures,
    weakPreferences,
    topCandidateId: topCandidate?.id ?? null,
    topCandidateSoftJudgements,
    softViolations,
    missingFacts,
    observationIssues,
    factualCandidateFeatureCount: Array.isArray(factualCandidateFeatures) ? factualCandidateFeatures.length : 0,
  };
}

export {
  EVALUATOR_STATUS,
  evaluateCandidateSet,
  preferenceMatchesCandidate,
};
