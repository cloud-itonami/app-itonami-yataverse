// yataverse.com bytes-plane Worker: verified block reads and authenticated block writes,
// with Backblaze B2 (S3-compatible API) as the block store.
//
//   GET|HEAD /ipfs/<cid>  read from B2; on a B2 miss, from READ_FALLBACK_URL if set.
//                          Bytes are served only after they hash to the CID.
//   PUT /ipfs/<cid>       Authorization: Bearer <write token>. CIDv1/sha2-256 with codec raw or
//                          dag-cbor (canonical DAG-CBOR only). The body must hash to the CID; it is stored, read back from B2
//                          and verified again before 201 is returned.
//   GET /ipfs/<cid>?format=car (or Accept: application/vnd.ipld.car)
//                          CARv1, order=dfs, dups=n; dag-scope=all (default) or block.
//                          Every block is verified; an incomplete DAG is an error, never a
//                          truncated CAR.
//   POST /ipfs/           Authorization: Bearer <write token> or a person's ATProto service-auth
//                          JWT (lxm com.yataverse.importCar, service-auth.mjs), a CARv1 or CARv2 body. All
//                          blocks, roots and the closure are checked before anything is stored.
//   OPTIONS /ipfs, /ipfs/<cid>
//                          CORS preflight. Only origins in IPFS_ALLOWED_ORIGINS (default
//                          https://tauri.localhost, the Nagare WebView, AWAI-3274) are answered:
//                          POST on /ipfs, GET/HEAD on /ipfs/<cid>. Block PUT stays non-browser.
//   PUT|GET|HEAD|OPTIONS /awai-drive/v1/packs/<sha256>
//                          Awai Drive encrypted snapshot packs (see drive-packs.mjs).
//   GET /health           liveness, no configuration values.
//   GET /.well-known/yataverse-receipt-keys.json, /.well-known/did.json,
//       /.well-known/yataverse-policy/<revision>.json (and current.json)
//                          the receipt signing keys (did:web:yataverse.com) and the write policy.
//
// Every successful write returns a signed storage receipt (receipts.mjs): `receipt` (JSON
// envelope) and `receiptCid` (its DAG-CBOR record). An optional Yataverse-Request-Id header
// (64 hex) names the request; a repeat gets the same receipt, a different write under the
// same id is 409.
//
// Configuration (see wrangler.jsonc): B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APP_KEY and
// WRITE_TOKEN_SHA256 are secrets. The Worker never follows a redirect and never logs a
// token, key or request body.
import crypto from 'node:crypto';
import { parseCid, verifyBlock, cidToBytes, SHA2_256 } from '../../src/cid.mjs';
import { KIND, rootsCommitment, blockSetDigest } from '../../src/receipt.mjs';
import { beginReceipt, finishReceipt, requestIdOf, tokenDigest, wellKnown, sha256 } from './receipts.mjs';
import { checkWritableBlock } from '../../src/block.mjs';
import { parseCar, encodeCarV1, CarError, CAR_CONTENT_TYPE } from '../../src/car.mjs';
import { checkClosure, collectDag, DagError } from '../../src/dag.mjs';
import { handleDrivePack, DRIVE_PACK_PATH } from './drive-packs.mjs';
import { admitWriteRequest, admitWriteBytes } from './write-limits.mjs';
import { isServiceAuth, verifyServiceAuth, IMPORT_CAR_LXM } from './service-auth.mjs';
import { signV4, regionFromEndpoint } from './sigv4.mjs';

export const DEFAULT_MAX_BLOCK_BYTES = 16 * 1024 * 1024;
// Each imported block costs two store subrequests (PUT, readback GET) and each exported block
// one GET; keep a request well inside the platform's per-request subrequest limit.
export const DEFAULT_MAX_CAR_BLOCKS = 256;
export const DEFAULT_MAX_CAR_BYTES = 32 * 1024 * 1024;
const RAW = 'application/vnd.ipld.raw';
const B2_TIMEOUT_MS = 30_000;
const FALLBACK_TIMEOUT_MS = 15_000;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
const fail = (status, error, extra) => json(status, { error }, extra);
const hex = (bytes) => Buffer.from(bytes).toString('hex');

function intVar(v, dflt) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : dflt; }
const carLimits = (env) => ({ maxBlocks: intVar(env.MAX_CAR_BLOCKS, DEFAULT_MAX_CAR_BLOCKS), maxBytes: intVar(env.MAX_CAR_BYTES, DEFAULT_MAX_CAR_BYTES) });

/** The write limits this Worker enforces, recorded in the receipt policy. */
export function writeLimits(env) {
  const drive = Number(env.DRIVE_MAX_PACK_BYTES);
  return { maxBlockBytes: maxBytes(env), maxCarBytes: carLimits(env).maxBytes, maxCarBlocks: carLimits(env).maxBlocks,
           drivePackMaxBytes: Number.isInteger(drive) && drive > 0 ? drive : 12 * 1024 * 1024,
           perClient: { requestsPerMinute: 60, mibPerMinute: 64 } };
}

/** Receipt helpers bound to one request's env, deps and store. */
const receiptOps = (env, deps, store) => ({
  begin: (claim) => beginReceipt(claim, env, deps, store),
  finish: (begun, claim) => finishReceipt(begun, claim, env, deps, store, writeLimits(env)),
});

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
  // Object keys: blocks at <B2_PREFIX><cid>, Drive packs at <B2_PREFIX>drive-packs/<sha256>.
  // A block CID never contains '/', so the two namespaces cannot collide.
  const objectUrl = (key) => new URL(`/${env.B2_BUCKET}/${prefix}${key}`, endpoint).toString();
  const call = (method, key, { body, payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', headers = {} } = {}) => {
    const url = objectUrl(key);
    const signed = signV4({ method, url, headers, payloadHash, keyId: env.B2_KEY_ID, secret: env.B2_APP_KEY, region, now: deps.now() });
    return deps.fetchImpl(url, { method, headers: signed, body, redirect: 'manual', signal: AbortSignal.timeout(B2_TIMEOUT_MS) });
  };
  return {
    get: (cid) => call('GET', cid),
    head: (cid) => call('HEAD', cid),
    // Content-Length is left to fetch (it is derived from the body) and is not signed.
    put: (cid, bytes, digestHex) => call('PUT', cid, { body: bytes, payloadHash: digestHex,
      headers: { 'content-type': 'application/octet-stream' } }),
    getPack: (id) => call('GET', `drive-packs/${id}`),
    // Receipt records: <B2_PREFIX>receipts/by-request/<requestId hex>.
    getReceipt: (rid) => call('GET', `receipts/by-request/${rid}`),
    putReceipt: (rid, bytes) => call('PUT', `receipts/by-request/${rid}`, { body: bytes, payloadHash: hex(sha256(bytes)),
      headers: { 'content-type': 'application/vnd.ipld.dag-cbor' } }),
    putPack: (id, bytes) => call('PUT', `drive-packs/${id}`, { body: bytes, payloadHash: id,
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

const contentType = (request) => (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();

function writeAuthFailure(request, env) {
  if (!env.WRITE_TOKEN_SHA256) return fail(503, 'writes-not-configured');
  if (!tokenAllowed(request.headers.get('authorization'), env.WRITE_TOKEN_SHA256))
    return fail(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
  return null;
}

/** PUT one already-checked block, read it back and verify. -> null or [status, error]. */
async function storeBlock(cid, bytes, env, store) {
  const digestHex = hex(parseCid(cid).digest);
  const put = await store.put(cid, bytes, digestHex);
  if (put.status !== 200) return [502, `store-write-failed-${put.status}`];
  const back = await store.get(cid);
  if (back.status !== 200) return [502, `readback-failed-${back.status}`];
  const again = await readCapped(back, maxBytes(env));
  if (!again || !verifyBlock(cid, again)) return [502, 'readback-does-not-hash-to-cid'];
  return null;
}

async function writeBlock(request, cid, parsed, env, deps, store) {
  if (contentType(request) !== RAW) return fail(415, 'content-type-must-be-ipld-raw');
  const denied = writeAuthFailure(request, env);
  if (denied) return denied;
  if (parsed.version !== 1) return fail(400, 'put-requires-cidv1-sha2-256');
  const limited = await admitWriteRequest(request, env);
  if (limited) return fail(...limited);
  const bytes = await readCapped(request, maxBytes(env));
  if (!bytes) return fail(413, 'too-large');
  const overBytes = await admitWriteBytes(request, env, bytes.length);
  if (overBytes) return fail(...overBytes);
  const bad = checkWritableBlock(cid, bytes);
  if (bad) return fail(400, bad);
  const contentDigest = new Uint8Array(parsed.digest);
  const rid = requestIdOf(request, contentDigest);
  if (rid.error) return fail(...rid.error);
  const claim = { kind: KIND.block, subject: cidToBytes(cid), size: bytes.length, contentDigest,
                  requestId: rid.requestId, requester: tokenDigest(request.headers.get('authorization')) };
  const ops = receiptOps(env, deps, store);
  const begun = await ops.begin(claim);
  if (begun.error) return fail(...begun.error);
  const err = await storeBlock(cid, bytes, env, store);
  if (err) return fail(...err);
  const receipt = await ops.finish(begun, claim);
  if (receipt.error) return fail(...receipt.error);
  return json(201, { cid, bytes: bytes.length, verified: true, receipt: receipt.json, receiptCid: receipt.cid });
}

/**
 * POST /ipfs/ with a CAR body. Everything is checked before anything is stored: header,
 * each block's CID/codec/canonical form, roots present, closure complete (in the CAR or
 * already stored) and no unreachable blocks. Then each block is stored and read back.
 */
async function importCar(request, env, deps, store) {
  if (contentType(request) !== CAR_CONTENT_TYPE) return fail(415, 'content-type-must-be-ipld-car');
  // Two ways to write a CAR: a write token (WRITE_TOKEN_SHA256) or a person's ATProto service
  // auth (service-auth.mjs, AWAI-3274). Service auth needs network lookups, so it is checked
  // after the request is counted by the rate limiter.
  const authorization = request.headers.get('authorization');
  const viaServiceAuth = isServiceAuth(authorization);
  if (!viaServiceAuth) {
    const denied = writeAuthFailure(request, env);
    if (denied) return denied;
  }
  const limited = await admitWriteRequest(request, env);
  if (limited) return fail(...limited);
  let requester;
  if (viaServiceAuth) {
    const v = await verifyServiceAuth(authorization, IMPORT_CAR_LXM, env, deps);
    if (v.error) return fail(...v.error, v.error[0] === 401 ? { 'www-authenticate': 'Bearer' } : {});
    requester = sha256(v.did);
  } else requester = tokenDigest(authorization);
  const limits = carLimits(env);
  const body = await readCapped(request, limits.maxBytes);
  if (!body) return fail(413, 'car-too-large');
  const overBytes = await admitWriteBytes(request, env, body.length);
  if (overBytes) return fail(...overBytes);
  let car;
  try { car = parseCar(body, { maxBlocks: limits.maxBlocks }); }
  catch (e) { if (e instanceof CarError) return fail(e.code === 'car-too-many-blocks' ? 413 : 400, e.code); throw e; }
  const blocks = new Map();
  for (const { cid, bytes } of car.blocks) {
    if (bytes.length > maxBytes(env)) return fail(413, `block-too-large:${cid}`);
    const bad = checkWritableBlock(cid, bytes);
    if (bad) return fail(400, `${bad}:${cid}`);
    blocks.set(cid, bytes);
  }
  for (const r of car.roots) if (!blocks.has(r)) return fail(400, `car-root-missing:${r}`);
  let closure;
  try {
    closure = await checkClosure(car.roots, blocks, async (cid) => {
      const r = await store.head(cid);
      if (r.status === 200) return true;
      if (r.status === 404) return false;
      throw new DagError(`store-head-failed-${r.status}`, cid);
    });
  } catch (e) { if (e instanceof DagError) return fail(e.code.startsWith('store-') ? 502 : 400, `${e.code}:${String(e.message).split(': ')[1] ?? ''}`); throw e; }
  let total = 0;
  for (const bytes of blocks.values()) total += bytes.length;
  const contentDigest = blockSetDigest([...blocks.keys(), ...closure.external]);
  const rid = requestIdOf(request, contentDigest);
  if (rid.error) return fail(...rid.error);
  const claim = { kind: KIND.car, subject: rootsCommitment(car.roots), size: total, contentDigest,
                  requestId: rid.requestId, requester };
  const ops = receiptOps(env, deps, store);
  const begun = await ops.begin(claim);
  if (begun.error) return fail(...begun.error);
  for (const [cid, bytes] of blocks) {
    const err = await storeBlock(cid, bytes, env, store);
    if (err) return fail(err[0], `${err[1]}:${cid}`);
  }
  const receipt = await ops.finish(begun, claim);
  if (receipt.error) return fail(...receipt.error);
  return json(201, { roots: car.roots, carVersion: car.version, blocks: blocks.size, bytes: total,
                     external: closure.external, verified: true, receipt: receipt.json, receiptCid: receipt.cid });
}

/** GET /ipfs/<root>?format=car: a CARv1 (order=dfs, dups=n) of the root's DAG or just the root. */
async function exportCar(cid, url, env, deps, store, head) {
  const scope = url.searchParams.get('dag-scope') ?? 'all';
  if (scope !== 'all' && scope !== 'block') return fail(400, 'dag-scope-not-supported');
  if (url.searchParams.has('entity-bytes')) return fail(400, 'entity-bytes-not-supported');
  let blocks;
  try {
    blocks = await collectDag(cid, scope, async (c) => {
      const r = await readBlock(c, env, deps, store);
      if (r.error) throw new DagError(`read-failed:${r.error[1]}`, c);
      return r.absent ? null : r.bytes;
    }, carLimits(env));
  } catch (e) {
    if (!(e instanceof DagError)) throw e;
    const detail = String(e.message).split(': ')[1] ?? '';
    if (e.code === 'root-not-found') return fail(404, 'block-not-found');
    if (e.code.startsWith('read-failed:')) return fail(502, `${e.code.slice(12)}:${detail}`);
    if (e.code === 'closure-incomplete') return fail(502, `closure-incomplete:${detail}`);
    return fail(422, `${e.code}:${detail}`);
  }
  const car = encodeCarV1([cid], blocks);
  return new Response(head ? null : car, { status: 200, headers: {
    'content-type': `${CAR_CONTENT_TYPE}; version=1; order=dfs; dups=n`, 'content-length': String(car.length),
    'cache-control': 'public, max-age=31536000, immutable', etag: `"${cid}.car.${scope}"`, vary: 'accept',
    'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="${cid}.car"`,
  } });
}

function wantsCar(request, url) {
  const format = url.searchParams.get('format');
  if (format === 'car') return true;
  if (format === 'raw') return false;
  if (format) return null;
  return (request.headers.get('accept') ?? '').toLowerCase().includes(CAR_CONTENT_TYPE);
}

// ---- CORS for /ipfs (AWAI-3274) ----------------------------------------------------------
// CORS decides which web pages may read a response; it is not access control against other
// clients. Writes still need a write token or service auth, and every byte is still checked
// against its CID.
// A write that carries an Origin header outside the list is refused before anything is read,
// so a page on another origin cannot use a token that leaked into it. Non-browser clients send
// no Origin and are unaffected.
export const DEFAULT_IPFS_ALLOWED_ORIGINS = 'https://tauri.localhost';

export function ipfsAllowedOrigins(env) {
  return String(env.IPFS_ALLOWED_ORIGINS ?? DEFAULT_IPFS_ALLOWED_ORIGINS).split(',').map((s) => s.trim())
    .filter((o) => { try { return new URL(o).origin === o; } catch { return false; } });
}

/** The CORS headers for one /ipfs response. `methods` are what this path answers in a browser. */
function ipfsCors(request, env, methods) {
  const origin = request.headers.get('origin');
  const h = { vary: 'Origin' };
  if (!origin || !ipfsAllowedOrigins(env).includes(origin)) return h;
  h['access-control-allow-origin'] = origin;
  h['access-control-allow-methods'] = methods;
  h['access-control-allow-headers'] = methods.includes('POST') ? 'authorization, content-type, yataverse-request-id' : 'accept';
  h['access-control-expose-headers'] = 'content-length, etag';
  h['access-control-max-age'] = '600';
  return h;
}

const originRefused = (request, env) => {
  const origin = request.headers.get('origin');
  return origin !== null && !ipfsAllowedOrigins(env).includes(origin);
};

function withHeaders(res, extra) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'vary') {
      const have = (headers.get('vary') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!have.some((x) => x.toLowerCase() === 'origin')) have.push(v);
      headers.set('vary', have.join(', '));
    } else headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Preflight: 204 with CORS headers for an allowed origin and method, otherwise 403. */
function ipfsPreflight(request, env, methods) {
  const cors = ipfsCors(request, env, methods);
  const asked = (request.headers.get('access-control-request-method') ?? '').toUpperCase();
  if (!cors['access-control-allow-origin'] || !methods.split(', ').includes(asked))
    return fail(403, 'cors-not-allowed', { vary: 'Origin', 'cache-control': 'no-store' });
  return new Response(null, { status: 204, headers: { ...cors, 'cache-control': 'no-store' } });
}

export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/ipfs' || url.pathname.startsWith('/ipfs/')) {
    const methods = (url.pathname === '/ipfs' || url.pathname === '/ipfs/') ? 'POST' : 'GET, HEAD';
    if (request.method === 'OPTIONS') return ipfsPreflight(request, env, methods);
    if ((request.method === 'POST' || request.method === 'PUT') && originRefused(request, env))
      return fail(403, 'origin-not-allowed', { vary: 'Origin' });
    return withHeaders(await handleCore(request, env, deps), ipfsCors(request, env, methods));
  }
  return handleCore(request, env, deps);
}

async function handleCore(request, env, deps = {}) {
  // Call the global fetch unbound: Workers throws "Illegal invocation" when fetch runs
  // with another object as `this` (as `deps.fetchImpl(...)` would).
  deps = { fetchImpl: (input, init) => fetch(input, init), now: () => new Date(), ...deps };
  const url = new URL(request.url);
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method-not-allowed', { allow: 'GET, HEAD' });
    return json(200, { ok: true, service: 'yataverse-bytes' });
  }
  if (url.pathname.startsWith('/.well-known/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method-not-allowed', { allow: 'GET, HEAD' });
    return wellKnown(url.pathname, env, writeLimits(env), json) ?? fail(404, 'not-found');
  }
  const pack = DRIVE_PACK_PATH.exec(url.pathname);
  if (pack || url.pathname.startsWith('/awai-drive/')) {
    try {
      const store = b2(env, deps);
      return await handleDrivePack(request, pack?.[1] ?? null, env, store, { readCapped, admitWriteRequest, admitWriteBytes, receipts: store && receiptOps(env, deps, store), requestIdOf });
    }
    catch (e) { return storeFailure(e); }
  }
  if (url.pathname === '/ipfs/' || url.pathname === '/ipfs') {
    if (request.method !== 'POST') return fail(405, 'method-not-allowed', { allow: 'POST, OPTIONS' });
    const store = b2(env, deps);
    if (!store) return fail(503, 'store-not-configured');
    try { return await importCar(request, env, deps, store); } catch (e) { return storeFailure(e); }
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
      const car = wantsCar(request, url);
      if (car === null) return fail(400, 'format-not-supported');
      if (car) return await exportCar(cid, url, env, deps, store, request.method === 'HEAD');
      const r = await readBlock(cid, env, deps, store);
      if (r.error) return fail(...r.error);
      if (r.absent) return fail(404, 'block-not-found');
      return serveBlock(cid, r.bytes, request.method === 'HEAD');
    }
  } catch (e) { return storeFailure(e); }
  return fail(405, 'method-not-allowed', { allow: 'GET, HEAD, PUT, OPTIONS' });
}

function storeFailure(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return fail(504, 'store-timeout');
  // Name and message only: neither carries a token, key or request body.
  console.error('store-unreachable', e?.name, String(e?.message ?? '').slice(0, 300));
  return fail(502, 'store-unreachable');
}

export default { fetch: (request, env) => handle(request, env) };
