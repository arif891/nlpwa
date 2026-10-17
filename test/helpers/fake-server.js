// A tiny fake origin: serves files, /api/update/version and /api/update/info,
// computing the same 8-char sha256 hashes the CLI emits.
import { createHash } from 'node:crypto';

export const hash8 = (body) => createHash('sha256').update(body).digest('hex').slice(0, 8);

export function makeServer(version, files) {
  const state = { version, files: { ...files }, calls: [], broken: new Set(), lie: new Map() };
  state.set = (v, f) => { state.version = v; state.files = { ...f }; };
  state.fetch = async (r) => {
    const path = new URL(r.url).pathname;
    state.calls.push(path);
    if (path === '/api/update/version' || path === '/api/update/version.json') return Response.json({ version: state.version });
    if (path === '/api/update/info' || path === '/api/update/info.json') {
      return Response.json({
        version: state.version,
        // `lie` lets a test advertise a hash that doesn't match the served bytes
        files: Object.entries(state.files).map(([p, body]) => ({ path: p, hash: state.lie.get(p) ?? hash8(body) })),
      });
    }
    if (state.broken.has(path)) return new Response('nope', { status: 404 });
    if (path in state.files) return new Response(state.files[path]);
    return new Response('not found', { status: 404 });
  };
  state.fileCalls = () => state.calls.filter((p) => !p.startsWith('/api/'));
  return state;
}

/** Install a fake `self` with a client that records postMessage calls. */
export function fakeSelf() {
  const messages = [];
  globalThis.self = {
    location: { origin: 'https://example.com', href: 'https://example.com/sw.js' },
    clients: { matchAll: async () => [{ postMessage: (m) => messages.push(m) }] },
  };
  return messages;
}
