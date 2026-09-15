import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  searchScopeForProfileContext,
} from '../packages/agent/src/recommendation-service.mjs';
import { createGoogleMapsProvider } from '../packages/maps/src/index.mjs';
import { loadEnvFile, normalizePreferenceProfile } from '../packages/preferences/src/index.mjs';

const cases = [
  { id: 'loc-01-baohuo', raw: '宝活附近' },
  { id: 'loc-02-near-central', raw: 'near Central' },
  { id: 'loc-03-usyd', raw: 'USYD' },
  { id: 'loc-04-chatswood', raw: 'Chatswood' },
  { id: 'loc-05-unseen-landmark', raw: 'Queen Victoria Building Sydney' },
];

function profileFor(raw) {
  return normalizePreferenceProfile({
    version: 2,
    sourceText: raw,
    searchScope: {
      location: raw,
      sourceText: raw,
      source: 'user',
      isExplicit: true,
    },
    preferences: [],
    hardConstraints: [],
    objectives: [],
    unresolvedPreferences: [],
    transportPreference: {},
    weatherPreference: {},
  }, {
    sourceText: raw,
    updatedAt: new Date().toISOString(),
  });
}

function traceScope(raw, scope, error = null) {
  const target = scope?.targetLocation ?? null;
  return {
    raw,
    canonicalEntity: target?.canonicalName ?? null,
    entityType: target?.entityType ?? target?.kind ?? null,
    lat: target?.lat ?? null,
    lng: target?.lng ?? null,
    confidence: target?.confidence ?? null,
    source: target?.source ?? null,
    placeId: target?.placeId ?? null,
    providerMetadata: target?.providerMetadata ?? null,
    searchScope: scope ? {
      locationSource: scope.locationSource ?? null,
      radiusMeters: scope.radiusMeters ?? null,
      routingStatus: scope.locationRouting?.status ?? null,
      activeProviderIds: scope.providerScope?.activeProviderIds ?? [],
    } : null,
    providerRouting: scope?.locationRouting ?? null,
    usesStaticFallback: target?.source === 'static_location_alias' || target?.source === 'configured_venue_suburb',
    usesGeocoder: target?.source === 'google_geocoding' || target?.providerMetadata?.provider === 'google_geocoding',
    error,
  };
}

await loadEnvFile();
const configured = Boolean(process.env.GOOGLE_MAPS_API_KEY);
let mapsProvider = null;
let setupError = null;
try {
  mapsProvider = createGoogleMapsProvider();
} catch (error) {
  setupError = { code: error.code ?? error.name, message: error.message };
}

const results = [];
for (const item of cases) {
  try {
    const scope = await searchScopeForProfileContext(profileFor(item.raw), { mapsProvider });
    results.push({ id: item.id, ...traceScope(item.raw, scope) });
  } catch (error) {
    results.push({
      id: item.id,
      ...traceScope(item.raw, null, { code: error.code ?? error.name, message: error.message }),
    });
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  configured,
  setupError,
  total: results.length,
  geocoderResolved: results.filter((item) => item.usesGeocoder).length,
  staticFallbacks: results.filter((item) => item.usesStaticFallback).length,
};

const output = { summary, results };
const outputPath = resolve('eval/location-smoke-results.json');
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Location smoke: geocoder ${configured ? 'configured' : 'not configured'}, ${summary.geocoderResolved}/${summary.total} geocoder-resolved.`);
console.log(`JSON: ${outputPath}`);
