// A tiny fake origin: serves files, /api/update/version and /api/update/info,
// computing the same 32-char sha256 hashes the CLI emits.
import { createHash } from 'node:crypto';

export const hash32 = (body) => createHash('sha256').update(body).digest('hex').slice(0, 32);
export const hash8 = hash32;

export function makeServer(version, files, minVersion = null) {
  const state = { version, minVersion, files: { ...files }, calls: [], broken: new Set(), lie: new Map() };
  state.set = (v, f, m = null) => { state.version = v; state.files = { ...f }; if (m) state.minVersion = m; };
  state.fetch = async (r) => {
    const path = new URL(r.url).pathname;
    state.calls.push(path);
    if (path === '/api/update/version' || path === '/api/update/version.json') {
      const body = { version: state.version };
      if (state.sequence !== undefined) body.sequence = state.sequence;
      if (state.minVersion) body.minVersion = state.minVersion;
      if (state.blockedVersions) body.blockedVersions = state.blockedVersions;
      if (state.rolloutPercent !== undefined) body.rolloutPercent = state.rolloutPercent;
      if (state.channel) body.channel = state.channel;
      if (state.versionSignature) body.signature = state.versionSignature;
      else if (state.signature && !state.files) body.signature = state.signature;
      return Response.json(body);
    }
    if (path === '/api/update/info' || path === '/api/update/info.json') {
      const body = {
        version: state.version,
        // `lie` lets a test advertise a hash that doesn't match the served bytes
        files: Object.entries(state.files).map(([p, body]) => ({
          path: p,
          hash: state.lie.get(p) ?? hash8(body),
          size: Buffer.byteLength(String(body)),
        })),
      };
      if (state.sequence !== undefined) body.sequence = state.sequence;
      if (state.minVersion) body.minVersion = state.minVersion;
      if (state.blockedVersions) body.blockedVersions = state.blockedVersions;
      if (state.rolloutPercent !== undefined) body.rolloutPercent = state.rolloutPercent;
      if (state.channel) body.channel = state.channel;
      if (state.signature) body.signature = state.signature;
      return Response.json(body);
    }
    if (state.broken.has(path)) return new Response('nope', { status: 404 });
    if (path in state.files) {
      const content = String(state.files[path]);
      return new Response(content, {
        headers: { 'Content-Length': String(Buffer.byteLength(content)) },
      });
    }
    return new Response('not found', { status: 404 });
  };
  state.fileCalls = () => state.calls.filter((p) => p !== '/api/update/version' && p !== '/api/update/version.json' && p !== '/api/update/info' && p !== '/api/update/info.json');
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
