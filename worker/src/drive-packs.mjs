// Awai Drive pack protocol, as the Drive app speaks it (network-awai/awai-os
// apps/drive/src/sync.js and docs/encrypted-sync.md):
//   PUT /awai-drive/v1/packs/<sha256>   Content-Type: application/vnd.ipld.car, no query, no
//                                       credentials -> 200 JSON receipt {sha256, bytes}, plus the
//                                       signed storage receipt (`receipt`, `receiptCid`; Drive
//                                       does not check it yet, owner decision 2026-11-18)
//   GET /awai-drive/v1/packs/<sha256>   the same bytes
// The id is the SHA-256 of the exact pack bytes; packs are encrypted CAR snapshots.
//
// Owner decision 2026-11-18: no authentication (Drive sends none). Writes are limited
// instead: the body must hash to the id, stay within DRIVE_MAX_PACK_BYTES (12 MiB) and be a
// well-formed CAR whose blocks all hash to their CIDs. Anyone can still store opaque packs
// within those limits; that residual risk is tracked in Linear (AWAI-3126).
//
// CORS: only origins in DRIVE_ALLOWED_ORIGINS get Access-Control-Allow-Origin. The
// defaults are the exact Android and macOS Drive WebView origins. CORS restricts which web
// pages can read responses; it is not access control against non-browser clients.
import crypto from 'node:crypto';
import { parseCar, CarError, CAR_CONTENT_TYPE } from '../../src/car.mjs';
import { verifyBlock } from '../../src/cid.mjs';
import { KIND, ZERO32 } from '../../src/receipt.mjs';

export const DRIVE_PACK_PATH = /^\/awai-drive\/v1\/packs\/([a-f0-9]{64})$/;
export const DEFAULT_DRIVE_MAX_PACK_BYTES = 12 * 1024 * 1024;
const DEFAULT_ORIGINS = 'http://tauri.localhost,tauri://localhost';

const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

function corsHeaders(request, env) {
  const allowed = String(env.DRIVE_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  const h = { vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-methods'] = 'GET, PUT, OPTIONS';
    h['access-control-allow-headers'] = 'content-type';
    h['access-control-max-age'] = '600';
  }
  return h;
}

export async function handleDrivePack(request, id, env, store, { readCapped, admitWriteRequest, admitWriteBytes, receipts, requestIdOf }) {
  const cors = corsHeaders(request, env);
  const reply = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body),
    { status, headers: { ...cors, 'cache-control': 'no-store', ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers } });
  if (!id) return reply(404, { error: 'not-found' });
  const url = new URL(request.url);
  if (url.search) return reply(400, { error: 'query-not-allowed' });
  if (request.method === 'OPTIONS') return reply(204, null);
  if (!store) return reply(503, { error: 'store-not-configured' });
  const cap = Number.isInteger(Number(env.DRIVE_MAX_PACK_BYTES)) && Number(env.DRIVE_MAX_PACK_BYTES) > 0
    ? Number(env.DRIVE_MAX_PACK_BYTES) : DEFAULT_DRIVE_MAX_PACK_BYTES;

  if (request.method === 'PUT') {
    if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== CAR_CONTENT_TYPE)
      return reply(415, { error: 'content-type-must-be-ipld-car' });
    const limited = await admitWriteRequest(request, env);
    if (limited) return reply(limited[0], { error: limited[1] }, limited[2]);
    const bytes = await readCapped(request, cap);
    if (!bytes) return reply(413, { error: 'pack-too-large' });
    const overBytes = await admitWriteBytes(request, env, bytes.length);
    if (overBytes) return reply(overBytes[0], { error: overBytes[1] }, overBytes[2]);
    if (sha256Hex(bytes) !== id) return reply(400, { error: 'pack-does-not-hash-to-id' });
    let car;
    try { car = parseCar(bytes); } catch (e) { if (e instanceof CarError) return reply(400, { error: e.code }); throw e; }
    for (const b of car.blocks) if (!verifyBlock(b.cid, b.bytes)) return reply(400, { error: 'pack-block-does-not-hash-to-cid' });
    const digest = new Uint8Array(Buffer.from(id, 'hex'));
    const rid = requestIdOf(request, digest);
    if (rid.error) return reply(rid.error[0], { error: rid.error[1] });
    // No credentials, so requester is 0 (owner decision 2026-11-18; no IP hash).
    const claim = { kind: KIND.drivePack, subject: digest, size: bytes.length, contentDigest: digest, requestId: rid.requestId, requester: ZERO32 };
    const begun = await receipts.begin(claim);
    if (begun.error) return reply(begun.error[0], { error: begun.error[1] });
    const put = await store.putPack(id, bytes);
    if (put.status !== 200) return reply(502, { error: `store-write-failed-${put.status}` });
    const back = await store.getPack(id);
    if (back.status !== 200) return reply(502, { error: `readback-failed-${back.status}` });
    const again = await readCapped(back, cap);
    if (!again || again.length !== bytes.length || sha256Hex(again) !== id) return reply(502, { error: 'readback-mismatch' });
    const receipt = await receipts.finish(begun, claim);
    if (receipt.error) return reply(receipt.error[0], { error: receipt.error[1] });
    return reply(200, { sha256: id, bytes: bytes.length, receipt: receipt.json, receiptCid: receipt.cid });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const res = await store.getPack(id);
    if (res.status === 404) return reply(404, { error: 'pack-not-found' });
    if (res.status !== 200) return reply(502, { error: `store-read-failed-${res.status}` });
    const bytes = await readCapped(res, cap);
    if (!bytes || sha256Hex(bytes) !== id) return reply(502, { error: 'stored-pack-does-not-hash-to-id' });
    return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers: {
      ...cors, 'content-type': CAR_CONTENT_TYPE, 'content-length': String(bytes.length),
      'cache-control': 'public, max-age=31536000, immutable', etag: `"${id}"`, 'x-content-type-options': 'nosniff',
    } });
  }
  return reply(405, { error: 'method-not-allowed' }, { allow: 'GET, HEAD, PUT, OPTIONS' });
}

// --- E2EE packs (item 216): the same protocol, but only for callers who present a tenant
// Bearer token. The plaintext route above (owner decision 2026-11-18) is unchanged: anything
// that is not E2EE ciphertext stays on /awai-drive/v1/packs/<sha256> with no authentication.
// The two namespaces are separated by path AND by store key (e2ee-packs/<sha256> vs
// drive-packs/<sha256>), so a pack written to one never answers on the other. Decryption keys
// never reach this server: the ciphertext is E2EE by assumption and the server only checks the
// pack's shape, exactly as for plaintext packs.
//
// Auth: env.DRIVE_E2EE_TOKEN_SHA256 is a comma-separated list of SHA-256 hex digests of tenant
// Bearer tokens (same shape as WRITE_TOKEN_SHA256). Unset/empty fails closed with
// 503 e2ee-packs-not-configured rather than silently serving unauthenticated. OPTIONS preflight
// is answered without credentials (as on the plaintext route) so browsers can negotiate CORS;
// GET/HEAD/PUT all require the token.
export const DRIVE_E2EE_PACK_PATH = /^\/awai-drive\/v1\/e2ee-packs\/([a-f0-9]{64})$/;

function e2eeTokenAllowed(authorization, configured) {
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

export async function handleDriveE2eePack(request, id, env, store, deps) {
  if (request.method !== 'OPTIONS') {
    if (!store) return new Response(JSON.stringify({ error: 'store-not-configured' }),
      { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if (!id) return new Response(JSON.stringify({ error: 'not-found' }),
      { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if (!env.DRIVE_E2EE_TOKEN_SHA256) return new Response(JSON.stringify({ error: 'e2ee-packs-not-configured' }),
      { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if (!e2eeTokenAllowed(request.headers.get('authorization'), env.DRIVE_E2EE_TOKEN_SHA256))
      return new Response(JSON.stringify({ error: 'unauthorized' }),
        { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'www-authenticate': 'Bearer' } });
  }
  // Reuse the plaintext pack handler verbatim; only the store namespace differs.
  const e2eeStore = { ...store,
    getPack: (packId) => store.getE2eePack(packId),
    putPack: (packId, bytes) => store.putE2eePack(packId, bytes) };
  return handleDrivePack(request, id, env, e2eeStore, deps);
}
