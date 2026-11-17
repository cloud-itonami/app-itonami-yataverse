// Awai Drive pack protocol, as the Drive app speaks it (network-awai/awai-os
// apps/drive/src/sync.js and docs/encrypted-sync.md):
//   PUT /awai-drive/v1/packs/<sha256>   Content-Type: application/vnd.ipld.car, no query, no
//                                       credentials -> 200 JSON receipt {sha256, bytes}
//   GET /awai-drive/v1/packs/<sha256>   the same bytes
// The id is the SHA-256 of the exact pack bytes; packs are encrypted CAR snapshots.
//
// Owner decision 2026-11-18: no authentication (Drive sends none). Writes are limited
// instead: the body must hash to the id, stay within DRIVE_MAX_PACK_BYTES (12 MiB) and be a
// well-formed CAR whose blocks all hash to their CIDs. Anyone can still store opaque packs
// within those limits; that residual risk is tracked in Linear (AWAI-3126).
//
// CORS: only origins in DRIVE_ALLOWED_ORIGINS (default http://tauri.localhost, the Android
// WebView origin of the Drive app) get Access-Control-Allow-Origin. CORS restricts which web
// pages can read responses; it is not access control against non-browser clients.
import crypto from 'node:crypto';
import { parseCar, CarError, CAR_CONTENT_TYPE } from '../../src/car.mjs';
import { verifyBlock } from '../../src/cid.mjs';

export const DRIVE_PACK_PATH = /^\/awai-drive\/v1\/packs\/([a-f0-9]{64})$/;
export const DEFAULT_DRIVE_MAX_PACK_BYTES = 12 * 1024 * 1024;
const DEFAULT_ORIGINS = 'http://tauri.localhost';

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

export async function handleDrivePack(request, id, env, store, { readCapped }) {
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
    const bytes = await readCapped(request, cap);
    if (!bytes) return reply(413, { error: 'pack-too-large' });
    if (sha256Hex(bytes) !== id) return reply(400, { error: 'pack-does-not-hash-to-id' });
    let car;
    try { car = parseCar(bytes); } catch (e) { if (e instanceof CarError) return reply(400, { error: e.code }); throw e; }
    for (const b of car.blocks) if (!verifyBlock(b.cid, b.bytes)) return reply(400, { error: 'pack-block-does-not-hash-to-cid' });
    const put = await store.putPack(id, bytes);
    if (put.status !== 200) return reply(502, { error: `store-write-failed-${put.status}` });
    const back = await store.getPack(id);
    if (back.status !== 200) return reply(502, { error: `readback-failed-${back.status}` });
    const again = await readCapped(back, cap);
    if (!again || again.length !== bytes.length || sha256Hex(again) !== id) return reply(502, { error: 'readback-mismatch' });
    return reply(200, { sha256: id, bytes: bytes.length });
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
