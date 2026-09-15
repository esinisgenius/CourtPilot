const confidenceOrder = Object.freeze({
  high: 3,
  medium: 2,
  low: 1,
});

const periodWindows = Object.freeze({
  morning: { start: '08:00', end: '12:00' },
  midday: { start: '11:00', end: '14:00' },
  afternoon: { start: '12:00', end: '18:00' },
  evening: { start: '17:00', end: '20:00' },
  night: { start: '18:00', end: '22:00' },
  not_too_early: { start: '09:00', end: '22:00' },
  not_too_late: { start: '06:00', end: '20:00' },
});

const coldStartWindows = Object.freeze([
  { start: '10:00', end: '12:00', priority: 1 },
  { start: '17:00', end: '20:00', priority: 2 },
  { start: '08:00', end: '10:00', priority: 3 },
]);

const bucketWindows = Object.freeze({
  morning: { start: '08:00', end: '12:00' },
  daytime: { start: '12:00', end: '17:00' },
  evening: { start: '17:00', end: '20:00' },
});

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function timeToMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(minutes) {
  const bounded = Math.max(0, Math.min(24 * 60, minutes));
  const hours = Math.floor(bounded / 60);
  const mins = bounded % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function normalizeWindow(window, priority = 1) {
  const start = timeToMinutes(window?.start);
  const end = timeToMinutes(window?.end);
  if (start === null || end === null || end <= start) return null;
  return {
    start: minutesToTime(start),
    end: minutesToTime(end),
    priority,
  };
}

function canonicalTemporalWindow(profile = {}) {
  return profile.searchScope?.temporalWindow ?? {};
}

function parsedTimeWindow(profile = {}) {
  return profile.searchScope?.timeWindow ?? {};
}

function temporalSpanMinutes(window = {}) {
  const start = timeToMinutes(window.timeStart);
  const end = timeToMinutes(window.timeEnd);
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

function ruleHasSpecificPoint(rule = {}) {
  return Boolean(rule.equals || rule.exact || rule.around || rule.start || rule.end);
}

function profileHasSpecificTimeMetadata(profile = {}) {
  const window = parsedTimeWindow(profile);
  if (ruleHasSpecificPoint(window)) return true;
  return [
    ...(profile.hardConstraints ?? []),
    ...(profile.preferences ?? []),
    ...(profile.objectives ?? []),
  ].some((item) => item.feature === 'start_time' && ruleHasSpecificPoint(item.rule ?? item));
}

function classifyTemporalSpecificity(profile = {}) {
  const temporal = canonicalTemporalWindow(profile);
  const span = temporalSpanMinutes(temporal);
  if (span !== null && span <= 180) {
    return {
      modeCandidate: 'explicit',
      reason: `canonical_time_window_${span}_minutes`,
    };
  }

  if (profileHasSpecificTimeMetadata(profile)) {
    return {
      modeCandidate: 'explicit',
      reason: 'specific_time_metadata',
    };
  }

  return {
    modeCandidate: 'broad',
    reason: temporal.timeStart || temporal.timeEnd ? 'open_or_wide_time_window' : 'no_specific_time_window',
  };
}

function allowedBounds(profile = {}) {
  const temporal = canonicalTemporalWindow(profile);
  return {
    start: timeToMinutes(temporal.timeStart) ?? 0,
    end: timeToMinutes(temporal.timeEnd) ?? 24 * 60,
  };
}

function clipWindowToAllowed(window, profile) {
  const normalized = normalizeWindow(window, window.priority);
  if (!normalized) return null;
  const bounds = allowedBounds(profile);
  const start = Math.max(timeToMinutes(normalized.start), bounds.start);
  const end = Math.min(timeToMinutes(normalized.end), bounds.end);
  if (end <= start) return null;
  return {
    ...normalized,
    start: minutesToTime(start),
    end: minutesToTime(end),
  };
}

function dedupeWindows(windows) {
  const seen = new Set();
  const deduped = [];
  for (const window of windows) {
    const key = `${window.start}-${window.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...window, priority: deduped.length + 1 });
    if (deduped.length >= 3) break;
  }
  return deduped;
}

function explicitWindowsFromProfile(profile = {}) {
  const temporal = canonicalTemporalWindow(profile);
  const direct = normalizeWindow({ start: temporal.timeStart, end: temporal.timeEnd }, 1);
  if (direct) return [direct];

  const window = parsedTimeWindow(profile);
  const point = window.equals ?? window.exact ?? window.around ?? window.start;
  const minutes = timeToMinutes(point);
  if (minutes === null) return [];
  return [normalizeWindow({ start: minutesToTime(minutes), end: minutesToTime(minutes + 60) }, 1)].filter(Boolean);
}

function windowsFromRule(rule = {}) {
  if (!isPlainObject(rule)) return [];
  if (rule.period && periodWindows[rule.period]) return [periodWindows[rule.period]];
  if (rule.equals || rule.exact || rule.around || rule.start) {
    const minutes = timeToMinutes(rule.equals ?? rule.exact ?? rule.around ?? rule.start);
    return minutes === null ? [] : [{ start: minutesToTime(minutes), end: minutesToTime(minutes + 60) }];
  }
  if (rule.after && rule.before) {
    return [
      { start: '00:00', end: rule.before },
      { start: rule.after, end: '23:59' },
    ];
  }
  if (Array.isArray(rule.preferredWindows)) return rule.preferredWindows;
  return [];
}

function temporalEvidenceFromPreferenceProfile(profile = {}, { kind = 'user_profile', idPrefix = 'userProfile' } = {}) {
  const evidence = [];
  const items = [
    ...(profile.preferences ?? []),
    ...(profile.objectives ?? []),
  ].filter((item) => item.feature === 'start_time');

  for (const item of items) {
    const windows = windowsFromRule(item.rule ?? {});
    if (windows.length === 0) continue;
    evidence.push({
      kind,
      id: `${idPrefix}_${item.rule?.period ?? item.direction ?? 'time'}_preference`,
      priority: item.priority ?? item.importance ?? 'medium',
      updatedAt: item.updatedAt ?? profile.updatedAt ?? null,
      windows,
    });
  }

  return evidence;
}

function temporalEvidenceFromUserProfile(userProfile = {}) {
  if (!isPlainObject(userProfile)) return [];
  const evidence = [];
  const preferredWindows = Array.isArray(userProfile.preferredTimeWindows)
    ? userProfile.preferredTimeWindows
    : [];
  const normalizedWindows = preferredWindows.flatMap((window) => {
    if (window?.start && window?.end) return [{ start: window.start, end: window.end }];
    return windowsFromRule(window);
  });
  if (normalizedWindows.length > 0) {
    evidence.push({
      kind: 'user_profile',
      id: 'userProfile_preferred_time_windows',
      priority: 'high',
      windows: normalizedWindows,
    });
  }
  evidence.push(...temporalEvidenceFromPreferenceProfile(userProfile));
  return evidence;
}

function bucketEvidence(recentBehavior = {}) {
  const bucket = recentBehavior.dominantTimeBucket;
  const window = bucketWindows[bucket];
  const count = recentBehavior.timeBuckets?.[bucket] ?? 0;
  if (!window || count <= 0) return [];
  return [{
    kind: 'recent_behavior',
    id: `booking_behavior_${bucket}`,
    priority: count >= 3 ? 'high' : 'medium',
    strength: count + (recentBehavior.bookingClickCount ?? 0),
    windows: [window],
  }];
}

function temporalEvidenceFromBehavior(recentBehavior = {}) {
  const summaryEvidence = bucketEvidence(recentBehavior);
  if (summaryEvidence.length > 0) return summaryEvidence;

  const rows = [
    ...(recentBehavior.selectedRecommendations ?? []),
    ...(recentBehavior.bookingClicks ?? []),
    ...(recentBehavior.acceptedChoices ?? []),
    ...(recentBehavior.recentSelections ?? []),
    ...(recentBehavior.recentBookingClicks ?? []),
  ];
  const counts = new Map();
  for (const row of rows) {
    const localTime = row.localTime ?? String(row.startTime ?? '').slice(11, 16);
    const minutes = timeToMinutes(localTime);
    if (minutes === null) continue;
    const bucketStart = Math.floor(minutes / 180) * 180;
    const key = `${minutesToTime(bucketStart)}-${minutesToTime(bucketStart + 180)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => {
      const [start, end] = key.split('-');
      return {
        kind: 'recent_behavior',
        id: `booking_behavior_${start}_${end}`,
        priority: count >= 3 ? 'high' : 'medium',
        strength: count,
        windows: [{ start, end }],
      };
    });
}

function meaningfulTemporalEvidence({ userProfile = {}, recentBehavior = {}, profile = null } = {}) {
  return [
    ...temporalEvidenceFromUserProfile(userProfile ?? profile ?? {}),
    ...temporalEvidenceFromBehavior(recentBehavior),
  ];
}

function priorityRank(value) {
  return { hard: 4, high: 3, medium: 2, low: 1, uncertain: 0 }[value ?? 'medium'] ?? 2;
}

function evidenceKindRank(kind) {
  if (kind === 'recent_behavior') return 3;
  if (kind === 'user_profile') return 2;
  return 1;
}

function inferPersonalizedTemporalPolicy({
  userProfile = {},
  recentBehavior = {},
  allowedTemporalWindow = {},
  profile = null,
} = {}) {
  const evidence = meaningfulTemporalEvidence({ userProfile: userProfile ?? profile ?? {}, recentBehavior });
  if (evidence.length === 0) return null;

  const windows = evidence
    .sort((a, b) => {
      const priority = priorityRank(b.priority) - priorityRank(a.priority);
      if (priority !== 0) return priority;
      const kind = evidenceKindRank(b.kind) - evidenceKindRank(a.kind);
      if (kind !== 0) return kind;
      return (b.strength ?? 1) - (a.strength ?? 1);
    })
    .flatMap((item) => item.windows.map((window) => ({ ...window, evidenceId: item.id })))
    .map((window, index) => clipWindowToAllowed({ ...window, priority: index + 1 }, { searchScope: { temporalWindow: allowedTemporalWindow } }))
    .filter(Boolean);
  const preferredWindows = dedupeWindows(windows);
  if (preferredWindows.length === 0) return null;

  const hasBehavior = evidence.some((item) => item.kind === 'recent_behavior');
  const strongest = Math.max(...evidence.map((item) => priorityRank(item.priority)));
  const confidence = hasBehavior && strongest >= 3 ? 'high' : strongest >= 2 ? 'medium' : 'low';

  return {
    mode: 'personalized',
    preferredWindows,
    confidence,
    evidenceUsed: evidence.map((item) => item.id).slice(0, 6),
  };
}

function coldStartTemporalPolicy(profile = {}, { reason = 'cold_start_default' } = {}) {
  let preferredWindows = coldStartWindows
    .map((window) => clipWindowToAllowed(window, profile))
    .filter(Boolean);

  if (preferredWindows.length === 0) {
    const bounds = allowedBounds(profile);
    const fallback = normalizeWindow({
      start: minutesToTime(bounds.start),
      end: minutesToTime(bounds.end),
      priority: 1,
    });
    preferredWindows = fallback ? [fallback] : [];
  }

  return {
    mode: 'cold_start',
    preferredWindows: dedupeWindows(preferredWindows),
    confidence: 'medium',
    evidenceUsed: [reason],
  };
}

function validateTemporalPolicy(policy) {
  if (!isPlainObject(policy)) throw new Error('Temporal policy must be an object');
  if (!['explicit', 'personalized', 'cold_start'].includes(policy.mode)) {
    throw new Error('Temporal policy mode is invalid');
  }
  if (!['high', 'medium', 'low'].includes(policy.confidence)) {
    throw new Error('Temporal policy confidence is invalid');
  }
  if (!Array.isArray(policy.preferredWindows) || policy.preferredWindows.length > 3) {
    throw new Error('Temporal policy preferredWindows must contain at most 3 windows');
  }
  const preferredWindows = policy.preferredWindows.map((window, index) => {
    const normalized = normalizeWindow(window, Number.isInteger(window.priority) ? window.priority : index + 1);
    if (!normalized) throw new Error('Temporal policy window is invalid');
    return normalized;
  });
  const evidenceUsed = Array.isArray(policy.evidenceUsed)
    ? policy.evidenceUsed.filter((item) => typeof item === 'string')
    : [];
  return {
    mode: policy.mode,
    preferredWindows,
    confidence: policy.confidence,
    evidenceUsed,
  };
}

async function callTemporalPolicyAgent(provider, payload) {
  if (!provider) return inferPersonalizedTemporalPolicy(payload);
  if (typeof provider === 'function') return provider(payload);
  if (typeof provider.inferTemporalPolicy === 'function') return provider.inferTemporalPolicy(payload);
  throw new Error('Temporal policy provider must be a function or expose inferTemporalPolicy(payload)');
}

async function buildPreferredTemporalPolicy({
  requestPreferences = null,
  userProfile = null,
  recentBehavior = {},
  provider = null,
  profile = null,
} = {}) {
  const resolvedRequestPreferences = requestPreferences ?? profile ?? {};
  const resolvedUserProfile = userProfile ?? {};
  const specificity = classifyTemporalSpecificity(resolvedRequestPreferences);
  if (specificity.modeCandidate === 'explicit') {
    return validateTemporalPolicy({
      mode: 'explicit',
      preferredWindows: explicitWindowsFromProfile(resolvedRequestPreferences),
      confidence: 'high',
      evidenceUsed: [`current_query_${specificity.reason}`],
    });
  }

  const evidence = meaningfulTemporalEvidence({ userProfile: resolvedUserProfile, recentBehavior });
  if (evidence.length > 0) {
    try {
      const rawPolicy = await callTemporalPolicyAgent(provider, {
        currentQuery: {
          temporalSpecificity: specificity,
          sourceText: resolvedRequestPreferences.sourceText ?? '',
        },
        requestPreferences: resolvedRequestPreferences,
        userProfile: resolvedUserProfile,
        recentBehavior,
        allowedTemporalWindow: canonicalTemporalWindow(resolvedRequestPreferences),
      });
      const policy = validateTemporalPolicy(rawPolicy);
      if (policy.mode === 'personalized' && confidenceOrder[policy.confidence] >= confidenceOrder.medium) {
        return policy;
      }
    } catch {
      // Fall through to deterministic cold-start policy.
    }
  }

  return coldStartTemporalPolicy(resolvedRequestPreferences, {
    reason: evidence.length > 0 ? 'personalization_fallback' : 'insufficient_personalization_evidence',
  });
}

export {
  buildPreferredTemporalPolicy,
  classifyTemporalSpecificity,
  coldStartTemporalPolicy,
  inferPersonalizedTemporalPolicy,
  meaningfulTemporalEvidence,
  validateTemporalPolicy,
};
