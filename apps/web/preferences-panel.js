const sampleText = '这几天我想打球，这周六我有事，周日晚上八点后能打，不要太热，$25左右';
const exampleTexts = {
  'Tonight near CBD': 'Tonight near CBD, cheaper courts preferred, around 7pm if possible.',
  'Cheap courts': 'Find me a cheap tennis court this week. I can be flexible on time.',
};

const screens = {
  onboarding: document.querySelector('#onboarding-screen'),
  search: document.querySelector('#search-screen'),
  loading: document.querySelector('#loading-screen'),
  results: document.querySelector('#results-screen'),
};
const requestForm = document.querySelector('#court-request-form');
const requestInput = document.querySelector('#court-request');
const findButton = document.querySelector('#find-court');
const sampleButton = document.querySelector('#sample-request');
const statusLine = document.querySelector('#request-status');
const charCount = document.querySelector('#char-count');
const profileList = document.querySelector('#profile-list');
const resultsProfileList = document.querySelector('#results-profile-list');
const understoodCard = document.querySelector('#understood-card');
const resultsUnderstoodCard = document.querySelector('#results-understood-card');
const filterList = document.querySelector('#filter-list');
const cards = document.querySelector('#cards');
const otherCards = document.querySelector('#other-cards');
const otherOptionsSection = document.querySelector('#other-options-section');
const nearbyCards = document.querySelector('#nearby-cards');
const nearbySection = document.querySelector('#nearby-section');
const emptyState = document.querySelector('#empty-state');
const whyCard = document.querySelector('#why-card');
const whyList = document.querySelector('#why-list');
const loadingStatus = document.querySelector('#loading-status');
const onboardingForm = document.querySelector('#onboarding-form');
const skipOnboarding = document.querySelector('#skip-onboarding');
const editProfileButtons = [
  document.querySelector('#edit-profile'),
  document.querySelector('#results-edit-profile'),
].filter(Boolean);
const searchAgainButton = document.querySelector('#search-again');
const profileStorageKey = 'findmycourt.profile.v1';
const behaviorStorageKey = 'findmycourt.behavior.v1';
const behaviorStorageVersion = 1;
const maxBehaviorItems = 20;
const demoServerOrigin = 'http://127.0.0.1:4174';
const loadingMessages = [
  'Understanding your preferences...',
  'Checking nearby courts...',
  'Comparing available options...',
];
let loadingMessageTimer = null;

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

function loadProfileEnvelope() {
  const storage = safeStorage();
  return storage ? safeJsonParse(storage.getItem(profileStorageKey)) : null;
}

function loadUserProfile() {
  const envelope = loadProfileEnvelope();
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

function saveUserProfile(userProfile, extra = {}) {
  const storage = safeStorage();
  const envelope = {
    version: 1,
    timestamp: new Date().toISOString(),
    userProfile,
    ...extra,
  };
  if (storage) storage.setItem(profileStorageKey, JSON.stringify(envelope));
  return envelope;
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

function showScreen(name) {
  Object.entries(screens).forEach(([screenName, node]) => {
    node?.classList.toggle('is-active', screenName === name);
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function syncButtonState() {
  findButton.disabled = currentRequestText().length === 0;
  charCount.textContent = `${requestInput.value.length}/500`;
}

function selectedValues(groupName) {
  return [...document.querySelectorAll(`[data-choice-group="${groupName}"] .choice.is-selected`)]
    .map((node) => node.dataset.value)
    .filter(Boolean);
}

function buildOnboardingProfile() {
  const start = document.querySelector('#profile-start-time').value || '18:00';
  const end = document.querySelector('#profile-end-time').value || '20:00';
  const duration = Number(selectedValues('duration')[0]) || null;
  const maxTravelMinutes = Number(selectedValues('travel')[0]) || null;
  return {
    preferredDays: selectedValues('days'),
    preferredTimeWindows: start && end ? [{ start, end }] : [],
    typicalDurationMinutes: duration,
    maxTravelMinutes,
    preferredVenues: selectedValues('venues'),
  };
}

function shouldShowOnboarding() {
  const envelope = loadProfileEnvelope();
  return !envelope;
}

function formatTimeForChip(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return value;
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${match[2]} ${suffix}`;
}

function describeProfileChipsFromUserProfile(userProfile) {
  if (!userProfile) return [];
  const chips = [];
  if (userProfile.preferredVenues?.length) chips.push(...userProfile.preferredVenues.slice(0, 3));
  if (userProfile.preferredDays?.length) chips.push(userProfile.preferredDays.slice(0, 4).join(', '));
  for (const window of userProfile.preferredTimeWindows ?? []) {
    if (window.start && window.end) {
      chips.push(`${formatTimeForChip(window.start)} - ${formatTimeForChip(window.end)}`);
    }
  }
  if (userProfile.typicalDurationMinutes) chips.push(`${userProfile.typicalDurationMinutes} min`);
  if (userProfile.maxTravelMinutes) chips.push(`${userProfile.maxTravelMinutes} min travel`);
  return chips;
}

function describeRule(item) {
  const parts = [];
  if (item.rule?.before) parts.push(`Before ${item.rule.before}`);
  if (item.rule?.after) parts.push(`After ${item.rule.after}`);
  if (item.rule?.equals) parts.push(`At ${item.rule.equals}`);
  if (item.rule?.start && item.rule?.end) parts.push(`${item.rule.start} - ${item.rule.end}`);
  if (item.rule?.period) parts.push(item.rule.period);
  if (item.rule?.condition) parts.push(item.rule.condition);
  if (item.rule?.max !== undefined) parts.push(`Max ${item.rule.max}`);
  if (item.rule?.preferredRange) {
    parts.push(`Around ${item.rule.preferredRange.min}-${item.rule.preferredRange.max}`);
  }
  if (item.rule?.dateRange?.type) parts.push(item.rule.dateRange.type);
  if (item.target !== undefined) parts.push(String(item.target));
  if (item.direction) parts.push(item.direction === 'lower' ? 'Cheaper' : item.direction);
  return parts.join(', ') || item.sourceText || item.feature || 'Preference';
}

function labelForFeature(feature) {
  return String(feature ?? '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function chipsFromPreferenceProfile(profile) {
  const items = [
    ...(profile?.hardConstraints ?? []),
    ...(profile?.preferences ?? []),
    ...(profile?.objectives ?? []),
  ];
  return items.map((item) => {
    const detail = describeRule(item);
    if (!detail || detail === 'structured') return labelForFeature(item.feature);
    if (item.feature === 'price' && detail.toLowerCase().includes('cheaper')) return 'Cheaper price';
    if (item.feature === 'start_time') return detail;
    if (item.feature === 'next_hour_free') return 'Next hour free';
    if (item.feature === 'duration') return detail;
    if (item.feature === 'venue') return detail;
    return detail.length <= 22 ? detail : labelForFeature(item.feature);
  }).filter(Boolean);
}

function renderProfileChips(target, chips) {
  target.innerHTML = chips.slice(0, 8)
    .map((chip) => `<span class="profile-chip">${escapeHtml(chip)}</span>`)
    .join('');
}

function renderStoredProfile() {
  const chips = describeProfileChipsFromUserProfile(loadUserProfile());
  const visible = chips.length > 0;
  renderProfileChips(profileList, chips);
  understoodCard.classList.toggle('is-visible', visible);
}

function renderProfile(profile) {
  const chips = chipsFromPreferenceProfile(profile);
  const fallback = describeProfileChipsFromUserProfile(loadUserProfile());
  const finalChips = chips.length ? chips : fallback;
  renderProfileChips(profileList, finalChips);
  renderProfileChips(resultsProfileList, finalChips);
  understoodCard.classList.toggle('is-visible', finalChips.length > 0);
  resultsUnderstoodCard.classList.toggle('is-visible', finalChips.length > 0);
}

function renderSignals(target, items) {
  target.innerHTML = items.map((item) => `
    <div class="signal">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.detail)}</span>
      <span class="tag">${escapeHtml(item.tag)}</span>
    </div>
  `).join('');
}

function providerCandidateTotal(summary) {
  return (summary?.providerObservations ?? [])
    .reduce((total, item) => total + (Number(item.candidateCount) || 0), 0);
}

function renderSummary(response) {
  const summary = response.summary ?? {};
  document.querySelector('#metric-candidates').textContent = String(providerCandidateTotal(summary));
  document.querySelector('#metric-feasible').textContent = String(summary.feasibleCandidates ?? 0);
  document.querySelector('#metric-weather').textContent = String(
    Object.entries(summary.rejectedByReason ?? {})
      .filter(([reason]) => reason.startsWith('weather:'))
      .reduce((total, [, count]) => total + count, 0),
  );
}

function clearSummary() {
  document.querySelector('#metric-candidates').textContent = '--';
  document.querySelector('#metric-feasible').textContent = '--';
  document.querySelector('#metric-weather').textContent = '--';
}

function renderRunState(response) {
  const summary = response.summary ?? {};
  const userStatus = response.userStatus ?? {};
  const providers = summary.providerObservations ?? [];
  const rejectedReasons = Object.entries(summary.rejectedByReason ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason} (${count})`)
    .join('; ');
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
    },
    {
      title: 'Availability providers',
      detail: providerDetail,
      tag: response.mode ?? 'real',
    },
    {
      title: 'Evaluator',
      detail: userStatus.message ?? 'Recommendation state is not available.',
      tag: userStatus.code ?? 'status',
    },
    {
      title: 'Reject reasons',
      detail: rejectedReasons || 'No rejected candidates reported.',
      tag: `${Object.values(summary.rejectedByReason ?? {}).reduce((total, count) => total + count, 0)} total`,
    },
    {
      title: 'Replanner',
      detail: summary.latestAction?.selectedAction
        ? `${summary.latestAction.selectedAction}: ${summary.latestAction.rationale}`
        : 'No replanning action returned.',
      tag: `${summary.iterations ?? 0} iteration(s)`,
    },
  ]);
}

function formatPriceValue(price) {
  if (!Number.isFinite(price?.amount)) return null;
  return `${price.currency ?? '$'}${price.amount}`;
}

function formatWeatherValue(weather) {
  if (!weather?.forecastAvailable) return null;
  const parts = [];
  if (Number.isFinite(weather.temperatureC)) parts.push(`${weather.temperatureC}C`);
  if (Number.isFinite(weather.precipitationProbability)) parts.push(`rain ${weather.precipitationProbability}%`);
  return parts.join(' · ') || null;
}

function formatDistance(distanceKm) {
  if (!Number.isFinite(distanceKm)) return null;
  return `${distanceKm.toFixed(distanceKm < 10 ? 1 : 0)} km away`;
}

function formatTimeRange(candidate) {
  const date = candidate.localDate;
  const time = candidate.localTime;
  const duration = Number(candidate.durationMinutes);
  if (!date && !time) return null;
  if (!time || !Number.isFinite(duration)) return [date, time].filter(Boolean).join(', ');
  return `${date ? `${date}, ` : ''}${time} · ${duration} min`;
}

function courtThumbText(candidate) {
  const venue = candidate.venue ? String(candidate.venue).split(/\s+/).slice(0, 2).join(' ') : 'Court';
  const court = candidate.court ?? '';
  return [venue, court].filter(Boolean).join('<br>');
}

function relevantFacts(candidate) {
  const facts = [];
  if (candidate.availability?.nextHourAlsoAvailable === true) facts.push('Next hour free');
  if (candidate.preferredTime === true) facts.push('Preferred time');
  const weather = formatWeatherValue(candidate.weather);
  if (weather) facts.push(weather);
  return facts.slice(0, 4).map((label) => ({ label, warning: false }));
}

function weatherWarningLabel(candidate) {
  const weatherWarning = (candidate.warnings ?? [])
    .find((warning) => warning.feature === 'weather' && warning.detail?.badWeather === true)
    ?.detail;
  if (!weatherWarning) return null;
  const details = [];
  if (weatherWarning.condition) details.push(weatherWarning.condition);
  if (Number.isFinite(weatherWarning.precipitationProbability)) {
    details.push(`${weatherWarning.precipitationProbability}% chance`);
  }
  return `Weather warning${details.length ? `: ${details.join(', ')}` : ''}`;
}

function cardFactChips(candidate) {
  const facts = relevantFacts(candidate);
  const warning = weatherWarningLabel(candidate);
  if (warning) facts.unshift({ label: warning, warning: true });
  return facts.slice(0, 5);
}

function bookingProvider(booking) {
  if (!booking?.url) return null;
  try {
    return new URL(booking.url).hostname;
  } catch {
    return null;
  }
}

function bookingLabel(booking, context = 'candidate') {
  if (context === 'nearby') return 'Check availability';
  if (booking?.capability === 'court_date_time_preselected' || booking?.capability === 'date_time_preselected') {
    return 'Book this court';
  }
  if (booking?.capability === 'booking_page') return 'View booking';
  return 'View booking';
}

function renderVenueAction(venueUrl) {
  if (!venueUrl) return '';
  return `
    <a class="book-link" href="${escapeHtml(venueUrl)}" target="_blank" rel="noopener noreferrer">
      View venue ↗
    </a>
  `;
}

function renderBookingAction(booking, candidate = null, context = 'candidate') {
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
      ${escapeHtml(bookingLabel(booking, context))} ↗
    </a>
  `;
}

function renderCandidateCard(candidate, isBest = false) {
  const details = [
    candidate.court,
    formatDistance(candidate.distanceKm ?? candidate.travel?.distanceKm),
    formatTimeRange(candidate),
  ].filter(Boolean);
  const price = formatPriceValue(candidate.price);
  const weather = formatWeatherValue(candidate.weather);
  const lowerLine = [
    candidate.surface,
    price,
    weather,
  ].filter(Boolean).join(' · ');
  if (lowerLine) details.push(lowerLine);
  const facts = cardFactChips(candidate);
  return `
    <article class="court-card ${isBest ? 'is-best' : ''}">
      ${isBest ? '<div class="best-tag">★ BEST MATCH</div>' : ''}
      <div class="card-main">
        <div class="court-thumb">${courtThumbText(candidate)}</div>
        <div class="card-copy">
          <h3>${escapeHtml(candidate.venue ?? 'Tennis court')}</h3>
          <div class="detail-stack">
            ${details.map((detail, index) => `<p class="${index === details.length - 1 && lowerLine ? 'positive' : ''}">${escapeHtml(detail)}</p>`).join('')}
          </div>
        </div>
      </div>
      ${facts.length ? `
        <div class="divider"></div>
        <div class="facts">${facts.map((fact) => `<span class="fact-chip ${fact.warning ? 'warning' : ''}">✓ ${escapeHtml(fact.label)}</span>`).join('')}</div>
      ` : ''}
      ${renderBookingAction(candidate.booking, candidate)}
    </article>
  `;
}

function renderWhyResult(candidate) {
  const reasons = (candidate?.reasons ?? []).slice(0, 3);
  const tradeoffs = (candidate?.tradeoffs ?? []).slice(0, 2);
  const lines = [...reasons, ...tradeoffs];
  whyCard.classList.toggle('is-visible', lines.length > 0);
  whyList.innerHTML = lines
    .map((line) => `<p>✓ ${escapeHtml(line)}</p>`)
    .join('');
}

function renderEmptyState(response, hasNearby) {
  const message = response.userStatus?.message ?? response.error?.message ?? 'No suitable realtime recommendations are available for this request yet.';
  const title = hasNearby ? 'No verified slots found' : response.error ? 'CourtPilot could not finish this search' : 'No verified slots found';
  emptyState.classList.add('is-visible');
  emptyState.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(message)}</p>
  `;
}

function renderCandidates(response) {
  const candidates = response.candidates ?? response.recommendations ?? [];
  const nearby = response.nearbyCourts ?? response.nearbyVenues ?? [];
  const visibleCandidates = candidates.slice(0, 3);
  const [best, ...others] = visibleCandidates;
  cards.innerHTML = best ? renderCandidateCard(best, true) : '';
  otherCards.innerHTML = others.map((candidate) => renderCandidateCard(candidate, false)).join('');
  otherOptionsSection.style.display = others.length ? '' : 'none';
  emptyState.classList.toggle('is-visible', !best);
  emptyState.innerHTML = '';
  if (!best) renderEmptyState(response, nearby.length > 0);
  renderWhyResult(best);
}

function venueThumbText(venue) {
  const name = venue.venue ?? venue.name ?? 'Court';
  return String(name).split(/\s+/).slice(0, 2).join('<br>');
}

function availabilityLabel(venue) {
  if (venue.liveAvailability === false) return 'Live availability unavailable';
  if (venue.liveAvailability === true) return 'Live availability available';
  return 'Live availability pending';
}

function renderNearbyCourts(response) {
  const nearby = response.nearbyCourts ?? response.nearbyVenues ?? [];
  nearbySection.style.display = nearby.length ? '' : 'none';
  nearbyCards.innerHTML = nearby.slice(0, 5).map((venue) => {
    const meta = [
      venue.suburb ?? venue.area,
      formatDistance(venue.distanceKm),
      venue.courtCount ? `${venue.courtCount} courts` : null,
      venue.surface,
      availabilityLabel(venue),
    ].filter(Boolean);
    return `
      <article class="nearby-card">
        <div class="court-thumb">${venueThumbText(venue)}</div>
        <div class="nearby-copy">
          <h3>${escapeHtml(venue.venue ?? venue.name ?? 'Nearby court')}</h3>
          <div class="nearby-meta">
            ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
          </div>
        </div>
        ${venue.booking?.url ? renderBookingAction(venue.booking, null, 'nearby') : renderVenueAction(venue.venueUrl)}
      </article>
    `;
  }).join('');
}

function recommendApiUrl() {
  if (window.location.protocol === 'file:') return `${demoServerOrigin}/api/recommend`;
  return '/api/recommend';
}

function friendlyFetchError(error) {
  if (window.location.protocol === 'file:') {
    return `Cannot reach the CourtPilot demo API from this file preview. Start the demo server with npm run demo, then open ${demoServerOrigin}/.`;
  }
  return error.message;
}

async function fetchRecommendation(text) {
  const userProfile = loadUserProfile();
  const recentBehavior = summarizeBehaviorHistory();
  const response = await fetch(recommendApiUrl(), {
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

function startLoadingState() {
  let index = 0;
  loadingStatus.textContent = loadingMessages[index];
  clearInterval(loadingMessageTimer);
  loadingMessageTimer = setInterval(() => {
    index = Math.min(index + 1, loadingMessages.length - 1);
    loadingStatus.textContent = loadingMessages[index];
  }, 1400);
}

function stopLoadingState() {
  clearInterval(loadingMessageTimer);
  loadingMessageTimer = null;
}

async function submitRequest() {
  const text = currentRequestText();
  if (!text) {
    syncButtonState();
    return;
  }

  findButton.disabled = true;
  statusLine.textContent = '';
  cards.innerHTML = '';
  otherCards.innerHTML = '';
  nearbyCards.innerHTML = '';
  emptyState.classList.remove('is-visible');
  whyCard.classList.remove('is-visible');
  startLoadingState();
  showScreen('loading');

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
    showScreen('results');
  } catch (error) {
    const message = friendlyFetchError(error);
    clearSummary();
    renderProfile(null);
    renderSignals(filterList, [{
      title: 'API error',
      detail: message,
      tag: 'error',
    }]);
    renderCandidates({
      status: 'API_ERROR',
      error: { message },
      candidates: [],
      nearbyCourts: [],
    });
    renderNearbyCourts({ nearbyCourts: [] });
    showScreen('results');
  } finally {
    stopLoadingState();
    syncButtonState();
  }
}

function handleSearchAgain() {
  requestInput.value = '';
  statusLine.textContent = '';
  syncButtonState();
  renderStoredProfile();
  showScreen('search');
  requestInput.focus();
}

function completeOnboarding(skipped = false) {
  if (skipped) {
    saveUserProfile(null, { skippedOnboarding: true });
  } else {
    saveUserProfile(buildOnboardingProfile());
  }
  renderStoredProfile();
  showScreen('search');
}

document.querySelectorAll('.choice-row').forEach((group) => {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('.choice');
    if (!button) return;
    if (group.dataset.singleChoice === 'true') {
      group.querySelectorAll('.choice').forEach((item) => item.classList.remove('is-selected'));
    }
    button.classList.toggle('is-selected');
  });
});

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

document.querySelectorAll('.example-chip').forEach((button) => {
  button.addEventListener('click', () => {
    requestInput.value = exampleTexts[button.dataset.example] ?? button.dataset.example ?? '';
    syncButtonState();
    submitRequest();
  });
});

onboardingForm.addEventListener('submit', (event) => {
  event.preventDefault();
  completeOnboarding(false);
});

skipOnboarding.addEventListener('click', () => {
  completeOnboarding(true);
});

editProfileButtons.forEach((button) => {
  button.addEventListener('click', () => showScreen('onboarding'));
});

searchAgainButton.addEventListener('click', handleSearchAgain);

document.addEventListener('click', (event) => {
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

renderStoredProfile();
syncButtonState();
showScreen(shouldShowOnboarding() ? 'onboarding' : 'search');
