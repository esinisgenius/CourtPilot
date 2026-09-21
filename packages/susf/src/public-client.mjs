const sensitiveHeaderNames = new Set([
  'authorization',
  'cookie',
  'pm-auth',
  'pmauth',
  'x-csrf-token',
  'x-xsrf-token',
  'requestverificationtoken',
  '__requestverificationtoken',
]);

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function isFacilityAvailabilityUrl(url) {
  return /FacilityAvailability/i.test(url);
}

function requestMentionsFacility(request, facilityId) {
  if (!facilityId) return true;

  const url = request.url();
  if (url.includes(facilityId)) return true;

  const postData = request.postData() ?? '';
  return postData.includes(facilityId);
}

async function getVerificationToken(page) {
  return page.evaluate(() => {
    const input = document.querySelector('input[name="__RequestVerificationToken"]');
    if (input?.value) return input.value;

    const meta = document.querySelector(
      'meta[name="__RequestVerificationToken"], meta[name="csrf-token"], meta[name="request-verification-token"]',
    );
    if (meta?.content) return meta.content;

    return null;
  });
}

function stripUnsafeRequestHeaders(headers) {
  const safe = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (sensitiveHeaderNames.has(lower)) continue;
    if (['host', 'connection', 'content-length', 'origin', 'referer'].includes(lower)) continue;
    if (lower.startsWith('sec-')) continue;
    safe[name] = value;
  }
  return safe;
}

function parseBody(body, contentType) {
  if (!body) return { kind: 'empty', value: null };

  if (/json/i.test(contentType)) {
    return { kind: 'json', value: JSON.parse(body) };
  }

  if (/x-www-form-urlencoded/i.test(contentType) || body.includes('=')) {
    return { kind: 'form', value: new URLSearchParams(body) };
  }

  return { kind: 'raw', value: body };
}

function setCaseInsensitive(target, wantedName, value) {
  if (target instanceof URLSearchParams) {
    const existing = [...target.keys()].find((key) => key.toLowerCase() === wantedName.toLowerCase());
    target.set(existing ?? wantedName, String(value));
    return true;
  }

  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const existing = Object.keys(target).find((key) => key.toLowerCase() === wantedName.toLowerCase());
    target[existing ?? wantedName] = value;
    return true;
  }

  return false;
}

function setCaseInsensitiveDeep(target, wantedName, value) {
  if (!target || typeof target !== 'object') return false;
  if (target instanceof URLSearchParams) return setCaseInsensitive(target, wantedName, value);

  if (Array.isArray(target)) {
    return target
      .map((item) => setCaseInsensitiveDeep(item, wantedName, value))
      .some(Boolean);
  }

  let changed = false;
  for (const key of Object.keys(target)) {
    if (key.toLowerCase() === wantedName.toLowerCase()) {
      target[key] = value;
      changed = true;
    } else if (target[key] && typeof target[key] === 'object') {
      changed = setCaseInsensitiveDeep(target[key], wantedName, value) || changed;
    }
  }

  return changed;
}

function getCaseInsensitive(target, wantedName) {
  if (target instanceof URLSearchParams) {
    const existing = [...target.keys()].find((key) => key.toLowerCase() === wantedName.toLowerCase());
    return existing ? target.get(existing) : undefined;
  }

  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const existing = Object.keys(target).find((key) => key.toLowerCase() === wantedName.toLowerCase());
    return existing ? target[existing] : undefined;
  }

  return undefined;
}

function getCaseInsensitiveDeep(target, wantedName) {
  if (!target || typeof target !== 'object') return undefined;
  if (target instanceof URLSearchParams) return getCaseInsensitive(target, wantedName);

  if (Array.isArray(target)) {
    for (const item of target) {
      const found = getCaseInsensitiveDeep(item, wantedName);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const direct = getCaseInsensitive(target, wantedName);
  if (direct !== undefined) return direct;

  for (const child of Object.values(target)) {
    const found = getCaseInsensitiveDeep(child, wantedName);
    if (found !== undefined) return found;
  }

  return undefined;
}

function formatDateLikeCaptured(isoDate, capturedValue) {
  if (typeof capturedValue !== 'string') return isoDate;

  const [, year, month, day] = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? [];
  if (!year) return isoDate;

  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(capturedValue)) {
    return `${Number(month)}/${Number(day)}/${year}`;
  }

  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(capturedValue)) {
    return `${Number(month)}-${Number(day)}-${year}`;
  }

  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(capturedValue)) {
    return `${year}/${Number(month)}/${Number(day)}`;
  }

  return isoDate;
}

function prepareUrl(capturedUrl, { facilityId, date, daysCount, durationMinutes }) {
  const url = new URL(capturedUrl);
  const capturedDate = getCaseInsensitive(url.searchParams, 'date');
  const formattedDate = formatDateLikeCaptured(date, capturedDate);

  setCaseInsensitive(url.searchParams, 'facilityId', facilityId);
  setCaseInsensitive(url.searchParams, 'date', formattedDate);
  setCaseInsensitive(url.searchParams, 'daysCount', daysCount);
  setCaseInsensitive(url.searchParams, 'duration', durationMinutes);

  return url.toString();
}

function assertRequiredAvailabilityMetadata(body) {
  const facilityId = getCaseInsensitiveDeep(body, 'facilityId');
  const serviceId = getCaseInsensitiveDeep(body, 'serviceId');
  const daysCount = getCaseInsensitiveDeep(body, 'daysCount');
  const durationIds = body instanceof URLSearchParams
    ? body.getAll('durationIds[]')
    : getCaseInsensitiveDeep(body, 'durationIds');

  const missing = [];
  if (!facilityId) missing.push('facilityId');
  if (!serviceId) missing.push('serviceId');
  if (!daysCount) missing.push('daysCount');
  if (!durationIds || durationIds.length === 0) missing.push('durationIds[]');

  if (missing.length > 0) {
    throw new Error(`Captured FacilityAvailability request is missing required metadata: ${missing.join(', ')}`);
  }
}

function prepareBody(captured, { facilityId, date, token, daysCount, durationMinutes }) {
  const contentType = captured.headers['content-type'] ?? captured.headers['Content-Type'] ?? '';
  const parsed = parseBody(captured.postData ?? '', contentType);

  if (parsed.kind === 'empty') {
    throw new Error('Captured FacilityAvailability request body is empty; refusing to guess required metadata.');
  }
  if (parsed.kind === 'raw') {
    throw new Error('Captured FacilityAvailability request body is neither JSON nor form-urlencoded; refusing to guess.');
  }

  const body = parsed.value;
  assertRequiredAvailabilityMetadata(body);
  const capturedDate = getCaseInsensitiveDeep(body, 'date');
  const formattedDate = formatDateLikeCaptured(date, capturedDate);

  setCaseInsensitiveDeep(body, 'facilityId', facilityId);
  if (!setCaseInsensitiveDeep(body, 'date', formattedDate)) {
    setCaseInsensitive(body, 'date', formattedDate);
  }
  setCaseInsensitiveDeep(body, 'daysCount', daysCount);
  if (!setCaseInsensitiveDeep(body, 'duration', durationMinutes)) {
    setCaseInsensitive(body, 'duration', durationMinutes);
  }

  if (!token) {
    throw new Error('Missing public anti-forgery token from Facility page.');
  }

  if (!setCaseInsensitiveDeep(body, '__RequestVerificationToken', token)) {
    setCaseInsensitive(body, '__RequestVerificationToken', token);
  }

  if (parsed.kind === 'json') return JSON.stringify(body);
  return body.toString();
}

function prepareHeaders(captured) {
  const headers = stripUnsafeRequestHeaders(captured.headers);
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  }
  return headers;
}

function prepareAvailabilityRequest(captured, requestOptions) {
  return {
    url: prepareUrl(captured.url, requestOptions),
    method: captured.method,
    headers: prepareHeaders(captured),
    body: prepareBody(captured, requestOptions),
  };
}

function redactCapturedBody(captured) {
  const contentType = captured.headers['content-type'] ?? captured.headers['Content-Type'] ?? '';
  const parsed = parseBody(captured.postData ?? '', contentType);
  if (parsed.kind === 'empty' || parsed.kind === 'raw') return captured.postData ?? '';
  const body = parsed.value;
  setCaseInsensitiveDeep(body, '__RequestVerificationToken', '__TOKEN__');
  if (parsed.kind === 'json') return JSON.stringify(body);
  return body.toString();
}

function sanitizeCapturedAvailabilityRequest(captured) {
  return {
    url: captured.url,
    method: captured.method,
    headers: prepareHeaders(captured),
    postData: redactCapturedBody(captured),
  };
}

function createAvailabilityCapture(page, facilityId = null, { captureTimeoutMs }) {
  let captured = null;
  let stopped = false;

  const onRequest = (request) => {
    if (!isFacilityAvailabilityUrl(request.url()) || captured) return;
    if (!requestMentionsFacility(request, facilityId)) return;

    captured = {
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData(),
    };
    console.log('Captured a public FacilityAvailability request shape from the page.');
  };

  page.on('request', onRequest);

  return {
    async wait({ onNeedTrigger, initialDelayMs = 5_000 } = {}) {
      await sleep(initialDelayMs);
      if (captured || stopped) return captured;

      if (onNeedTrigger) {
        await onNeedTrigger();
        await sleep(5_000);
        if (captured || stopped) return captured;
      }

      const startedAt = Date.now();
      while (!captured && !stopped && Date.now() - startedAt < captureTimeoutMs) {
        await sleep(500);
      }

      return captured;
    },

    stop() {
      stopped = true;
      page.off('request', onRequest);
    },
  };
}

async function fetchAvailabilityJson(page, request) {
  return page.evaluate(async ({ url, method, headers, body }) => {
    const response = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`FacilityAvailability returned HTTP ${response.status}`);
    }

    return response.json();
  }, request);
}

function cookiesFromHeaders(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

function verificationTokenFromHtml(html) {
  return String(html).match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)?.[1]
    ?? String(html).match(/value=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken["']/i)?.[1]
    ?? null;
}

async function createPublicHttpSession(pageUrl, { fetchImpl = fetch, signal = null } = {}) {
  const response = await fetchImpl(pageUrl, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'CourtPilot availability collector/1.0',
    },
    redirect: 'follow',
    signal,
  });
  if (!response.ok) throw new Error(`SUSF public page returned HTTP ${response.status}`);
  const html = await response.text();
  const token = verificationTokenFromHtml(html);
  if (!token) throw new Error('Missing public anti-forgery token from SUSF page.');
  return {
    token,
    cookie: cookiesFromHeaders(response.headers),
    pageUrl: response.url || pageUrl,
  };
}

async function fetchAvailabilityJsonHttp(session, request, { fetchImpl = fetch, signal = null } = {}) {
  const origin = new URL(session.pageUrl).origin;
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: {
      ...request.headers,
      cookie: session.cookie,
      origin,
      referer: session.pageUrl,
    },
    body: request.body,
    signal,
  });
  if (!response.ok) throw new Error(`FacilityAvailability returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!/json/i.test(contentType)) {
    throw new Error(`FacilityAvailability returned non-JSON content (${contentType || 'unknown'})`);
  }
  return response.json();
}

export {
  createAvailabilityCapture,
  createPublicHttpSession,
  fetchAvailabilityJson,
  fetchAvailabilityJsonHttp,
  getVerificationToken,
  prepareAvailabilityRequest,
  sanitizeCapturedAvailabilityRequest,
  verificationTokenFromHtml,
};
