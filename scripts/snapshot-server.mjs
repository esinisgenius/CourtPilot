import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { loadProviderSnapshots } from '../packages/availability-snapshots/src/store.mjs';

const host = process.env.SNAPSHOT_SERVER_HOST ?? '127.0.0.1';
const port = Number(process.env.SNAPSHOT_SERVER_PORT ?? 8787);
const token = process.env.AVAILABILITY_SNAPSHOT_TOKEN;

if (!token) throw new Error('AVAILABILITY_SNAPSHOT_TOKEN is required');

function authorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

const server = createServer(async (request, response) => {
  try {
    if (!authorized(request)) {
      sendJson(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url, `http://${host}:${port}`);
    if (request.method === 'GET' && url.pathname === '/snapshots') {
      const providerId = url.searchParams.get('providerId');
      if (!providerId) {
        sendJson(response, 400, { ok: false, error: 'providerId is required' });
        return;
      }
      const snapshots = await loadProviderSnapshots(providerId);
      sendJson(response, 200, { ok: true, snapshots });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.code ?? error.name ?? 'server_error' });
  }
});

server.listen(port, host, () => {
  console.log(`CourtPilot snapshot server listening at http://${host}:${port}`);
});
