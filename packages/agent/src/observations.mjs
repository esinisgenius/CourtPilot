import { getBookableAvailability } from '../../bookable/src/index.mjs';
import { buildCandidates } from '../../core/src/index.mjs';
import { getSusfAvailability } from '../../susf/src/index.mjs';
import { getIntracAvailability } from '../../intrac/src/index.mjs';
import { getSportLogicAvailability } from '../../sportlogic/src/index.mjs';
import { getUnifiedBookingsAvailability } from '../../unified-bookings/src/index.mjs';
import { markProviderObserved, normalizeProviderScope } from './provider-scope.mjs';
import { validateAgentState } from './state.mjs';

const DEFAULT_PROVIDER_FETCHERS = Object.freeze({
  susf: getSusfAvailability,
  bookable: getBookableAvailability,
  'unified-bookings': getUnifiedBookingsAvailability,
  sportlogic: getSportLogicAvailability,
  intrac: getIntracAvailability,
});

function mergeCandidates(existingCandidates, newCandidates) {
  const byId = new Map();
  for (const candidate of [...existingCandidates, ...newCandidates]) {
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort((a, b) => `${a.startTime} ${a.venue} ${a.court}`.localeCompare(`${b.startTime} ${b.venue} ${b.court}`));
}

function providerObservation(providerId, { status, candidateCount = 0, error = null, observedAt = new Date().toISOString() }) {
  return {
    providerId,
    status,
    candidateCount,
    error,
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
        .filter((entry) => entry.status === 'failed')
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
  providerFetchers = DEFAULT_PROVIDER_FETCHERS,
  availabilityOptions = {},
  candidateBuilder = buildCandidates,
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

    try {
      const availability = await fetchAvailability(availabilityOptions[providerId] ?? availabilityOptions);
      const newCandidates = candidateBuilder(availability);
      candidates = mergeCandidates(candidates, newCandidates);
      factualObservations = recordProviderObservation(factualObservations, providerObservation(providerId, {
        status: 'success',
        candidateCount: newCandidates.length,
      }));
      nextProviderScope = markProviderObserved(nextProviderScope, providerId);
    } catch (error) {
      const partialAvailability = Array.isArray(error.availability) ? error.availability : [];
      const partialCandidates = candidateBuilder(partialAvailability);
      candidates = mergeCandidates(candidates, partialCandidates);
      factualObservations = recordProviderObservation(factualObservations, providerObservation(providerId, {
        status: 'failed',
        candidateCount: partialCandidates.length,
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

export {
  DEFAULT_PROVIDER_FETCHERS,
  mergeCandidates,
  observeConfiguredAvailabilityProviders,
};
