// Owner-scoped E2EE pack fetch (design §1, §6–§8): CACAO + owner registry only.
//
//   PUT /awai-drive/v1/e2ee-packs/<sha256>   CACAO yataverse:e2ee:put:<sha256>
//   GET|HEAD /awai-drive/v1/e2ee-packs/<sha256>  CACAO yataverse:e2ee:get:<sha256>
//   POST /awai-drive/v1/e2ee-registry/register|cancel|revoke|batch-revoke|release
//                        length-prefixed signed statements (e2ee-statement.mjs)
//   GET  /awai-drive/v1/e2ee-registry/status/<owner>  {epoch} only
//   POST /awai-drive/v1/e2ee-heads/<headNameHex>  (sequence publish, CACAO)
//   GET  /awai-drive/v1/e2ee-heads/<headNameHex>  (head read, CACAO)
//
// The legacy unauthenticated route (/awai-drive/v1/packs/<sha256>, drive-packs.mjs)
// is untouched; e2ee bytes live in a separate store namespace (e2ee-packs/)
// so neither route can read the other's bytes. Authorization is the registry
// alone: CACAO_WRITER_DIDS is not consulted (verifyCacaoRegistered). Access is
// gated by the per-person owner allowlist (E2EE_OWNER_ALLOWLIST, default
// empty = deny all; unchanged when devices are added). The IP write limiter
// runs before any signature verification. With no registry configured every
// route fails closed with 503.
//
// PUT order (the sha256-only hole, design §1): rate limit -> CACAO -> bounded
// body -> sha256(body) == id -> well-formed CAR with blocks hashing to their
// CIDs -> store bytes -> readback verifies -> registry record. A record is
// never created before the bytes are verified in the store.
//
// Stolen-device residual (fix design §7): a stolen terminal's key is trusted
// until revoked, so it can add an attacker's device (existing-device) and
// revoke the victim's terminals immediately. This is unavoidable while the
// device key is trusted; the seed ultimately recovers via re-registration and
// batch revoke. Meanwhile the stolen key can fetch any pack the owner has
// (already-fetched ciphertext is visible to the thief). There is no
// user-notification channel: the owner discovers the takeover at recovery.
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { parseCar, CarError, CAR_CONTENT_TYPE } from '../../src/car.mjs';
import { verifyBlock } from '../../src/cid.mjs';
import { canonicalStatement, STATEMENT_WINDOW_MS } from '../../src/e2ee-statement.mjs';
import { verifyCacaoRegistered, ed25519PubFromDidKey, e2eeGetResource, e2eePutResource, e2eeHeadResource, e2eeHeadReadResource } from './cacao-auth.mjs';
import { RegistryError, RECOVERY_WAIT_MS, checkOwnerBinding } from './e2ee-registry.mjs';

export const E2EE_PACK_PATH = /^\/awai-drive\/v1\/e2ee-packs\/([0-9a-f]{64})$/;
export const E2EE_REGISTRY_PREFIX = '/awai-drive/v1/e2ee-registry/';
export const E2EE_STATUS_PATH = /^\/awai-drive\/v1\/e2ee-registry\/status\/([0-9a-f]{64})$/;
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
      'statement-expired': 401, 'statement-stale-epoch': 401, 'statement-replayed': 401,
      'device-registered-elsewhere': 409, 'batch-revoke-pending': 409, 'head-name-mismatch': 409,
      'owner-binding-mismatch': 401, 'device-revoked-seed-only': 409,
      'too-many-pending': 429, 'registration-rate': 429, 'batch-revoke-rate': 429,
      'head-rate': 429, 'pack-count-cap': 429, 'pack-bytes-cap': 429,
      'intent-open': 409, 'held-gens-full': 429, 'stale-claim': 409,
    };
    return [map[e.code] ?? 400, e.code];
  }
  throw e;
};

/** Allowlist with incarnation: entries are `ownerHex` or `ownerHex:generation`
 *  (bare hex = generation 0). The generation is the registry incarnation
 *  carried OUTSIDE the owner record (settings); it is part of the statement
 *  signature domain. Empty (the default) denies every owner. */
export function allowlistEntries(env) {
  const list = String(env.E2EE_OWNER_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = new Map();
  for (const e of list) {
    const i = e.lastIndexOf(':');
    if (i > 0 && /^\d+$/.test(e.slice(i + 1))) out.set(e.slice(0, i), Number(e.slice(i + 1)));
    else out.set(e, 0);
  }
  return out;
}
/** Per-person owner allowlist; empty (the default) denies every owner. */
export function ownerAllowlisted(env, owner) {
  return allowlistEntries(env).has(owner);
}
/** Registry incarnation (generation) for an allowlisted owner, or null. */
export function ownerIncarnation(env, owner) {
  return allowlistEntries(env).get(owner) ?? null;
}

function statementShape(stmt) {
  return stmt && typeof stmt === 'object' && typeof stmt.op === 'string' && typeof stmt.owner === 'string'
    && typeof stmt.actorDid === 'string' && Array.isArray(stmt.args)
    && Number.isFinite(stmt.issuedAt) && Number.isFinite(stmt.expiresAt) && Number.isInteger(stmt.epoch)
    && (stmt.incarnation === undefined || Number.isInteger(stmt.incarnation));
}

const ARGS_COUNT = { register: 3, cancel: 1, revoke: 1, 'batch-revoke': 0, release: 1 };

/**
 * Check a statement's shape, window and signature (no consumption).
 * Order: shape -> window -> args count -> crypto. -> null or an error code.
 */
function verifyStatementCrypto(body, { op, actorDid, env, nowMs }) {
  const stmt = body?.statement;
  if (!statementShape(stmt) || stmt.op !== op || stmt.actorDid !== actorDid || stmt.owner !== body?.owner)
    return 'bad-statement';
  const incarnation = ownerIncarnation(env, stmt.owner);
  if (incarnation === null) return 'owner-not-allowlisted';
  if ((stmt.incarnation ?? 0) !== incarnation) return 'statement-stale-incarnation';
  if (stmt.issuedAt > nowMs + 30_000) return 'statement-not-yet-valid';
  if (stmt.expiresAt <= stmt.issuedAt || stmt.expiresAt - stmt.issuedAt > STATEMENT_WINDOW_MS)
    return 'statement-expired';
  if (stmt.args.length !== ARGS_COUNT[op]) return 'bad-statement-args';
  const pub = ed25519PubFromDidKey(actorDid);
  if (!pub) return 'bad-statement';
  if (typeof body.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(body.signature)) return 'bad-statement-signature';
  const sig = Buffer.from(body.signature, 'base64url');
  if (sig.length !== 64 || sig.toString('base64url') !== body.signature) return 'bad-statement-signature';
  const canonical = canonicalStatement({ domain: String(env.CACAO_DOMAIN ?? ''), aud: String(env.CACAO_AUD ?? ''),
    op: stmt.op, owner: stmt.owner, actorDid: stmt.actorDid, args: stmt.args,
    issuedAt: stmt.issuedAt, expiresAt: stmt.expiresAt, epoch: stmt.epoch, incarnation });
  let ok = false;
  try { ok = ed25519.verify(sig, Buffer.from(canonical, 'utf8'), pub); } catch { ok = false; }
  return ok ? null : 'bad-statement-signature';
}

const consume = async (registry, body) => {
  try {
    await registry.consumeStatement({ owner: body.statement.owner, signature: body.signature,
      expiresAt: body.statement.expiresAt, epoch: body.statement.epoch });
    return null;
  } catch (e) { if (e instanceof RegistryError) return e.code; throw e; }
};

/** Owner <-> registration-key binding, checked before any used-marker. */
function bindingError(owner, registrationDid) {
  try { checkOwnerBinding(owner, registrationDid); return null; }
  catch (e) { if (e instanceof RegistryError) return e.code; throw e; }
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
    const limited = await admitWriteRequest(request, env);
    if (limited) return reply(limited[0], { error: limited[1] }, limited[2]);
    const a = auth(e2eePutResource(id));
    if (a.error) return reply(a.error[0], { error: a.error[1] }, a.error[0] === 401 ? { 'www-authenticate': 'CACAO' } : {});
    if (a.notFound) return notFound();
    const owner = await registry.ownerOfDevice(a.did);
    if (!owner) return notFound();
    if (!ownerAllowlisted(env, owner)) return reply(403, { error: 'owner-not-allowlisted' });
    const bytes = await readCapped(request, cap);
    if (!bytes) return reply(413, { error: 'pack-too-large' });
    const overBytes = await admitWriteBytes(request, env, bytes.length);
    if (overBytes) return reply(overBytes[0], { error: overBytes[1] }, overBytes[2]);
    if (sha256Hex(bytes) !== id) return reply(400, { error: 'pack-does-not-hash-to-id' });
    let car;
    try { car = parseCar(bytes); } catch (e) { if (e instanceof CarError) return reply(400, { error: e.code }); throw e; }
    for (const b of car.blocks) if (!verifyBlock(b.cid, b.bytes)) return reply(400, { error: 'pack-block-does-not-hash-to-cid' });
    // Capacity pre-check before storing bytes (re-checked exactly at record time).
    try { await registry.checkPackCapacity({ owner, sha256: id, size: bytes.length }); }
    catch (e) { const [status, code] = regError(e); return reply(status, { error: code }); }
    // Bytes first, readback second, registry record last (design §1).
    const refund = () => registry.releaseCapacity({ owner, sha256: id }).catch(() => {});
    const put = await store.putE2eePack(id, bytes);
    if (put.status !== 200) { await refund(); return reply(502, { error: `store-write-failed-${put.status}` }); }
    const back = await store.getE2eePack(id);
    if (back.status !== 200) { await refund(); return reply(502, { error: `readback-failed-${back.status}` }); }
    const again = await readCapped(back, cap);
    if (!again || again.length !== bytes.length || sha256Hex(again) !== id) { await refund(); return reply(502, { error: 'readback-mismatch' }); }
    try { await registry.recordPack({ owner, deviceDid: a.did, sha256: id, size: bytes.length }); }
    catch (e) { await refund(); const [status, code] = regError(e); return reply(status, { error: code }); }
    return reply(200, { sha256: id, bytes: bytes.length });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const a = auth(e2eeGetResource(id));
    if (a.error) return reply(a.error[0], { error: a.error[1] }, a.error[0] === 401 ? { 'www-authenticate': 'CACAO' } : {});
    if (a.notFound) return notFound();
    const gate = await registry.canFetch({ deviceDid: a.did, sha256: id });
    if (!gate) return notFound();
    if (!ownerAllowlisted(env, gate.owner)) return reply(403, { error: 'owner-not-allowlisted' });
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
  // IP rate limit before any signature verification.
  const limited = await deps.admitWriteRequest(request, env);
  if (limited) return reply(limited[0], { error: limited[1] });
  const raw = await deps.readCapped(request, 8192);
  if (!raw) return reply(413, { error: 'too-large' });
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'body-not-json' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'body-not-object' });
  const deny = (e) => { const [status, code] = regError(e); return reply(status, { error: code }); };
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const stmtFail = (bad) => reply(bad === 'bad-statement-args' ? 400 : 401, { error: bad });
  const live = async (owner, did) => (await registry.ownerOfDevice(did)) === owner;
  try {
    if (action === 'register') {
      const { owner, deviceDid, kind, approval, deviceConsent } = body ?? {};
      if (!ownerAllowlisted(env, owner)) return reply(403, { error: 'owner-not-allowlisted' });
      if (!approval || !deviceConsent) return reply(401, { error: 'bad-statement' });
      // Two signatures over the same statement fields: approver + device consent.
      const same = (a, b) => JSON.stringify([a?.op, a?.owner, a?.args, a?.issuedAt, a?.expiresAt, a?.epoch])
        === JSON.stringify([b?.op, b?.owner, b?.args, b?.issuedAt, b?.expiresAt, b?.epoch]);
      if (!same(approval.statement, deviceConsent.statement)) return reply(401, { error: 'bad-statement' });
      const args = [deviceDid, approval.approverDid, kind];
      if (JSON.stringify(approval.statement.args) !== JSON.stringify(args)) return reply(401, { error: 'bad-statement' });
      // Verify both signatures, check the approver, then mark both used.
      let bad = verifyStatementCrypto({ ...body, statement: approval.statement, signature: approval.signature },
        { op: 'register', actorDid: approval.approverDid, env, nowMs });
      if (bad) return stmtFail(bad);
      bad = verifyStatementCrypto({ ...body, statement: deviceConsent.statement, signature: deviceConsent.signature },
        { op: 'register', actorDid: deviceDid, env, nowMs });
      if (bad) return stmtFail(bad);
      if (kind === 'existing-device' && !(await live(owner, approval.approverDid))) return reply(403, { error: 'approver-not-registered' });
      // Binding before marking either statement used.
      if (kind === 'seed') {
        const bb = bindingError(owner, approval.approverDid);
        if (bb) return stmtFail(bb);
      }
      try { await registry.checkRegistrationRates({ owner, kind }); await registry.checkRegisterable({ owner, deviceDid, kind }); await registry.checkClaimable({ owner, deviceDid }); }
      catch (e) { if (e instanceof RegistryError) { const [status, code] = regError(e); return reply(status, { error: code }); } throw e; }
      bad = await consume(registry, { statement: approval.statement, signature: approval.signature });
      if (bad) return stmtFail(bad);
      bad = await consume(registry, { statement: deviceConsent.statement, signature: deviceConsent.signature });
      if (bad) return stmtFail(bad);
      const out = await registry.applyRegistration({ owner, deviceDid, approverDid: approval.approverDid, kind });
      return reply(200, { ...out, waitMs: RECOVERY_WAIT_MS });
    }
    if (action === 'cancel') {
      if (!ownerAllowlisted(env, body?.owner)) return reply(403, { error: 'owner-not-allowlisted' });
      const actorDid = body.statement?.actorDid;
      let bad = verifyStatementCrypto(body, { op: 'cancel', actorDid, env, nowMs });
      if (bad) return stmtFail(bad);
      if (!(await live(body.owner, actorDid))) return reply(403, { error: 'actor-not-registered' });
      const ps = await registry.pendingState({ owner: body.owner, id: Number(body.statement.args[0]) });
      if (!ps) return reply(404, { error: 'pending-not-found' });
      if (!ps.cancellable) return reply(409, { error: 'pending-not-cancellable' });
      bad = await consume(registry, body);
      if (bad) return stmtFail(bad);
      return reply(200, await registry.cancelPending({ owner: body.owner, actorDid, pendingId: Number(body.statement.args[0]) }));
    }
    if (action === 'revoke') {
      if (!ownerAllowlisted(env, body?.owner)) return reply(403, { error: 'owner-not-allowlisted' });
      const actorDid = body.statement?.actorDid;
      let bad = verifyStatementCrypto(body, { op: 'revoke', actorDid, env, nowMs });
      if (bad) return stmtFail(bad);
      if (!(await live(body.owner, actorDid))) return reply(403, { error: 'actor-not-registered' });
      if (!(await registry.isLiveDevice({ owner: body.owner, did: body.statement.args[0] })))
        return reply(404, { error: 'device-not-found' });
      bad = await consume(registry, body);
      if (bad) return stmtFail(bad);
      return reply(200, await registry.revokeDevice({ owner: body.owner, actorDid, targetDid: body.statement.args[0] }));
    }
    if (action === 'batch-revoke') {
      if (!ownerAllowlisted(env, body?.owner)) return reply(403, { error: 'owner-not-allowlisted' });
      const registrationDid = body.statement?.actorDid;
      let bad = verifyStatementCrypto(body, { op: 'batch-revoke', actorDid: registrationDid, env, nowMs });
      if (bad) return stmtFail(bad);
      bad = bindingError(body.owner, registrationDid);
      if (bad) return stmtFail(bad);
      // Registered check before the used-marker (no unknown-owner writes).
      if ((await registry.registrationDidOf({ owner: body.owner })) !== registrationDid)
        return reply(403, { error: 'registration-key-mismatch' });
      try { await registry.checkBatchRate({ owner: body.owner }); }
      catch (e) { if (e instanceof RegistryError) { const [status, code] = regError(e); return reply(status, { error: code }); } throw e; }
      bad = await consume(registry, body);
      if (bad) return stmtFail(bad);
      return reply(200, await registry.requestBatchRevoke({ owner: body.owner, registrationDid }));
    }
    if (action === 'release') {
      if (!ownerAllowlisted(env, body?.owner)) return reply(403, { error: 'owner-not-allowlisted' });
      const registrationDid = body.statement?.actorDid;
      let bad = verifyStatementCrypto(body, { op: 'release', actorDid: registrationDid, env, nowMs });
      if (bad) return stmtFail(bad);
      bad = bindingError(body.owner, registrationDid);
      if (bad) return stmtFail(bad);
      if ((await registry.registrationDidOf({ owner: body.owner })) !== registrationDid)
        return reply(403, { error: 'registration-key-mismatch' });
      if (!(await registry.deviceKnown({ owner: body.owner, did: body.statement.args[0] })))
        return reply(404, { error: 'device-not-found' });
      bad = await consume(registry, body);
      if (bad) return stmtFail(bad);
      return reply(200, await registry.releaseDevice({ owner: body.owner, deviceDid: body.statement.args[0], registrationDid }));
    }
    return reply(404, { error: 'not-found' });
  } catch (e) {
    if (e instanceof RegistryError) return deny(e);
    throw e;
  }
}

/** GET status: epoch + incarnation (allowlist-carried); unknown owners get epoch 0, incarnation 0. */
export async function handleE2eeStatus(request, owner, env, deps) {
  const reply = (status, body) => new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
  if (!deps.registry) return reply(503, { error: 'e2ee-registry-not-configured' });
  if (request.method !== 'GET') return reply(405, { error: 'method-not-allowed' });
  const incarnation = ownerIncarnation(env, owner) ?? 0;
  try { return reply(200, { epoch: await deps.registry.epochOf({ owner }), incarnation }); }
  catch (e) { if (e instanceof RegistryError) return reply(400, { error: e.code }); throw e; }
}

export async function handleE2eeHead(request, headNameHex, env, deps) {
  const { registry } = deps;
  const reply = (status, body) => new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
  if (!registry) return reply(503, { error: 'e2ee-registry-not-configured' });
  if (request.method === 'GET') {
    const v = verifyCacaoRegistered(request.headers.get('authorization'), e2eeHeadReadResource(headNameHex), env, deps);
    if (v.error) return reply(v.error[0], { error: v.error[1] });
    const owner = await registry.ownerOfDevice(v.did);
    if (!owner) return reply(404, { error: 'head-not-found' });
    if (!ownerAllowlisted(env, owner)) return reply(403, { error: 'owner-not-allowlisted' });
    const head = await registry.getHead({ owner });
    if (!head || head.headName !== headNameHex) return reply(404, { error: 'head-not-found' });
    return reply(200, head);
  }
  if (request.method !== 'POST') return reply(405, { error: 'method-not-allowed' });
  // IP rate limit before signature verification.
  const limited = await deps.admitWriteRequest(request, env);
  if (limited) return reply(limited[0], { error: limited[1] });
  const raw = await deps.readCapped(request, 8192);
  if (!raw) return reply(413, { error: 'too-large' });
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'body-not-json' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'body-not-object' });
  const owner = body.owner; const deviceDid = body.deviceDid;
  if (!owner || !deviceDid || !Number.isInteger(body.seq) || !/^[0-9a-f]{64}$/.test(String(body.headSha ?? '')))
    return reply(400, { error: 'bad-head-request' });
  // CACAO first: the device-to-owner mapping is not enumerable without auth.
  const v = verifyCacaoRegistered(request.headers.get('authorization'),
    e2eeHeadResource(headNameHex, body.seq), env, deps);
  if (v.error) return reply(v.error[0], { error: v.error[1] });
  if (v.did !== deviceDid) return reply(401, { error: 'cacao-issuer-mismatch' });
  // The owner comes from the device index, never from the body.
  const indexOwner = await registry.ownerOfDevice(deviceDid);
  if (!indexOwner || owner !== indexOwner) return reply(404, { error: 'head-not-found' });
  if (!ownerAllowlisted(env, indexOwner)) return reply(403, { error: 'owner-not-allowlisted' });
  try {
    return reply(200, await registry.publishHead({ owner, deviceDid, seq: body.seq, headSha: body.headSha, headNameHex }));
  } catch (e) {
    if (e instanceof RegistryError) { const [status, code] = regError(e); return reply(status, { error: code }); }
    throw e;
  }
}
