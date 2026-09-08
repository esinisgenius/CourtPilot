#!/usr/bin/env node
import {
  MAPS_ERROR_CODES,
  createGoogleMapsProvider,
  resolveLocation,
} from '../packages/maps/src/index.mjs';

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: npm run maps:resolve -- "USYD"');
  process.exit(1);
}

try {
  const provider = createGoogleMapsProvider();
  const location = await resolveLocation({ type: 'user_text', query }, { provider });
  console.log(`label: ${location.label}`);
  console.log(`lat: ${location.lat}`);
  console.log(`lng: ${location.lng}`);
  console.log(`source: ${location.source}`);
} catch (error) {
  if (error.code === MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED) {
    console.error(`${MAPS_ERROR_CODES.MAPS_NOT_CONFIGURED}: GOOGLE_MAPS_API_KEY is not configured.`);
  } else {
    console.error(`${error.code ?? 'MAPS_RESOLVE_FAILED'}: ${error.message}`);
  }
  process.exitCode = 1;
}
