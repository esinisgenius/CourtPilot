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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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

function renderBookingAction(booking) {
  if (!booking?.url) return '';
  return `
    <a class="book-link" href="${escapeHtml(booking.url)}" target="_blank" rel="noopener noreferrer">
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
        ${renderBookingAction(candidate.booking)}
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
  const response = await fetch('/api/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: text }),
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

syncButtonState();
