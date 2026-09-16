import { matchesStartTimeRule, normalizeTransportModes } from '../../core/src/index.mjs';
import { buildRankerInput } from './schema.mjs';

const priorityOrder = Object.freeze({
  hard: 4,
  high: 3,
  medium: 2,
  low: 1,
  uncertain: 0,
});

function priorityValue(signal) {
  return priorityOrder[signal.priority ?? signal.importance ?? 'uncertain'] ?? 0;
}

function knownNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function compareNullableNumbers(a, b, direction = 'lower') {
  const aKnown = knownNumber(a);
  const bKnown = knownNumber(b);
  if (aKnown === null && bKnown === null) return 0;
  if (aKnown === null) return 1;
  if (bKnown === null) return -1;
  if (aKnown === bKnown) return 0;
  if (direction === 'higher') return aKnown > bKnown ? -1 : 1;
  return aKnown < bKnown ? -1 : 1;
}

function softPreferenceSignals(preferenceProfile = {}) {
  const signals = [];

  for (const preference of preferenceProfile.preferences ?? []) {
    if (preference.type === 'hard') continue;
    signals.push({
      feature: preference.feature,
      priority: preference.priority ?? preference.importance ?? 'uncertain',
      direction: preference.direction,
      target: preference.target,
      rule: preference.rule ?? {},
      relaxable: preference.relaxable ?? true,
    });
  }

  for (const objective of preferenceProfile.objectives ?? []) {
    signals.push({
      feature: objective.feature,
      priority: objective.priority ?? 'medium',
      direction: objective.direction,
      rule: objective.rule ?? {},
      relaxable: true,
    });
  }

  const transportPreference = preferenceProfile.transportPreference ?? {};
  if (
    Number.isFinite(transportPreference.maxTransitMinutes)
    || Number.isFinite(transportPreference.maxWalkMinutes)
    || Array.isArray(transportPreference.preferredTransportModes)
  ) {
    const alreadyRepresented = signals.some((signal) => signal.feature === 'travel_time');
    if (!alreadyRepresented) {
      signals.push({
        feature: 'travel_time',
        priority: 'medium',
        rule: transportPreference,
        relaxable: true,
      });
    }
  }

  if (preferenceProfile.searchScope?.locationSource === 'explicit') {
    signals.push({
      feature: 'distance',
      priority: 'low',
      direction: 'lower',
      rule: {},
      relaxable: true,
    });
  }

  if (preferenceProfile.preferredTemporalPolicy?.preferredWindows?.length > 0) {
    signals.push({
      feature: 'preferred_temporal_policy',
      priority: preferenceProfile.preferredTemporalPolicy.mode === 'explicit' ? 'high' : 'low',
      direction: 'lower',
      rule: preferenceProfile.preferredTemporalPolicy,
      relaxable: true,
    });
  } else if (!hasExplicitTimeSignal(preferenceProfile)) {
    signals.push({
      feature: 'default_time_utility',
      priority: 'low',
      direction: 'higher',
      rule: {},
      relaxable: true,
    });
  }

  return signals
    .map((signal, index) => ({ ...signal, index }))
    .filter((signal) => priorityValue(signal) > 0);
}

function hasExplicitTimeSignal(preferenceProfile = {}) {
  const scope = preferenceProfile.searchScope ?? {};
  const temporal = scope.temporalWindow ?? {};
  const window = scope.timeWindow ?? {};
  if (temporal.timeStart || temporal.timeEnd) return true;
  if (window.after || window.before || window.start || window.end || window.exact || window.around) return true;
  return [
    ...(preferenceProfile.hardConstraints ?? []),
    ...(preferenceProfile.preferences ?? []),
  ].some((preference) => preference.feature === 'start_time');
}

function transportRule(signal, preferenceProfile) {
  return {
    ...(preferenceProfile.transportPreference ?? {}),
    ...(signal.rule ?? {}),
  };
}

function compareThresholdDuration(aDuration, bDuration, maxMinutes) {
  const aKnown = knownNumber(aDuration);
  const bKnown = knownNumber(bDuration);
  if (!Number.isFinite(maxMinutes)) return compareNullableNumbers(aKnown, bKnown, 'lower');
  const aOk = aKnown !== null ? aKnown <= maxMinutes : null;
  const bOk = bKnown !== null ? bKnown <= maxMinutes : null;
  if (aOk === true && bOk !== true) return -1;
  if (bOk === true && aOk !== true) return 1;
  return compareNullableNumbers(aKnown, bKnown, 'lower');
}

function compareTravelTime(a, b, signal, preferenceProfile) {
  const rule = transportRule(signal, preferenceProfile);
  const modeComparisons = [];

  if (Number.isFinite(rule.maxTransitMinutes)) {
    modeComparisons.push(compareThresholdDuration(
      a.accessibility.TRANSIT.durationMinutes,
      b.accessibility.TRANSIT.durationMinutes,
      rule.maxTransitMinutes,
    ));
  }

  if (Number.isFinite(rule.maxWalkMinutes)) {
    modeComparisons.push(compareThresholdDuration(
      a.accessibility.WALK.durationMinutes,
      b.accessibility.WALK.durationMinutes,
      rule.maxWalkMinutes,
    ));
  }

  const preferredModes = normalizeTransportModes(rule.preferredTransportModes);
  for (const mode of preferredModes) {
    modeComparisons.push(compareNullableNumbers(
      a.accessibility[mode].durationMinutes,
      b.accessibility[mode].durationMinutes,
      'lower',
    ));
  }

  const decisive = modeComparisons.find((comparison) => comparison !== 0);
  return decisive ?? 0;
}

function compareConsecutiveAvailability(a, b, signal) {
  const preferredMinutes = signal.rule?.preferredMinutes ?? signal.rule?.minMinutes ?? 120;
  const aMeets = Number.isFinite(a.continuousDurationMinutes)
    ? a.continuousDurationMinutes >= preferredMinutes
    : null;
  const bMeets = Number.isFinite(b.continuousDurationMinutes)
    ? b.continuousDurationMinutes >= preferredMinutes
    : null;
  if (aMeets === true && bMeets !== true) return -1;
  if (bMeets === true && aMeets !== true) return 1;
  return compareNullableNumbers(a.continuousDurationMinutes, b.continuousDurationMinutes, 'higher');
}

function minutesFromLocalTime(localTime) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(localTime ?? ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  return hours * 60 + minutes;
}

function defaultTimePenalty(snapshot) {
  const minutes = minutesFromLocalTime(snapshot.slot.localTime);
  if (minutes === null) return 4;
  if (minutes < 8 * 60) return 3;
  if (minutes < 10 * 60) return 1;
  if (minutes <= 20 * 60) return 0;
  if (minutes <= 22 * 60) return 1;
  return 2;
}

function temporalPolicyPenalty(snapshot, policy = {}) {
  const minutes = minutesFromLocalTime(snapshot.slot.localTime);
  if (minutes === null) return 10000;
  const windows = Array.isArray(policy.preferredWindows) ? policy.preferredWindows : [];
  if (windows.length === 0) return defaultTimePenalty(snapshot);

  let best = 10000;
  for (const window of windows) {
    const start = minutesFromLocalTime(window.start);
    const end = minutesFromLocalTime(window.end);
    if (start === null || end === null || end <= start) continue;
    const priority = Number.isInteger(window.priority) ? window.priority : 3;
    const distance = minutes < start ? start - minutes : minutes >= end ? minutes - end + 1 : 0;
    best = Math.min(best, priority * 100 + distance);
  }
  return best;
}

function compareSignal(a, b, signal, preferenceProfile) {
  if (signal.feature === 'price') {
    const direction = signal.direction === 'higher' || signal.direction === 'maximize' ? 'higher' : 'lower';
    return compareNullableNumbers(a.price.amount, b.price.amount, direction);
  }

  if (signal.feature === 'distance') {
    return compareNullableNumbers(a.venue.distanceKm, b.venue.distanceKm, 'lower');
  }

  if (signal.feature === 'default_time_utility') {
    return compareNullableNumbers(defaultTimePenalty(a), defaultTimePenalty(b), 'lower');
  }

  if (signal.feature === 'preferred_temporal_policy') {
    return compareNullableNumbers(
      temporalPolicyPenalty(a, signal.rule),
      temporalPolicyPenalty(b, signal.rule),
      'lower',
    );
  }

  if (signal.feature === 'travel_time') {
    return compareTravelTime(a, b, signal, preferenceProfile);
  }

  if (signal.feature === 'consecutive_availability' || signal.feature === 'duration') {
    return compareConsecutiveAvailability(a, b, signal);
  }

  if (signal.feature === 'next_hour_free') {
    if (a.availability.nextHourAlsoAvailable === true && b.availability.nextHourAlsoAvailable !== true) return -1;
    if (b.availability.nextHourAlsoAvailable === true && a.availability.nextHourAlsoAvailable !== true) return 1;
    return 0;
  }

  if (signal.feature === 'court') {
    if (a.court.preferenceMatch === true && b.court.preferenceMatch !== true) return -1;
    if (b.court.preferenceMatch === true && a.court.preferenceMatch !== true) return 1;
    return 0;
  }

  if (signal.feature === 'venue') {
    if (a.venue.preferenceMatch === true && b.venue.preferenceMatch !== true) return -1;
    if (b.venue.preferenceMatch === true && a.venue.preferenceMatch !== true) return 1;
    return 0;
  }

  if (signal.feature === 'start_time' && signal.rule) {
    const aMatches = a.slot.localTime ? matchesStartTimeRule(a.slot.localTime, signal.rule) === true : null;
    const bMatches = b.slot.localTime ? matchesStartTimeRule(b.slot.localTime, signal.rule) === true : null;
    if (aMatches === true && bMatches !== true) return -1;
    if (bMatches === true && aMatches !== true) return 1;
  }

  if (signal.feature === 'weather') {
    return compareNullableNumbers(a.weather?.precipitationProbability, b.weather?.precipitationProbability, 'lower');
  }

  return 0;
}

function compareCandidates(a, b, signals, preferenceProfile) {
  const priorities = [...new Set(signals.map(priorityValue))].sort((left, right) => right - left);
  for (const priority of priorities) {
    let aWins = 0;
    let bWins = 0;
    for (const signal of signals.filter((item) => priorityValue(item) === priority)) {
      const comparison = compareSignal(a, b, signal, preferenceProfile);
      if (comparison < 0) aWins += 1;
      if (comparison > 0) bWins += 1;
    }
    if (aWins !== bWins) return bWins - aWins;
  }

  return [
    a.slot.startTime ?? '',
    a.venue.name ?? '',
    a.court.name ?? '',
    a.candidateId,
  ].join('|').localeCompare([
    b.slot.startTime ?? '',
    b.venue.name ?? '',
    b.court.name ?? '',
    b.candidateId,
  ].join('|'));
}

function formatMoney(snapshot) {
  return Number.isFinite(snapshot.price.amount) ? `$${snapshot.price.amount}` : null;
}

function reasonForPrice(snapshot) {
  const money = formatMoney(snapshot);
  return money ? `Price fact is ${money}.` : 'Price fact is unknown.';
}

function reasonForTransport(snapshot, preferenceProfile) {
  const maxTransitMinutes = preferenceProfile.transportPreference?.maxTransitMinutes;
  const transitMinutes = snapshot.accessibility.TRANSIT.durationMinutes;
  if (Number.isFinite(transitMinutes) && Number.isFinite(maxTransitMinutes)) {
    return `Transit fact is ${transitMinutes} minutes against the preferred ${maxTransitMinutes} minutes.`;
  }
  if (Number.isFinite(transitMinutes)) return `Transit fact is ${transitMinutes} minutes.`;
  const reason = snapshot.accessibility.TRANSIT.unavailableReason ?? snapshot.accessibility.TRANSIT.status;
  return `Transit fact is unavailable: ${reason}.`;
}

function reasonForContinuous(snapshot) {
  if (Number.isFinite(snapshot.continuousDurationMinutes)) {
    return `Continuous availability fact is ${snapshot.continuousDurationMinutes} minutes.`;
  }
  return 'Continuous availability fact is unknown.';
}

function tradeoffsForSnapshot(snapshot, signals, preferenceProfile) {
  const tradeoffs = [];
  const hasPrice = signals.some((signal) => signal.feature === 'price');
  const hasTravel = signals.some((signal) => signal.feature === 'travel_time');
  const hasContinuous = signals.some((signal) => ['consecutive_availability', 'duration', 'next_hour_free'].includes(signal.feature));

  if (hasPrice && hasTravel) {
    const transitMinutes = snapshot.accessibility.TRANSIT.durationMinutes;
    const maxTransitMinutes = preferenceProfile.transportPreference?.maxTransitMinutes;
    if (Number.isFinite(transitMinutes) && Number.isFinite(maxTransitMinutes) && transitMinutes > maxTransitMinutes) {
      tradeoffs.push(`Keeps the lower-price option in consideration, but transit is ${transitMinutes} minutes over the preferred ${maxTransitMinutes} minutes.`);
    } else if (Number.isFinite(transitMinutes) && Number.isFinite(maxTransitMinutes)) {
      tradeoffs.push(`Meets the preferred transit limit, with price considered as a separate soft preference.`);
    }
  }

  if (hasContinuous && snapshot.continuousDurationMinutes < 120) {
    tradeoffs.push(`Has only ${snapshot.continuousDurationMinutes} minutes of continuous availability.`);
  }

  if (tradeoffs.length === 0) {
    tradeoffs.push('No major soft-preference tradeoff was needed from the available facts.');
  }

  return tradeoffs;
}

function reasonsForSnapshot(snapshot, signals, preferenceProfile) {
  const reasons = [];
  if (signals.some((signal) => signal.feature === 'price')) reasons.push(reasonForPrice(snapshot));
  if (signals.some((signal) => signal.feature === 'travel_time')) reasons.push(reasonForTransport(snapshot, preferenceProfile));
  if (signals.some((signal) => ['consecutive_availability', 'duration', 'next_hour_free'].includes(signal.feature))) {
    reasons.push(reasonForContinuous(snapshot));
  }
  if (signals.some((signal) => signal.feature === 'preferred_temporal_policy')) {
    reasons.push(`Time recommendation policy is ${preferenceProfile.preferredTemporalPolicy?.mode ?? 'unknown'}.`);
  }
  if (reasons.length === 0) reasons.push('Ranked by stable candidate order because no supported soft preference facts were available.');
  return reasons;
}

function fallbackRankCandidates({ preferenceProfile = {}, candidates = [] } = {}) {
  const input = buildRankerInput({ preferenceProfile, candidates });
  const signals = softPreferenceSignals(preferenceProfile);
  const ranked = [...input.candidates]
    .sort((a, b) => compareCandidates(a, b, signals, preferenceProfile))
    .map((snapshot, index) => ({
      candidateId: snapshot.candidateId,
      rank: index + 1,
      reasons: reasonsForSnapshot(snapshot, signals, preferenceProfile),
      tradeoffs: tradeoffsForSnapshot(snapshot, signals, preferenceProfile),
    }));

  return { rankedCandidates: ranked };
}

export {
  fallbackRankCandidates,
  softPreferenceSignals,
};
