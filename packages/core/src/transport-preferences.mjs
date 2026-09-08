const TRANSPORT_MODES = Object.freeze({
  TRANSIT: 'TRANSIT',
  WALK: 'WALK',
  DRIVE: 'DRIVE',
});

const transportModeKeys = Object.freeze({
  TRANSIT: 'transit',
  WALK: 'walk',
  DRIVE: 'drive',
});

function normalizeTransportMode(mode) {
  const normalized = String(mode ?? '').toUpperCase();
  if (!Object.values(TRANSPORT_MODES).includes(normalized)) return null;
  return normalized;
}

function normalizeTransportModes(modes = []) {
  if (!Array.isArray(modes)) return [];
  return [...new Set(modes.map(normalizeTransportMode).filter(Boolean))];
}

function transportPreferenceFromProfile(profile = {}) {
  return profile.transportPreference ?? {};
}

function transportRuleFromPreference(preference = {}) {
  return preference.rule ?? {};
}

function transportPreferenceForEvaluation(profileOrPreference = {}) {
  if (profileOrPreference.feature === 'travel_time') {
    return transportRuleFromPreference(profileOrPreference);
  }
  return transportPreferenceFromProfile(profileOrPreference);
}

function accessibilityFacts(candidate = {}) {
  return candidate.accessibility ?? candidate.features?.accessibility ?? null;
}

function modeAccessibility(candidate, mode) {
  const modeKey = transportModeKeys[normalizeTransportMode(mode)];
  if (!modeKey) return null;
  return accessibilityFacts(candidate)?.[modeKey] ?? null;
}

function routeFactStatus(candidate, mode) {
  const fact = modeAccessibility(candidate, mode);
  if (!fact) {
    return {
      status: 'unknown',
      reason: 'accessibility_missing',
      durationMinutes: null,
    };
  }

  if (Number.isFinite(fact.durationMinutes)) {
    return {
      status: 'known',
      reason: null,
      durationMinutes: fact.durationMinutes,
    };
  }

  return {
    status: 'unavailable',
    reason: fact.unavailableReason ?? 'route_unavailable',
    durationMinutes: null,
  };
}

function thresholdChecks(transportPreference = {}) {
  const checks = [];
  if (Number.isFinite(transportPreference.maxTransitMinutes)) {
    checks.push({ mode: TRANSPORT_MODES.TRANSIT, maxMinutes: transportPreference.maxTransitMinutes });
  }
  if (Number.isFinite(transportPreference.maxWalkMinutes)) {
    checks.push({ mode: TRANSPORT_MODES.WALK, maxMinutes: transportPreference.maxWalkMinutes });
  }
  return checks;
}

function evaluateTransportThresholds(candidate, transportPreference = {}) {
  return thresholdChecks(transportPreference).map((check) => {
    const fact = routeFactStatus(candidate, check.mode);
    if (fact.status !== 'known') {
      return {
        ...check,
        accepted: null,
        reason: fact.reason,
        factStatus: fact.status,
        durationMinutes: null,
      };
    }
    return {
      ...check,
      accepted: fact.durationMinutes <= check.maxMinutes,
      reason: fact.durationMinutes <= check.maxMinutes ? null : 'transport_time_exceeds_limit',
      factStatus: 'known',
      durationMinutes: fact.durationMinutes,
    };
  });
}

function candidateMatchesTransportPreference(candidate, transportPreference = {}) {
  const checks = evaluateTransportThresholds(candidate, transportPreference);
  if (checks.some((check) => check.accepted === false)) return false;
  if (checks.some((check) => check.accepted === null)) return null;
  return checks.length > 0 ? true : null;
}

function candidatePreferredTransportModes(candidate, transportPreference = {}) {
  const preferredModes = normalizeTransportModes(transportPreference.preferredTransportModes);
  if (preferredModes.length === 0) return null;
  const availablePreferredModes = preferredModes.filter((mode) => routeFactStatus(candidate, mode).status === 'known');
  return {
    preferredModes,
    availablePreferredModes,
    matches: availablePreferredModes.length > 0,
  };
}

function transportPreferenceMatchDetail(candidate, transportPreference = {}) {
  return {
    thresholds: evaluateTransportThresholds(candidate, transportPreference),
    preferredModes: candidatePreferredTransportModes(candidate, transportPreference),
  };
}

export {
  TRANSPORT_MODES,
  accessibilityFacts,
  candidateMatchesTransportPreference,
  candidatePreferredTransportModes,
  evaluateTransportThresholds,
  modeAccessibility,
  normalizeTransportMode,
  normalizeTransportModes,
  routeFactStatus,
  thresholdChecks,
  transportPreferenceForEvaluation,
  transportPreferenceFromProfile,
  transportPreferenceMatchDetail,
};
