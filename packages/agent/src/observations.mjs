import { getBookableAvailability } from '../../bookable/src/index.mjs';
import { getClubSparkAvailability } from '../../clubspark/src/index.mjs';
import { buildCandidates } from '../../core/src/index.mjs';
import { getSusfAvailability } from '../../susf/src/index.mjs';
import { getIntracAvailability } from '../../intrac/src/index.mjs';
import { getMindbodyAvailability } from '../../mindbody/src/index.mjs';
import { getSportLogicAvailability } from '../../sportlogic/src/index.mjs';
import { getUnifiedBookingsAvailability } from '../../unified-bookings/src/index.mjs';
import { markProviderObserved, normalizeProviderScope } from './provider-scope.mjs';
import { validateAgentState } from './state.mjs';
import { snapshotFetcher } from '../../availability-snapshots/src/store.mjs';

const DEFAULT_PROVIDER_FETCHERS = Object.freeze({
  susf: getSusfAvailability,
  bookable: getBookableAvailability,
  clubspark: getClubSparkAvailability,
  'unified-bookings': getUnifiedBookingsAvailability,
  sportlogic: getSportLogicAvailability,
  intrac: getIntracAvailability,
  mindbody: getMindbodyAvailability,
});

const SNAPSHOT_PROVIDER_FETCHERS = Object.freeze(Object.fromEntries(
  Object.keys(DEFAULT_PROVIDER_FETCHERS).map((providerId) => [providerId, snapshotFetcher(providerId)]),
));

function runtimeProviderFetchers() {
  if (process.env.AVAILABILITY_SNAPSHOT_ONLY !== '1') return DEFAULT_PROVIDER_FETCHERS;
  const directProviders = new Set((process.env.AVAILABILITY_DIRECT_PROVIDERS ?? '')
    .split(',')
    .map((providerId) => providerId.trim())
    .filter(Boolean));
  return Object.freeze(Object.fromEntries(Object.keys(DEFAULT_PROVIDER_FETCHERS).map((providerId) => [
    providerId,
    directProviders.has(providerId) ? DEFAULT_PROVIDER_FETCHERS[providerId] : SNAPSHOT_PROVIDER_FETCHERS[providerId],
  ])));
}

function mergeCandidates(existingCandidates, newCandidates) {
  const byId = new Map();
  for (const candidate of [...existingCandidates, ...newCandidates]) {
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort((a, b) => `${a.startTime} ${a.venue} ${a.court}`.localeCompare(`${b.startTime} ${b.venue} ${b.court}`));
}

async function fetchAvailabilityVariants(fetchAvailability, options, budgetOptions) {
  const variants = Array.isArray(options) ? options : [options];
  const availability = [];
  for (const variant of variants) {
    const rows = await fetchWithBudget(fetchAvailability, variant, budgetOptions);
    availability.push(...rows);
  }
  const byKey = new Map();
  for (const row of availability) {
    const canonical = row?.canonical;
    const key = canonical
      ? [canonical.provider, canonical.venue?.id, canonical.court?.id, canonical.slot?.start, canonical.slot?.durationMinutes].join('|')
      : JSON.stringify(row);
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

function providerObservation(providerId, {
  status,
  candidateCount = 0,
  error = null,
  observedAt = new Date().toISOString(),
  startedAt = null,
  completedAt = null,
  durationMs = null,
} = {}) {
  return {
    providerId,
    status,
    candidateCount,
    error,
    startedAt,
    completedAt,
    durationMs,
    observedAt,
  };
}

function recordProviderObservation(factualObservations = {}, observation) {
  const current = factualObservations.availability?.providers ?? [];
  const providers = current.filter((entry) => entry.providerId !== observation.providerId);
  providers.push(observation);
  return {
    ...factualObservations,
    availability: {
      ...(factualObservations.availability ?? {}),
      providers,
        acquisitionFailures: providers
        .filter((entry) => entry.status === 'failed' || entry.status === 'timed_out' || entry.status === 'cancelled')
        .map((entry) => ({
          providerId: entry.providerId,
          code: entry.error?.code ?? 'PROVIDER_ACQUISITION_FAILED',
          message: entry.error?.message ?? 'Provider acquisition failed',
          observedAt: entry.observedAt,
        })),
    },
  };
}

async function observeConfiguredAvailabilityProviders(state, {
  providerFetchers = runtimeProviderFetchers(),
  availabilityOptions = {},
  candidateBuilder = buildCandidates,
  providerTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS ?? 12000),
  susfProviderTimeoutMs = null,
  signal = null,
} = {}) {
  const current = validateAgentState(state);
  const providerScope = normalizeProviderScope(current.searchScope.providerScope);
  let nextProviderScope = providerScope;
  let factualObservations = current.factualObservations;
  let candidates = current.candidates;

  const providerIdsToFetch = providerScope.activeProviderIds
    .filter((providerId) => !providerScope.observedProviderIds.includes(providerId)
      && !providerScope.failedProviderIds.includes(providerId));

  for (const providerId of providerIdsToFetch) {
    const fetchAvailability = providerFetchers[providerId];
    if (!fetchAvailability) {
      const observation = providerObservation(providerId, {
        status: 'failed',
        error: {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: `No availability fetcher is configured for provider ${providerId}`,
        },
      });
      factualObservations = recordProviderObservation(factualObservations, observation);
      nextProviderScope = markProviderObserved(nextProviderScope, providerId, { failed: true });
      continue;
    }

    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    if (signal?.aborted) {
      factualObservations = recordProviderObservation(factualObservations, providerObservation(providerId, {
        status: 'cancelled',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        error: {
          code: 'PROVIDER_CANCELLED',
          message: 'Provider acquisition was cancelled before it started.',
        },
      }));
      nextProviderScope = markProviderObserved(nextProviderScope, providerId, { failed: true });
      continue;
    }

    try {
      const availability = await fetchAvailabilityVariants(fetchAvailability, availabilityOptions[providerId] ?? availabilityOptions, {
        providerTimeoutMs: timeoutMsForProvider(providerId, { providerTimeoutMs, susfProviderTimeoutMs }),
        signal,
      });
      const newCandidates = candidateBuilder(availability);
      candidates = mergeCandidates(candidates, newCandidates);
      factualObservations = recordProviderObservation(factualObservations, providerObservation(providerId, {
        status: 'success',
        candidateCount: newCandidates.length,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
      }));
      nextProviderScope = markProviderObserved(nextProviderScope, providerId);
    } catch (error) {
      const partialAvailability = Array.isArray(error.availability) ? error.availability : [];
      const partialCandidates = candidateBuilder(partialAvailability);
      candidates = mergeCandidates(candidates, partialCandidates);
      const status = error.code === 'PROVIDER_TIMEOUT'
        ? 'timed_out'
        : error.code === 'PROVIDER_CANCELLED' || error.name === 'AbortError' ? 'cancelled' : 'failed';
      factualObservations = recordProviderObservation(factualObservations, providerObservation(providerId, {
        status,
        candidateCount: partialCandidates.length,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        error: {
          code: error.code ?? 'PROVIDER_ACQUISITION_FAILED',
          message: error.message,
        },
      }));
      nextProviderScope = markProviderObserved(nextProviderScope, providerId, { failed: true });
    }
  }

  return validateAgentState({
    ...current,
    candidates,
    factualObservations,
    searchScope: {
      ...current.searchScope,
      providerScope: nextProviderScope,
    },
  });
}

function timeoutMsForProvider(providerId, {
  providerTimeoutMs,
  susfProviderTimeoutMs,
} = {}) {
  if (providerId === 'susf' && Number.isFinite(susfProviderTimeoutMs)) return susfProviderTimeoutMs;
  return providerTimeoutMs;
}

function providerBudgetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function fetchWithBudget(fetchAvailability, options, {
  providerTimeoutMs,
  signal,
} = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', abortFromParent, { once: true });
  let timeout = null;
  try {
    const timeoutPromise = Number.isFinite(providerTimeoutMs) && providerTimeoutMs > 0
      ? new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const timeoutError = providerBudgetError('PROVIDER_TIMEOUT', `Provider timed out after ${providerTimeoutMs}ms`);
          controller.abort(timeoutError);
          setTimeout(() => reject(timeoutError), 1500);
        }, providerTimeoutMs);
      })
      : null;
    const providerOptions = {
      ...(options ?? {}),
      signal: controller.signal,
    };
    const fetchPromise = Promise.resolve(fetchAvailability(providerOptions));
    return timeoutPromise ? await Promise.race([fetchPromise, timeoutPromise]) : await fetchPromise;
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason?.code === 'PROVIDER_TIMEOUT') {
      const timeoutError = providerBudgetError('PROVIDER_TIMEOUT', controller.signal.reason.message);
      if (Array.isArray(error.availability)) timeoutError.availability = error.availability;
      throw timeoutError;
    }
    if (signal?.aborted || controller.signal.aborted && controller.signal.reason?.code === 'PROVIDER_CANCELLED') {
      throw providerBudgetError('PROVIDER_CANCELLED', 'Provider acquisition was cancelled.');
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abortFromParent);
  }
}

export {
  DEFAULT_PROVIDER_FETCHERS,
  SNAPSHOT_PROVIDER_FETCHERS,
  mergeCandidates,
  observeConfiguredAvailabilityProviders,
};
