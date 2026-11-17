// yataverse.com bytes-plane Worker: verified block reads and authenticated block writes,
// with Backblaze B2 (S3-compatible API) as the block store.
//
//   GET|HEAD /ipfs/<cid>  read from B2; on a B2 miss, from READ_FALLBACK_URL if set.
//                          Bytes are served only after they hash to the CID.
//   PUT /ipfs/<cid>       Authorization: Bearer <write token>. CIDv1/raw/sha2-256 only.
//                          The body must hash to the CID; it is stored, read back from B2
//                          and verified again before 201 is returned.
//   GET /health           liveness, no configuration values.
//
// Configuration (see wrangler.jsonc): B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APP_KEY and
// WRITE_TOKEN_SHA256 are secrets. The Worker never follows a redirect and never logs a
// token, key or request body.
import crypto from 'node:crypto';
import { parseCid, verifyBlock, CODEC_RAW, SHA2_256 } from '../../src/cid.mjs';
import { signV4, regionFromEndpoint } from './sigv4.mjs';

export const DEFAULT_MAX_BLOCK_BYTES = 16 * 1024 * 1024;
const RAW = 'application/vnd.ipld.raw';
const B2_TIMEOUT_MS = 30_000;
const FALLBACK_TIMEOUT_MS = 15_000;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
const fail = (status, error, extra) => json(status, { error }, extra);
const hex = (bytes) => Buffer.from(bytes).toString('hex');

function maxBytes(env) {
  const n = Number(env.MAX_BLOCK_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BLOCK_BYTES;
}

/** Bearer token -> true when its SHA-256 is one of the configured hex digests. */
export function tokenAllowed(authorization, configured) {
  const m = /^Bearer ([\x21-\x7e]{16,512})$/.exec(authorization ?? '');
  if (!m || !configured) return false;
  const got = crypto.createHash('sha256').update(m[1]).digest();
  let ok = false;
  for (const h of String(configured).split(',').map((s) => s.trim().toLowerCase())) {
    if (!/^[0-9a-f]{64}$/.test(h)) continue;
    if (crypto.timingSafeEqual(got, Buffer.from(h, 'hex'))) ok = true;
  }
  return ok;
}

async function readCapped(res, cap) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) return null;
  const chunks = []; let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

function b2(env, deps) {
  const missing = ['B2_ENDPOINT', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APP_KEY'].filter((k) => !env[k]);
  if (missing.length) return null;
  const endpoint = new URL(env.B2_ENDPOINT);
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/') return null;
  const region = env.B2_REGION || regionFromEndpoint(env.B2_ENDPOINT);
  if (!region) return null;
  const prefix = env.B2_PREFIX ?? 'ipld/';
  const objectUrl = (cid) => new URL(`/${env.B2_BUCKET}/${prefix}${cid}`, endpoint).toString();
  const call = (method, cid, { body, payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', headers = {} } = {}) => {
    const url = objectUrl(cid);
    const signed = signV4({ method, url, headers, payloadHash, keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY, region, now: deps.now() });
    return deps.fetchImpl(url, { method, headers: signed, body, redirect: 'manual', signal: AbortSignal.timeout(B2_TIMEOUT_MS) });
  };
  return {
    get: (cid) => call('GET', cid),
    // Content-Length is left to fetch (it is derived from the body) and is not signed.
    put: (cid, bytes, digestHex) => call('PUT', cid, { body: bytes, payloadHash: digestHex,
      headers: { 'content-type': 'application/octet-stream' } }),
  };
}

function serveBlock(cid, bytes, head) {
  return new Response(head ? null : bytes, { status: 200, headers: {
    'content-type': RAW, 'content-length': String(bytes.length),
    'cache-control': 'public, max-age=31536000, immutable', etag: `"${cid}"`,
    'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="${cid}.bin"`,
  } });
}

async function readBlock(cid, env, deps, store) {
  const cap = maxBytes(env);
  const res = await store.get(cid);
  if (res.status === 200) {
    const bytes = await readCapped(res, cap);
    if (!bytes) return { error: [502, 'stored-block-too-large'] };
    if (!verifyBlock(cid, bytes)) return { error: [502, 'stored-block-does-not-hash-to-cid'] };
    return { bytes };
  }
  if (res.status !== 404) return { error: [502, `store-read-failed-${res.status}`] };
  if (!env.READ_FALLBACK_URL) return { absent: true };
  const fb = new URL(env.READ_FALLBACK_URL);
  if (fb.protocol !== 'https:') return { error: [500, 'read-fallback-not-https'] };
  const url = new URL(`/ipfs/${cid}?format=raw`, fb);
  let r;
  try {
    r = await deps.fetchImpl(url.toString(), { headers: { accept: RAW }, redirect: 'manual', signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS) });
  } catch { return { error: [504, 'read-fallback-unreachable'] }; }
  if (r.status === 404) return { absent: true };
  if (r.status !== 200) return { error: [502, `read-fallback-failed-${r.status}`] };
  const bytes = await readCapped(r, cap);
  if (!bytes) return { error: [502, 'read-fallback-too-large'] };
  if (!verifyBlock(cid, bytes)) return { error: [502, 'read-fallback-does-not-hash-to-cid'] };
  return { bytes };
}

async function writeBlock(request, cid, parsed, env, deps, store) {
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim() !== RAW) return fail(415, 'content-type-must-be-ipld-raw');
  if (!env.WRITE_TOKEN_SHA256) return fail(503, 'writes-not-configured');
  if (!tokenAllowed(request.headers.get('authorization'), env.WRITE_TOKEN_SHA256))
    return fail(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
  if (parsed.version !== 1 || parsed.codec !== CODEC_RAW || parsed.hashCode !== SHA2_256) return fail(400, 'put-requires-cidv1-raw-sha2-256');
  const cap = maxBytes(env);
  const bytes = await readCapped(request, cap);
  if (!bytes) return fail(413, 'too-large');
  if (!verifyBlock(cid, bytes)) return fail(400, 'bytes-do-not-hash-to-cid');
  const digestHex = hex(parsed.digest);
  const put = await store.put(cid, bytes, digestHex);
  if (put.status !== 200) return fail(502, `store-write-failed-${put.status}`);
  const back = await store.get(cid);
  if (back.status !== 200) return fail(502, `readback-failed-${back.status}`);
  const again = await readCapped(back, cap);
  if (!again || !verifyBlock(cid, again)) return fail(502, 'readback-does-not-hash-to-cid');
  return json(201, { cid, bytes: bytes.length, verified: true });
}

export async function handle(request, env, deps = {}) {
  // Call the global fetch unbound: Workers throws "Illegal invocation" when fetch runs
  // with another object as `this` (as `deps.fetchImpl(...)` would).
  deps = { fetchImpl: (input, init) => fetch(input, init), now: () => new Date(), ...deps };
  const url = new URL(request.url);
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method-not-allowed', { allow: 'GET, HEAD' });
    return json(200, { ok: true, service: 'yataverse-bytes' });
  }
  const m = /^\/ipfs\/([A-Za-z0-9]+)$/.exec(url.pathname);
  if (!m) return fail(404, 'not-found');
  const cid = m[1];
  const parsed = parseCid(cid);
  if (!parsed || parsed.hashCode !== SHA2_256) return fail(400, 'bad-cid');
  const store = b2(env, deps);
  if (!store) return fail(503, 'store-not-configured');
  try {
    if (request.method === 'PUT') return await writeBlock(request, cid, parsed, env, deps, store);
    if (request.method === 'GET' || request.method === 'HEAD') {
      const r = await readBlock(cid, env, deps, store);
      if (r.error) return fail(...r.error);
      if (r.absent) return fail(404, 'block-not-found');
      return serveBlock(cid, r.bytes, request.method === 'HEAD');
    }
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return fail(504, 'store-timeout');
    // Name and message only: neither carries a token, key or request body.
    console.error('store-unreachable', e?.name, String(e?.message ?? '').slice(0, 300));
    return fail(502, 'store-unreachable');
  }
  return fail(405, 'method-not-allowed', { allow: 'GET, HEAD, PUT' });
}

export default { fetch: (request, env) => handle(request, env) };
