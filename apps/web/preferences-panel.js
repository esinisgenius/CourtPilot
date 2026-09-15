const sampleText = '这几天我想打球，这周六我有事，周日晚上八点后能打，不要太热，$25左右';

const requestForm = document.querySelector('#court-request-form');
const requestInput = document.querySelector('#court-request');
const findButton = document.querySelector('#find-court');
const sampleButton = document.querySelector('#sample-request');
const statusLine = document.querySelector('#request-status');
const profileList = document.querySelector('#profile-list');
const results = document.querySelector('#results');
const filterList = document.querySelector('#filter-list');
const cards = document.querySelector('#cards');
const nearbyCards = document.querySelector('#nearby-cards');
const emptyState = document.querySelector('#empty-state');
const profileStorageKey = 'findmycourt.profile.v1';
const behaviorStorageKey = 'findmycourt.behavior.v1';
const behaviorStorageVersion = 1;
const maxBehaviorItems = 20;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeStorage() {
  try {
    const storage = window.localStorage;
    const probe = 'findmycourt.storage.probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function ruleToWindows(rule = {}) {
  if (rule.start && rule.end) return [{ start: rule.start, end: rule.end }];
  if (rule.before && rule.after) return [
    { start: '00:00', end: rule.before },
    { start: rule.after, end: '23:59' },
  ];
  if (rule.before) return [{ start: '00:00', end: rule.before }];
  if (rule.after) return [{ start: rule.after, end: '23:59' }];
  if (rule.period === 'morning') return [{ start: '08:00', end: '12:00' }];
  if (rule.period === 'afternoon') return [{ start: '12:00', end: '18:00' }];
  if (rule.period === 'evening') return [{ start: '17:00', end: '20:00' }];
  if (rule.period === 'night') return [{ start: '18:00', end: '22:00' }];
  return [];
}

function valuesFromRuleItems(profile, feature, key = 'include') {
  return [...new Set([...(profile?.preferences ?? []), ...(profile?.hardConstraints ?? [])]
    .filter((item) => item.feature === feature)
    .flatMap((item) => item.rule?.[key] ?? item.rule?.values ?? []))];
}

function loadUserProfile() {
  const storage = safeStorage();
  if (!storage) return null;
  const envelope = safeJsonParse(storage.getItem(profileStorageKey));
  if (envelope?.userProfile) return envelope.userProfile;
  const profile = envelope?.profile ?? null;
  if (!profile || typeof profile !== 'object') return null;
  const preferredTimeWindows = [...(profile.preferences ?? []), ...(profile.hardConstraints ?? [])]
    .filter((item) => item.feature === 'start_time' && item.rule)
    .flatMap((item) => ruleToWindows(item.rule));
  const duration = [...(profile.preferences ?? []), ...(profile.hardConstraints ?? [])]
    .find((item) => item.feature === 'duration' && item.rule)?.rule;
  const userProfile = {
    preferredDays: profile.preferredDays ?? [],
    preferredTimeWindows,
    typicalDurationMinutes: duration?.exactMinutes ?? duration?.preferredMinutes ?? duration?.minMinutes ?? null,
    maxTravelMinutes: profile.transportPreference?.maxTransitMinutes
      ?? profile.transportPreference?.maxWalkMinutes
      ?? null,
    preferredVenues: valuesFromRuleItems(profile, 'venue'),
  };
  return Object.values(userProfile).some((value) => Array.isArray(value) ? value.length > 0 : value !== null)
    ? userProfile
    : null;
}

function emptyBehaviorHistory() {
  return {
    recentSearches: [],
    recentSelections: [],
    recentBookingClicks: [],
  };
}

function boundedNewest(items = []) {
  return [...items]
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .sort((left, right) => Date.parse(right.timestamp ?? 0) - Date.parse(left.timestamp ?? 0))
    .slice(0, maxBehaviorItems);
}

function normalizeBehaviorHistory(behavior = {}) {
  return {
    recentSearches: boundedNewest(behavior.recentSearches),
    recentSelections: boundedNewest(behavior.recentSelections),
    recentBookingClicks: boundedNewest(behavior.recentBookingClicks),
  };
}

function loadBehaviorHistory() {
  const storage = safeStorage();
  if (!storage) return emptyBehaviorHistory();
  const envelope = safeJsonParse(storage.getItem(behaviorStorageKey));
  if (envelope?.storageVersion !== behaviorStorageVersion) return emptyBehaviorHistory();
  return normalizeBehaviorHistory(envelope.behavior);
}

function saveBehaviorHistory(behavior) {
  const storage = safeStorage();
  const normalized = normalizeBehaviorHistory(behavior);
  if (storage) {
    storage.setItem(behaviorStorageKey, JSON.stringify({
      storageVersion: behaviorStorageVersion,
      behavior: normalized,
    }));
  }
  return normalized;
}

function appendBehavior(listName, item) {
  const current = loadBehaviorHistory();
  return saveBehaviorHistory({
    ...current,
    [listName]: [
      { timestamp: new Date().toISOString(), ...item },
      ...(current[listName] ?? []),
    ],
  });
}

function clearBehaviorHistory() {
  const storage = safeStorage();
  if (storage) storage.removeItem(behaviorStorageKey);
}

function localTimeFromStartTime(startTime) {
  return /T(\d{2}:\d{2})/.exec(String(startTime ?? ''))?.[1] ?? null;
}

function timeBucket(localTime) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(localTime ?? ''));
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < 12 * 60) return 'morning';
  if (minutes < 17 * 60) return 'daytime';
  return 'evening';
}

function summarizeBehaviorHistory() {
  const history = loadBehaviorHistory();
  const rows = [...history.recentBookingClicks, ...history.recentSelections]
    .map((item) => ({
      startTime: item.startTime ?? null,
      localTime: item.localTime ?? localTimeFromStartTime(item.startTime),
      venue: item.venue ?? null,
      court: item.court ?? null,
    }))
    .filter((item) => item.localTime);
  const timeBuckets = { morning: 0, daytime: 0, evening: 0 };
  for (const row of rows) {
    const bucket = timeBucket(row.localTime);
    if (bucket) timeBuckets[bucket] += 1;
  }
  const dominant = Object.entries(timeBuckets)
    .sort((left, right) => right[1] - left[1])
    .find(([, count]) => count > 0);
  const dominantTimeBucket = dominant?.[0] ?? null;
  const dominantCount = dominant?.[1] ?? 0;
  return {
    bookingClickCount: history.recentBookingClicks.length,
    selectionCount: history.recentSelections.length,
    searchCount: history.recentSearches.length,
    timeBuckets,
    recentStartTimes: rows.slice(0, 10).map((item) => item.localTime),
    dominantTimeBucket,
    confidence: dominantCount >= 3 && dominantCount / Math.max(rows.length, 1) >= 0.6
      ? 'high'
      : dominantCount >= 2 ? 'medium' : 'low',
    recentBookingClicks: history.recentBookingClicks.slice(0, 10).map((item) => ({
      startTime: item.startTime,
      localTime: localTimeFromStartTime(item.startTime),
      venue: item.venue,
      court: item.court,
    })),
    recentSelections: history.recentSelections.slice(0, 10).map((item) => ({
      startTime: item.startTime,
      localTime: localTimeFromStartTime(item.startTime),
      venue: item.venue,
      court: item.court,
    })),
  };
}

function currentRequestText() {
  return requestInput.value.trim();
}

function syncButtonState() {
  findButton.disabled = currentRequestText().length === 0;
}

function renderSignals(target, items) {
  target.innerHTML = items.map((item) => `
    <div class="signal">
      <span class="dot ${escapeHtml(item.color ?? '')}"></span>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </div>
      <span class="tag">${escapeHtml(item.tag)}</span>
    </div>
  `).join('');
}

function describeRule(item) {
  const parts = [];
  if (item.rule?.before) parts.push(`before ${item.rule.before}`);
  if (item.rule?.after) parts.push(`after ${item.rule.after}`);
  if (item.rule?.equals) parts.push(`at ${item.rule.equals}`);
  if (item.rule?.period) parts.push(item.rule.period);
  if (item.rule?.condition) parts.push(item.rule.condition);
  if (item.rule?.max !== undefined) parts.push(`max ${item.rule.max}`);
  if (item.rule?.preferredRange) {
    parts.push(`around ${item.rule.preferredRange.min}-${item.rule.preferredRange.max}`);
  }
  if (item.rule?.dateRange?.type) parts.push(item.rule.dateRange.type);
  if (item.target !== undefined) parts.push(String(item.target));
  if (item.direction) parts.push(item.direction);
  return parts.join(', ') || item.sourceText || 'structured';
}

function renderProfile(profile) {
  const hard = (profile?.hardConstraints ?? []).map((item) => ({
    title: item.feature,
    detail: describeRule(item),
    tag: item.importance ?? 'hard',
    color: 'clay',
  }));
  const soft = (profile?.preferences ?? []).map((item) => ({
    title: item.feature,
    detail: describeRule(item),
    tag: item.importance ?? item.priority ?? 'soft',
    color: '',
  }));
  const objectives = (profile?.objectives ?? []).map((item) => ({
    title: item.feature,
    detail: describeRule(item),
    tag: item.priority ?? 'objective',
    color: 'blue',
  }));

  renderSignals(profileList, [...hard, ...soft, ...objectives].slice(0, 8));
}

function providerCandidateTotal(summary) {
  return (summary?.providerObservations ?? [])
    .reduce((total, item) => total + (Number(item.candidateCount) || 0), 0);
}

function renderSummary(response) {
  const summary = response.summary ?? {};
  document.querySelector('#metric-candidates').textContent = String(providerCandidateTotal(summary));
  document.querySelector('#metric-feasible').textContent = String(summary.feasibleCandidates ?? 0);
  document.querySelector('#metric-calendar').textContent = String(summary.rejectedByReason?.['calendar:calendar_conflict'] ?? 0);
  document.querySelector('#metric-weather').textContent = String(
    Object.entries(summary.rejectedByReason ?? {})
      .filter(([reason]) => reason.startsWith('weather:'))
      .reduce((total, [, count]) => total + count, 0),
  );
}

function clearSummary() {
  document.querySelector('#metric-candidates').textContent = '--';
  document.querySelector('#metric-feasible').textContent = '--';
  document.querySelector('#metric-calendar').textContent = '--';
  document.querySelector('#metric-weather').textContent = '--';
}

function renderRunState(response) {
  const summary = response.summary ?? {};
  const userStatus = response.userStatus ?? {};
  const providers = summary.providerObservations ?? [];
  const providerDetail = providers.length
    ? providers.map((item) => `${item.providerId}: ${item.status} (${item.candidateCount ?? 0})`).join('; ')
    : 'No provider observations returned.';
  const locationRouting = summary.locationRouting;
  const locationDetail = locationRouting?.matchedVenues?.length
    ? `${locationRouting.query} -> ${locationRouting.matchedVenues.map((venue) => `${venue.name} via ${venue.provider}`).join('; ')}`
    : locationRouting?.query
      ? `${locationRouting.query}: ${locationRouting.status}`
      : 'No explicit location in request.';

  renderSignals(filterList, [
    {
      title: 'Location routing',
      detail: locationDetail,
      tag: locationRouting?.status ?? 'none',
      color: locationRouting?.matchedVenues?.length ? 'blue' : 'clay',
    },
    {
      title: 'Availability providers',
      detail: providerDetail,
      tag: response.mode ?? 'real',
      color: 'blue',
    },
    {
      title: 'Evaluator',
      detail: userStatus.message ?? 'Recommendation state is not available.',
      tag: userStatus.code ?? 'status',
      color: userStatus.severity === 'warning' || userStatus.severity === 'needs_input' ? 'clay' : '',
    },
    {
      title: 'Replanner',
      detail: summary.latestAction?.selectedAction
        ? `${summary.latestAction.selectedAction}: ${summary.latestAction.rationale}`
        : 'No replanning action returned.',
      tag: `${summary.iterations ?? 0} iteration(s)`,
      color: '',
    },
  ]);
}

function formatPrice(price) {
  if (!Number.isFinite(price?.amount)) return 'price unknown';
  return `${price.currency ?? '$'}${price.amount}`;
}

function formatWeather(weather) {
  if (!weather?.forecastAvailable) return 'weather unknown';
  return `${weather.temperatureC ?? '?'}°C · rain ${weather.precipitationProbability ?? '?'}%`;
}

function formatCalendar(calendar) {
  if (!calendar) return 'calendar unknown';
  if (calendar.free === true) return 'calendar free';
  if (calendar.free === false) return 'calendar conflict';
  return `calendar ${calendar.status ?? 'unknown'}`;
}

function bookingCapabilityLabel(capability) {
  if (capability === 'court_date_time_preselected' || capability === 'date_time_preselected') {
    return 'Slot preselected';
  }
  if (capability === 'booking_page') return 'Booking page';
  return 'Book';
}

function bookingProvider(booking) {
  if (!booking?.url) return null;
  try {
    return new URL(booking.url).hostname;
  } catch {
    return null;
  }
}

function renderBookingAction(booking, candidate = null) {
  if (!booking?.url) return '';
  const behaviorAttrs = candidate ? [
    `data-behavior="booking-click"`,
    `data-venue="${escapeHtml(candidate.venue)}"`,
    `data-court="${escapeHtml(candidate.court)}"`,
    `data-start-time="${escapeHtml(candidate.startTime)}"`,
    `data-duration-minutes="${escapeHtml(candidate.durationMinutes)}"`,
    `data-booking-provider="${escapeHtml(bookingProvider(booking) ?? '')}"`,
  ].join(' ') : '';
  return `
    <a class="book-link" href="${escapeHtml(booking.url)}" target="_blank" rel="noopener noreferrer" ${behaviorAttrs}>
      Book this court
      <span>${escapeHtml(bookingCapabilityLabel(booking.capability))}</span>
    </a>
  `;
}

function renderCandidates(response) {
  const candidates = response.candidates ?? [];
  cards.innerHTML = candidates.slice(0, 3).map((candidate) => `
    <article class="court-card">
      <div class="rank">${escapeHtml(candidate.rank)}</div>
      <div>
        <h3>${escapeHtml(candidate.court)} · ${escapeHtml(candidate.localDate)} · ${escapeHtml(candidate.localTime)}</h3>
        <div class="meta">
          <span>${escapeHtml(candidate.venue)}</span>
          <span>${escapeHtml(candidate.durationMinutes)} min</span>
          <span>${escapeHtml(formatPrice(candidate.price))}</span>
          <span>${escapeHtml(formatWeather(candidate.weather))}</span>
          <span>${escapeHtml(candidate.availability?.nextHourAlsoAvailable ? 'next hour free' : 'single hour/unknown')}</span>
          <span>${escapeHtml(formatCalendar(candidate.calendar))}</span>
        </div>
        <p class="reasons">${escapeHtml([...(candidate.reasons ?? []), ...(candidate.tradeoffs ?? [])].join(' '))}</p>
        ${renderBookingAction(candidate.booking, candidate)}
      </div>
      <div class="score">
        <strong>${escapeHtml(candidate.rank)}</strong>
        <span>rank</span>
      </div>
    </article>
  `).join('');

  emptyState.classList.toggle('is-visible', candidates.length === 0);
  emptyState.textContent = candidates.length === 0
    ? response.userStatus?.message ?? response.error?.message ?? 'No recommendations are available for this request yet.'
    : '';
}

function formatDistance(distanceKm) {
  if (!Number.isFinite(distanceKm)) return 'distance unknown';
  return `${distanceKm.toFixed(distanceKm < 10 ? 1 : 0)} km away`;
}

function renderNearbyCourts(response) {
  const nearby = response.nearbyCourts ?? [];
  nearbyCards.innerHTML = nearby.slice(0, 5).map((venue) => `
    <article class="nearby-card">
      <div>
        <h3>${escapeHtml(venue.venue ?? venue.name)}</h3>
        <div class="meta">
          <span>${escapeHtml(venue.suburb ?? venue.area ?? 'Sydney')}</span>
          <span>${escapeHtml(formatDistance(venue.distanceKm))}</span>
          <span>${escapeHtml(venue.liveAvailability === false ? 'live availability unavailable' : 'live availability unknown')}</span>
          ${venue.courtCount ? `<span>${escapeHtml(`${venue.courtCount} courts`)}</span>` : ''}
          ${venue.surface ? `<span>${escapeHtml(venue.surface)}</span>` : ''}
        </div>
      </div>
      <div>
        ${renderBookingAction(venue.booking)}
      </div>
    </article>
  `).join('');
}

async function fetchRecommendation(text) {
  const userProfile = loadUserProfile();
  const recentBehavior = summarizeBehaviorHistory();
  const response = await fetch('/api/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request: text,
      userProfile,
      recentBehavior,
    }),
  });
  const payload = await response.json();
  if (!response.ok && !payload) throw new Error(`Request failed with HTTP ${response.status}`);
  return payload;
}

async function submitRequest() {
  const text = currentRequestText();
  if (!text) {
    syncButtonState();
    return;
  }

  findButton.disabled = true;
  statusLine.textContent = 'Running real CourtPilot pipeline...';
  results.classList.add('is-visible');
  cards.innerHTML = '';
  nearbyCards.innerHTML = '';
  emptyState.classList.remove('is-visible');

  try {
    const response = await fetchRecommendation(text);
    appendBehavior('recentSearches', {
      rawRequest: text,
      resolvedLocation: response.searchScope?.targetLocation?.canonicalName
        ?? response.searchScope?.targetLocation?.text
        ?? null,
      allowedTimeWindow: response.searchScope?.temporalWindow ?? null,
    });
    renderProfile(response.preferenceProfile);
    renderSummary(response);
    renderRunState(response);
    renderCandidates(response);
    renderNearbyCourts(response);
    statusLine.textContent = response.ok
      ? response.userStatus?.title ?? 'Recommendation run finished.'
      : `${response.status}: ${response.error?.message ?? 'Real pipeline failed.'}`;
  } catch (error) {
    clearSummary();
    renderSignals(profileList, []);
    renderSignals(filterList, [{
      title: 'API error',
      detail: error.message,
      tag: 'error',
      color: 'clay',
    }]);
    renderCandidates({
      status: 'API_ERROR',
      error: { message: error.message },
      candidates: [],
      nearbyCourts: [],
    });
    renderNearbyCourts({ nearbyCourts: [] });
    statusLine.textContent = `API_ERROR: ${error.message}`;
  } finally {
    syncButtonState();
  }
}

requestInput.addEventListener('input', () => {
  syncButtonState();
  statusLine.textContent = '';
});

requestForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitRequest();
});

sampleButton.addEventListener('click', () => {
  requestInput.value = sampleText;
  syncButtonState();
  submitRequest();
});

cards.addEventListener('click', (event) => {
  const link = event.target.closest('[data-behavior="booking-click"]');
  if (!link) return;
  appendBehavior('recentBookingClicks', {
    venueId: link.dataset.venueId || null,
    venue: link.dataset.venue || null,
    court: link.dataset.court || null,
    startTime: link.dataset.startTime || null,
    durationMinutes: Number(link.dataset.durationMinutes) || null,
    bookingProvider: link.dataset.bookingProvider || null,
  });
});

window.CourtPilotStorage = {
  clearBehaviorHistory,
  loadBehaviorHistory,
  loadUserProfile,
  summarizeBehaviorHistory,
};

syncButtonState();
