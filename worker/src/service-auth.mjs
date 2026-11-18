// Per-person write capability for the yataverse.com Worker: ATProto service auth (AWAI-3274).
// Owner decision 2026-11-18: a person's Aozora identity authorizes their own CAR uploads.
//
//   Authorization: Bearer <JWT>, header {typ: "JWT", alg: "ES256K"},
//   payload {iss: <did:plc|did:web>, aud: SERVICE_AUTH_AUD, lxm: "com.yataverse.importCar",
//            iat, exp}
//
// The JWT is signed with the issuer's `#atproto` secp256k1 key (compact r||s, low-S) over the
// SHA-256 of `<header>.<payload>`, as ATProto service auth defines it. Who mints it (the PDS's
// getServiceAuth or the person's own key-holding client) does not matter here; the Worker checks:
//   1. shape, alg, aud, lxm, a lifetime of at most MAX_LIFETIME_S, not expired, not issued ahead;
//   2. the issuer's DID document (plc.directory or did:web) names a `#atproto_pds` endpoint in
//      SERVICE_AUTH_PDS and a secp256k1 `#atproto` Multikey, and the signature verifies under it;
//   3. that PDS says it hosts the DID and the repo is active (com.atproto.sync.getRepoStatus),
//      because anyone can publish a DID document that merely names the PDS;
//   4. the DID is not in SERVICE_AUTH_DENY_DIDS.
// The person is recorded in the receipt as `requester` = SHA-256 of the DID. No secret is held
// by the app or by this Worker. Without SERVICE_AUTH_AUD the scheme is off.
//
// PDS-attested tokens (AWAI-3370, owner decision 2026-11-18). Aozora's PDS never holds a member's
// repo key, so it cannot sign the token above. Instead it signs, with its own service key,
//   {iss: <PDS did:web>, sub: <member DID>, aud, lxm, iat, exp}
// and this Worker accepts it only when `iss` is pinned in SERVICE_AUTH_PDS_KEYS
// ("<pds did:web>=<secp256k1 Multikey>", comma-separated) and that PDS's origin is in
// SERVICE_AUTH_PDS. The member (`sub`, which may be did:key) must still be reported active by that
// PDS, and SERVICE_AUTH_DENY_DIDS applies to it. A token with a `sub` other than `iss` from any
// other issuer is refused.
//
// Residual risks (recorded in the PR and Linear): there is no `jti` replay store (no KV/D1/DO,
// ADR 0031 D1), so a token can be reused until it expires, only for the same method and
// audience; DID documents and repo status are cached for CACHE_MS per isolate, so a key rotation
// or deactivation takes up to that long to apply.
import crypto from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';

export const IMPORT_CAR_LXM = 'com.yataverse.importCar';
export const MAX_LIFETIME_S = 300;
export const CLOCK_SKEW_S = 30;
export const DEFAULT_PDS = 'https://pds.aozora.app';
export const DEFAULT_PLC = 'https://plc.directory';
const CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const DOC_CAP = 64 * 1024;

// ---- secp256k1 ECDSA verification -------------------------------------------------------------
// Workers' WebCrypto and node:crypto (BoringSSL) have no secp256k1, so this uses @noble/curves,
// pinned to the version Aozora's PDS already uses for the same keys. A pure BigInt version took
// about 25 ms of CPU per verify; noble took about 7 ms (Apple Silicon, Node, 2026-11-18).
const toBig = (bytes) => BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
const N = secp256k1.CURVE.n;

/** 33-byte compressed secp256k1 key -> true when it is a valid point. */
export function decompress(pub) {
  if (!(pub instanceof Uint8Array) || pub.length !== 33 || (pub[0] !== 2 && pub[0] !== 3)) return null;
  try { secp256k1.ProjectivePoint.fromHex(pub).assertValidity(); return pub; } catch { return null; }
}

/** ECDSA-secp256k1 over sha256(msg), compact 64-byte r||s; high-S is refused (ATProto rule). */
export function verifyK256(pub33, msg, sig64) {
  if (!decompress(pub33) || !(sig64 instanceof Uint8Array) || sig64.length !== 64) return false;
  const r = toBig(sig64.subarray(0, 32)), s = toBig(sig64.subarray(32));
  if (r <= 0n || r >= N || s <= 0n || s > N / 2n) return false;
  const digest = new Uint8Array(crypto.createHash('sha256').update(msg).digest());
  try { return secp256k1.verify(sig64, digest, pub33, { lowS: true, prehash: false }); } catch { return false; }
}

// ---- Multikey ---------------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btc(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const hex = n === 0n ? '' : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0');
  const lead = s.match(/^1*/)[0].length;
  return new Uint8Array([...new Array(lead).fill(0), ...Buffer.from(hex, 'hex')]);
}
/** `z<base58btc(0xe7 0x01 || pub33)>` -> the 33-byte key, or null for any other key type. */
export function multikeyToK256(mb) {
  if (typeof mb !== 'string' || !mb.startsWith('z') || mb.length > 100) return null;
  const b = base58btc(mb.slice(1));
  if (!b || b.length !== 35 || b[0] !== 0xe7 || b[1] !== 0x01) return null;
  return b.subarray(2);
}

// ---- DID documents and the PDS ------------------------------------------------------------
const PLC_DID = /^did:plc:[a-z2-7]{24}$/;
const WEB_DID = /^did:web:([a-z0-9-]+(\.[a-z0-9-]+)+)$/;
const KEY_DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export function didDocUrl(did, env) {
  if (PLC_DID.test(did)) return `${env.PLC_DIRECTORY_URL || DEFAULT_PLC}/${did}`;
  const m = WEB_DID.exec(did);
  return m ? `https://${m[1]}/.well-known/did.json` : null;
}

const listVar = (v, dflt) => String(v ?? dflt).split(',').map((s) => s.trim()).filter(Boolean);

/** From a parsed DID document: {key, pds} or null. */
export function atprotoIdentity(doc, did) {
  if (!doc || doc.id !== did) return null;
  const ends = (id, frag) => typeof id === 'string' && (id === frag || id === `${did}${frag}`);
  const vm = (Array.isArray(doc.verificationMethod) ? doc.verificationMethod : []).find((v) => ends(v?.id, '#atproto'));
  const svc = (Array.isArray(doc.service) ? doc.service : []).find((s) => ends(s?.id, '#atproto_pds') && s?.type === 'AtprotoPersonalDataServer');
  const key = multikeyToK256(vm?.publicKeyMultibase);
  if (!key || typeof svc?.serviceEndpoint !== 'string') return null;
  let pds; try { pds = new URL(svc.serviceEndpoint).origin; } catch { return null; }
  return { key, pds };
}

async function fetchJson(url, deps) {
  let r;
  try { r = await deps.fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
  catch { return { error: 'unreachable' }; }
  if (r.status !== 200) return { status: r.status };
  const declared = Number(r.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > DOC_CAP) return { error: 'too-large' };
  const text = await r.text();
  if (text.length > DOC_CAP) return { error: 'too-large' };
  try { return { json: JSON.parse(text) }; } catch { return { error: 'not-json' }; }
}

const cache = new Map();
async function cached(key, now, f) {
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.value;
  const value = await f();
  if (value.ok) { if (cache.size > 1000) cache.clear(); cache.set(key, { until: now + CACHE_MS, value }); }
  return value;
}
export const clearServiceAuthCache = () => cache.clear();

/** SERVICE_AUTH_PDS_KEYS -> Map(pds did:web -> {key, pds}); entries whose PDS is not allowed are dropped. */
export function attesters(env) {
  const allowed = listVar(env.SERVICE_AUTH_PDS, DEFAULT_PDS);
  const out = new Map();
  for (const entry of listVar(env.SERVICE_AUTH_PDS_KEYS, '')) {
    const [did, mk] = entry.split('=').map((x) => x.trim());
    const m = WEB_DID.exec(did ?? ''); const key = multikeyToK256(mk);
    if (!m || !key) continue;
    const pds = `https://${m[1]}`;
    if (allowed.includes(pds)) out.set(did, { key, pds });
  }
  return out;
}

async function resolveIdentity(did, env, deps, now) {
  return cached(`doc:${did}`, now, async () => {
    const url = didDocUrl(did, env);
    if (!url) return { error: 'issuer-did-not-supported' };
    const d = await fetchJson(url, deps);
    if (!d.json) return { error: d.status === 404 ? 'issuer-did-not-found' : 'issuer-did-unresolvable' };
    const id = atprotoIdentity(d.json, did);
    return id ? { ok: true, ...id } : { error: 'issuer-did-has-no-atproto-key-or-pds' };
  });
}

async function hostedActive(did, pds, deps, now) {
  return cached(`status:${pds}:${did}`, now, async () => {
    const d = await fetchJson(`${pds}/xrpc/com.atproto.sync.getRepoStatus?did=${encodeURIComponent(did)}`, deps);
    if (!d.json) return { error: d.status === 400 || d.status === 404 ? 'issuer-not-hosted-by-pds' : 'issuer-pds-unreachable' };
    if (d.json.did !== did) return { error: 'issuer-not-hosted-by-pds' };
    if (d.json.active !== true) return { error: 'issuer-repo-not-active' };
    return { ok: true };
  });
}

// ---- the check ------------------------------------------------------------------------------
const b64json = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };
const JWT = /^Bearer ([A-Za-z0-9_-]{8,2048})\.([A-Za-z0-9_-]{8,4096})\.([A-Za-z0-9_-]{80,90})$/;

/** True when the Authorization header carries a JWT (so the write-token check does not apply). */
export const isServiceAuth = (authorization) => JWT.test(authorization ?? '');

/**
 * -> {did} when the header authorizes `lxm` for this Worker, otherwise {error: [status, code]}.
 * Network failures and unknown issuers fail closed.
 */
export async function verifyServiceAuth(authorization, lxm, env, deps) {
  if (!env.SERVICE_AUTH_AUD) return { error: [503, 'service-auth-not-configured'] };
  const m = JWT.exec(authorization ?? '');
  if (!m) return { error: [401, 'service-auth-malformed'] };
  const header = b64json(m[1]), claims = b64json(m[2]);
  if (!header || !claims) return { error: [401, 'service-auth-malformed'] };
  if (header.alg !== 'ES256K' || (header.typ !== undefined && header.typ !== 'JWT')) return { error: [401, 'service-auth-alg-not-supported'] };
  const { iss, aud, exp, iat } = claims;
  if (aud !== env.SERVICE_AUTH_AUD) return { error: [401, 'service-auth-wrong-audience'] };
  if (claims.lxm !== lxm) return { error: [403, 'service-auth-wrong-method'] };
  const now = Math.floor(deps.now().getTime() / 1000);
  if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(iat)) return { error: [401, 'service-auth-times-missing'] };
  if (exp <= now) return { error: [401, 'service-auth-expired'] };
  if (iat > now + CLOCK_SKEW_S || exp - iat > MAX_LIFETIME_S || exp <= iat) return { error: [401, 'service-auth-lifetime-not-allowed'] };
  if (typeof iss !== 'string' || !(PLC_DID.test(iss) || WEB_DID.test(iss))) return { error: [401, 'service-auth-issuer-not-supported'] };
  const denied = listVar(env.SERVICE_AUTH_DENY_DIDS, '');
  if (denied.includes(iss)) return { error: [403, 'service-auth-issuer-denied'] };
  const nowMs = now * 1000;
  const signed = Buffer.from(`${m[1]}.${m[2]}`, 'ascii');
  const sig = new Uint8Array(Buffer.from(m[3], 'base64url'));
  const attester = attesters(env).get(iss);
  if (attester) {
    const { sub } = claims;
    if (typeof sub !== 'string' || !(PLC_DID.test(sub) || WEB_DID.test(sub) || KEY_DID.test(sub))) return { error: [401, 'service-auth-subject-not-supported'] };
    if (denied.includes(sub)) return { error: [403, 'service-auth-issuer-denied'] };
    if (!verifyK256(attester.key, signed, sig)) return { error: [401, 'service-auth-bad-signature'] };
    const hosted = await hostedActive(sub, attester.pds, deps, nowMs);
    if (hosted.error) return { error: [hosted.error === 'issuer-pds-unreachable' ? 502 : 403, hosted.error] };
    return { did: sub };
  }
  if (claims.sub !== undefined && claims.sub !== iss) return { error: [401, 'service-auth-attester-not-trusted'] };
  const id = await resolveIdentity(iss, env, deps, nowMs);
  if (id.error) return { error: [id.error === 'issuer-did-unresolvable' ? 502 : 401, id.error] };
  if (!listVar(env.SERVICE_AUTH_PDS, DEFAULT_PDS).includes(id.pds)) return { error: [403, 'service-auth-pds-not-allowed'] };
  if (!verifyK256(id.key, signed, sig)) return { error: [401, 'service-auth-bad-signature'] };
  const hosted = await hostedActive(iss, id.pds, deps, nowMs);
  if (hosted.error) return { error: [hosted.error === 'issuer-pds-unreachable' ? 502 : 403, hosted.error] };
  return { did: iss };
}
