// Owner-scoped E2EE pack fetch (design §1, §6–§8): CACAO + owner registry only.
//
//   PUT /awai-drive/v1/e2ee-packs/<sha256>   CACAO yataverse:e2ee:put:<sha256>
//   GET|HEAD /awai-drive/v1/e2ee-packs/<sha256>  CACAO yataverse:e2ee:get:<sha256>
//   POST /awai-drive/v1/e2ee-registry/register|cancel|revoke|batch-revoke
//   POST /awai-drive/v1/e2ee-heads/<headNameHex>  (sequence allocation + publish)
//
// The legacy unauthenticated route (/awai-drive/v1/packs/<sha256>, drive-packs.mjs)
// is untouched; e2ee bytes live in a separate store namespace (e2ee-packs/)
// so neither route can read the other's bytes. Authorization is the registry
// alone: CACAO_WRITER_DIDS is not consulted (verifyCacaoRegistered). With no
// registry configured every route fails closed with 503.
//
// PUT order (the sha256-only hole, design §1): CACAO -> bounded body ->
// sha256(body) == id -> well-formed CAR with blocks hashing to their CIDs ->
// store bytes -> readback verifies -> registry record. A record is never
// created before the bytes are verified in the store.
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { parseCar, CarError, CAR_CONTENT_TYPE } from '../../src/car.mjs';
import { verifyBlock } from '../../src/cid.mjs';
import { verifyCacaoRegistered, ed25519PubFromDidKey, e2eeGetResource, e2eePutResource, e2eeHeadResource } from './cacao-auth.mjs';
import { RegistryError, RECOVERY_WAIT_MS } from './e2ee-registry.mjs';

export const E2EE_PACK_PATH = /^\/awai-drive\/v1\/e2ee-packs\/([0-9a-f]{64})$/;
export const E2EE_REGISTRY_PREFIX = '/awai-drive/v1/e2ee-registry/';
export const E2EE_HEAD_PATH = /^\/awai-drive\/v1\/e2ee-heads\/([0-9a-f]{64})$/;
const DEFAULT_MAX = 12 * 1024 * 1024;
const DEFAULT_ORIGINS = 'http://tauri.localhost,tauri://localhost';

const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

function corsHeaders(request, env) {
  const allowed = String(env.DRIVE_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  const h = { vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-methods'] = 'GET, PUT, POST, OPTIONS';
    h['access-control-allow-headers'] = 'content-type, authorization';
    h['access-control-max-age'] = '600';
  }
  return h;
}

const regError = (e) => {
  if (e instanceof RegistryError) {
    const map = {
      'bad-owner': 400, 'bad-sha256': 400, 'bad-device-did': 400, 'bad-registration-kind': 400,
      'bad-head-seq': 400, 'registration-key-mismatch': 403, 'approver-not-registered': 403,
      'actor-not-registered': 403, 'device-not-registered': 404, 'device-not-found': 404,
      'pending-not-found': 404, 'pending-not-cancellable': 409, 'pack-size-mismatch': 409,
      'head-seq-rollback': 409, 'head-seq-conflict': 409, 'head-seq-not-allocated': 409,
    };
    return [map[e.code] ?? 400, e.code];
  }
  throw e;
};

/** Canonical string a registration approval signs (design §4). */
export const registrationMessage = (owner, deviceDid, approverDid) =>
  `yataverse:e2ee:register:${owner}:${deviceDid}:${approverDid}`;

function verifyApprovalSignature(body) {
  const { owner, deviceDid, approval } = body ?? {};
  if (!approval || typeof approval !== 'object') return 'bad-approval';
  const pub = ed25519PubFromDidKey(approval.approverDid);
  if (!pub) return 'bad-approval';
  if (typeof approval.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(approval.signature)) return 'bad-approval-signature';
  const sig = Buffer.from(approval.signature, 'base64url');
  if (sig.length !== 64 || sig.toString('base64url') !== approval.signature) return 'bad-approval-signature';
  let ok = false;
  try { ok = ed25519.verify(sig, Buffer.from(registrationMessage(owner, deviceDid, approval.approverDid), 'utf8'), pub); }
  catch { ok = false; }
  return ok ? null : 'bad-approval-signature';
}

export async function handleE2eePack(request, id, env, store, deps) {
  const { readCapped, admitWriteRequest, admitWriteBytes, registry } = deps;
  const cors = corsHeaders(request, env);
  const reply = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body),
    { status, headers: { ...cors, 'cache-control': 'private, no-store', ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers } });
  const notFound = () => reply(404, { error: 'pack-not-found' });
  if (!id) return notFound();
  const url = new URL(request.url);
  if (url.search) return reply(400, { error: 'query-not-allowed' });
  if (request.method === 'OPTIONS') return reply(204, null);
  if (!store || !registry) return reply(503, { error: 'e2ee-registry-not-configured' });
  const cap = Number.isInteger(Number(env.DRIVE_MAX_PACK_BYTES)) && Number(env.DRIVE_MAX_PACK_BYTES) > 0
    ? Number(env.DRIVE_MAX_PACK_BYTES) : DEFAULT_MAX;

  const auth = (resource) => {
    const v = verifyCacaoRegistered(request.headers.get('authorization'), resource, env, deps);
    if (v.error) {
      // Design §7: on this route a CACAO naming another pack id is answered
      // 404, so the route does not distinguish wrong-pack from not-yours.
      if (v.error[1] === 'cacao-resource-does-not-match-this-write') return { notFound: true };
      return { error: v.error };
    }
    return { did: v.did };
  };

  if (request.method === 'PUT') {
    if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== CAR_CONTENT_TYPE)
      return reply(415, { error: 'content-type-must-be-ipld-car' });
    const a = auth(e2eePutResource(id));
    if (a.error) return reply(a.error[0], { error: a.error[1] }, a.error[0] === 401 ? { 'www-authenticate': 'CACAO' } : {});
    if (a.notFound) return notFound();
    const owner = await registry.ownerOfDevice(a.did);
    if (!owner) return notFound();
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
    // Bytes first, readback second, registry record last (design §1).
    const put = await store.putE2eePack(id, bytes);
    if (put.status !== 200) return reply(502, { error: `store-write-failed-${put.status}` });
    const back = await store.getE2eePack(id);
    if (back.status !== 200) return reply(502, { error: `readback-failed-${back.status}` });
    const again = await readCapped(back, cap);
    if (!again || again.length !== bytes.length || sha256Hex(again) !== id) return reply(502, { error: 'readback-mismatch' });
    try { await registry.recordPack({ owner, deviceDid: a.did, sha256: id, size: bytes.length }); }
    catch (e) { const [status, code] = regError(e); return reply(status, { error: code }); }
    return reply(200, { sha256: id, bytes: bytes.length });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const a = auth(e2eeGetResource(id));
    if (a.error) return reply(a.error[0], { error: a.error[1] }, a.error[0] === 401 ? { 'www-authenticate': 'CACAO' } : {});
    if (a.notFound) return notFound();
    const gate = await registry.canFetch({ deviceDid: a.did, sha256: id });
    if (!gate) return notFound();
    const res = await store.getE2eePack(id);
    // A registry record without bytes (interrupted PUT) cannot be read.
    if (res.status === 404) return notFound();
    if (res.status !== 200) return reply(502, { error: `store-read-failed-${res.status}` });
    const bytes = await readCapped(res, cap);
    if (!bytes || sha256Hex(bytes) !== id) return reply(502, { error: 'stored-pack-does-not-hash-to-id' });
    return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers: {
      ...cors, 'content-type': CAR_CONTENT_TYPE, 'content-length': String(bytes.length),
      'cache-control': 'private, no-store', etag: `"${id}"`, 'x-content-type-options': 'nosniff',
    } });
  }
  return reply(405, { error: 'method-not-allowed' }, { allow: 'GET, HEAD, PUT, OPTIONS' });
}

export async function handleE2eeRegistry(request, action, env, store, deps) {
  const { registry } = deps;
  const reply = (status, body) => new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
  if (!registry) return reply(503, { error: 'e2ee-registry-not-configured' });
  if (request.method !== 'POST') return reply(405, { error: 'method-not-allowed' });
  const raw = await deps.readCapped(request, 8192);
  if (!raw) return reply(413, { error: 'too-large' });
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'body-not-json' }); }
  try {
    if (action === 'register') {
      const bad = verifyApprovalSignature(body);
      if (bad) return reply(401, { error: bad });
      const out = await registry.applyRegistration({ owner: body.owner, deviceDid: body.deviceDid,
        approverDid: body.approval.approverDid, kind: body.approval.kind });
      return reply(200, { ...out, waitMs: RECOVERY_WAIT_MS });
    }
    if (action === 'cancel') {
      return reply(200, await registry.cancelPending({ owner: body.owner, actorDid: body.actorDid, pendingId: body.pendingId }));
    }
    if (action === 'revoke') {
      return reply(200, await registry.revokeDevice({ owner: body.owner, actorDid: body.actorDid, targetDid: body.targetDid }));
    }
    if (action === 'batch-revoke') {
      // Signed by the bound registration key over the canonical string.
      const owner = body.owner; const approverDid = body.registrationDid;
      const pub = ed25519PubFromDidKey(approverDid);
      const sig = Buffer.from(String(body.signature ?? ''), 'base64url');
      if (!pub || sig.length !== 64) return reply(401, { error: 'bad-approval-signature' });
      let ok = false;
      try { ok = ed25519.verify(sig, Buffer.from(`yataverse:e2ee:batch-revoke:${owner}`, 'utf8'), pub); } catch { ok = false; }
      if (!ok) return reply(401, { error: 'bad-approval-signature' });
      return reply(200, await registry.requestBatchRevoke({ owner, registrationDid: approverDid }));
    }
    return reply(404, { error: 'not-found' });
  } catch (e) {
    if (e instanceof RegistryError) { const [status, code] = regError(e); return reply(status, { error: code }); }
    throw e;
  }
}

export async function handleE2eeHead(request, headNameHex, env, deps) {
  const { registry } = deps;
  const reply = (status, body) => new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
  if (!registry) return reply(503, { error: 'e2ee-registry-not-configured' });
  if (request.method !== 'POST') return reply(405, { error: 'method-not-allowed' });
  const raw = await deps.readCapped(request, 8192);
  if (!raw) return reply(413, { error: 'too-large' });
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'body-not-json' }); }
  const owner = body.owner; const deviceDid = body.deviceDid;
  if (!owner || !deviceDid || !Number.isInteger(body.seq) || !/^[0-9a-f]{64}$/.test(String(body.headSha ?? '')))
    return reply(400, { error: 'bad-head-request' });
  // The registry allocates the sequence; the CACAO must name the head and seq.
  const v = verifyCacaoRegistered(request.headers.get('authorization'),
    e2eeHeadResource(headNameHex, body.seq), env, deps);
  if (v.error) return reply(v.error[0], { error: v.error[1] });
  if (v.did !== deviceDid) return reply(401, { error: 'cacao-issuer-mismatch' });
  try {
    // The registry is the ordering authority: only headSeq+1 (or an
    // idempotent retry at headSeq) is accepted; anything else is rollback.
    return reply(200, await registry.publishHead({ owner, deviceDid, seq: body.seq, headSha: body.headSha }));
  } catch (e) {
    if (e instanceof RegistryError) { const [status, code] = regError(e); return reply(status, { error: code }); }
    throw e;
  }
}
