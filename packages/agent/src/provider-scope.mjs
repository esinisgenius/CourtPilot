const DEFAULT_PROVIDER_REGISTRY = Object.freeze([
  {
    id: 'susf',
    provider: 'SUSF',
    displayName: 'Sydney Uni Sport tennis courts',
    stage: 'expanded',
    enabled: true,
  },
  {
    id: 'bookable',
    provider: 'bookable',
    displayName: 'Configured Bookable tennis venues',
    stage: 'expanded',
    enabled: true,
  },
  {
    id: 'unified-bookings',
    provider: 'unified-bookings',
    displayName: 'Configured Unified Bookings tennis venues',
    stage: 'expanded',
    enabled: true,
  },
  {
    id: 'sportlogic',
    provider: 'sportlogic',
    displayName: 'Configured TennisVenues SportLogic tennis venues',
    stage: 'expanded',
    enabled: true,
  },
  {
    id: 'intrac',
    provider: 'intrac',
    displayName: 'Configured Intrac tennis venues',
    stage: 'expanded',
    enabled: true,
  },
]);

function enabledProviderIds(registry = DEFAULT_PROVIDER_REGISTRY, stage) {
  return registry
    .filter((source) => source.enabled !== false && (!stage || source.stage === stage))
    .map((source) => source.id);
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function normalizeProviderScope(providerScope = {}, {
  registry = DEFAULT_PROVIDER_REGISTRY,
} = {}) {
  const initialProviderIds = unique(providerScope.initialProviderIds ?? enabledProviderIds(registry, 'initial'));
  const expandableProviderIds = unique(providerScope.expandableProviderIds ?? enabledProviderIds(registry));
  const activeProviderIds = unique(providerScope.activeProviderIds ?? initialProviderIds);
  const observedProviderIds = unique(providerScope.observedProviderIds);
  const failedProviderIds = unique(providerScope.failedProviderIds);

  return {
    ...providerScope,
    initialProviderIds,
    expandableProviderIds,
    activeProviderIds,
    observedProviderIds,
    failedProviderIds,
    scopeStatus: activeProviderIds.some((id) => expandableProviderIds.includes(id)) ? 'expanded' : 'initial',
  };
}

function nextExpandableProviderId(providerScope = {}, options = {}) {
  const scope = normalizeProviderScope(providerScope, options);
  return scope.expandableProviderIds.find((id) => !scope.activeProviderIds.includes(id)
    && !scope.observedProviderIds.includes(id)
    && !scope.failedProviderIds.includes(id)) ?? null;
}

function canExpandProviderScope(providerScope = {}, options = {}) {
  return nextExpandableProviderId(providerScope, options) !== null;
}

function markProviderObserved(providerScope = {}, providerId, { failed = false } = {}) {
  const scope = normalizeProviderScope(providerScope);
  return normalizeProviderScope({
    ...scope,
    observedProviderIds: unique([...scope.observedProviderIds, providerId]),
    failedProviderIds: failed ? unique([...scope.failedProviderIds, providerId]) : scope.failedProviderIds,
  });
}

export {
  DEFAULT_PROVIDER_REGISTRY,
  canExpandProviderScope,
  markProviderObserved,
  nextExpandableProviderId,
  normalizeProviderScope,
};
