// Write authorization by CACAO with a fresh, server-issued nonce (JUN-1426; the
// `:fresh-cacao-nonce` requirement of the durable-plane policy, root ADR-2611212100).
//
//   GET /auth/nonce
//       -> { nonce, expiresAt }. The nonce is `<expiry ms>.<random>.<mac>` (base64url parts);
//          the mac is HMAC-SHA256(CACAO_NONCE_SECRET, "<expiry ms>.<random>"). Nothing is stored
//          (no KV, D1 or Durable Object; ADR 0031 D1), so "fresh" means: issued by this service
//          and not older than NONCE_TTL_S.
//
//   Authorization: CACAO <base64 of the CBOR envelope {p, s:{t:"EdDSA", s}}>
//       The "direct" profile minted by src/cacao.mjs. The Worker checks, in this order:
//       1. the envelope decodes in the restricted CBOR profile (text, arrays of text, maps);
//       2. `iss` is an ed25519 did:key and the signature verifies over the SIWE message;
//       3. `aud` and `domain` equal CACAO_AUD and CACAO_DOMAIN, `version` is "1";
//       4. `iat` is not in the future, `exp` has not passed, lifetime is at most MAX_LIFETIME_S;
//       5. the nonce was issued by this service and has not expired;
//       6. `resources` is exactly the one resource that names what is being written:
//          `yataverse:put:<cid>` for a block, `yataverse:car:<sha256 hex of the body>` for a CAR;
//       7. the issuer is listed in CACAO_WRITER_DIDS (comma-separated did:key values).
//       The person is recorded in the receipt as `requester` = SHA-256 of the DID.
//
// The scheme is off (503) unless CACAO_NONCE_SECRET, CACAO_AUD, CACAO_DOMAIN and
// CACAO_WRITER_DIDS are all set. Write tokens and ATProto service auth are unchanged.
//
// Residual risks (recorded in the PR and Linear):
// - There is no one-time nonce store, so a captured Authorization header can be replayed until
//   the nonce or the CACAO expires. Step 6 binds it to the content, so a replay can only repeat
//   the same content-addressed write; it cannot write anything else. It still spends rate limit.
// - Authorization is a list of writer DIDs. A delegation chain rooted in a Kotoba ID is not
//   implemented here.
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { siweMessage, blockResource, carResource } from '../../src/cacao.mjs';

export { blockResource, carResource };

export const NONCE_TTL_S = 120;
export const MAX_LIFETIME_S = 300;
export const CLOCK_SKEW_S = 30;
export const MAX_HEADER_CHARS = 4096;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEADER = /^CACAO ([A-Za-z0-9+/]{16,}={0,2})$/;

export const isCacao = (authorization) => typeof authorization === 'string' && authorization.startsWith('CACAO ');

const configured = (env) => Boolean(env.CACAO_NONCE_SECRET && env.CACAO_AUD && env.CACAO_DOMAIN && env.CACAO_WRITER_DIDS);
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mac = (env, text) => crypto.createHmac('sha256', String(env.CACAO_NONCE_SECRET)).update(text).digest();

/** -> { nonce, expiresAt } or { error: [status, code] }. */
export function issueNonce(env, deps) {
  if (!configured(env)) return { error: [503, 'cacao-not-configured'] };
  const expiry = deps.now().getTime() + NONCE_TTL_S * 1000;
  const body = `${expiry}.${b64url(crypto.randomBytes(16))}`;
  return { nonce: `${body}.${b64url(mac(env, body))}`, expiresAt: new Date(expiry).toISOString() };
}

/** -> null when the nonce is ours and unexpired, else an error code. */
export function nonceProblem(nonce, env, nowMs) {
  const m = /^(\d{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(String(nonce ?? ''));
  if (!m) return 'cacao-nonce-not-issued-here';
  const want = mac(env, `${m[1]}.${m[2]}`);
  const got = Buffer.from(m[3], 'base64url');
  // One spelling per nonce: base64url has spare bits in its last character.
  if (b64url(got) !== m[3]) return 'cacao-nonce-not-issued-here';
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return 'cacao-nonce-not-issued-here';
  if (Number(m[1]) <= nowMs) return 'cacao-nonce-expired';
  return null;
}

// --- the restricted CBOR profile src/cacao.mjs writes: text, arrays of text, maps of those ---
class Malformed extends Error {}
function decode(buf) {
  let i = 0;
  const head = () => {
    if (i >= buf.length) throw new Malformed('truncated');
    const b = buf[i++]; const major = b >> 5; const info = b & 31;
    if (info < 24) return [major, info];
    if (info === 24) { if (i + 1 > buf.length) throw new Malformed('truncated'); return [major, buf[i++]]; }
    if (info === 25) { if (i + 2 > buf.length) throw new Malformed('truncated'); const n = (buf[i] << 8) | buf[i + 1]; i += 2; return [major, n]; }
    throw new Malformed('length-form-not-accepted');
  };
  const text = (n) => {
    if (i + n > buf.length) throw new Malformed('truncated');
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(i, i + n)); i += n; return s;
  };
  const item = (depth) => {
    const [major, n] = head();
    if (major === 3) return text(n);
    if (major === 4) {
      const out = [];
      for (let k = 0; k < n; k++) { const [m2, n2] = head(); if (m2 !== 3) throw new Malformed('array-of-non-text'); out.push(text(n2)); }
      return out;
    }
    if (major === 5) {
      if (depth >= 2) throw new Malformed('too-deep');
      const out = Object.create(null);
      for (let k = 0; k < n; k++) {
        const [m2, n2] = head(); if (m2 !== 3) throw new Malformed('non-text-key');
        const key = text(n2); if (key in out) throw new Malformed('duplicate-key');
        out[key] = item(depth + 1);
      }
      return out;
    }
    throw new Malformed('type-not-accepted');
  };
  const v = item(0);
  if (i !== buf.length) throw new Malformed('trailing-bytes');
  return v;
}

function ed25519FromDidKey(did) {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]{40,60})$/.exec(String(did ?? ''));
  if (!m) return null;
  let n = 0n;
  for (const ch of m[1]) n = n * 58n + BigInt(B58.indexOf(ch));
  let hex = n.toString(16); if (hex.length % 2) hex = `0${hex}`;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
  return bytes.subarray(2);
}

const time = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s) ? Date.parse(s) : NaN);
const STR = ['iss', 'aud', 'iat', 'nonce', 'domain', 'version', 'exp'];

/**
 * Verify `Authorization: CACAO ...` for one write. `resource` is what this request writes
 * (blockResource / carResource). -> { did } or { error: [status, code] }.
 */
export function verifyCacao(authorization, resource, env, deps) {
  if (!configured(env)) return { error: [503, 'cacao-not-configured'] };
  const deny = (code, status = 401) => ({ error: [status, code] });
  if (typeof authorization !== 'string' || authorization.length > MAX_HEADER_CHARS) return deny('cacao-malformed');
  const h = HEADER.exec(authorization);
  if (!h) return deny('cacao-malformed');
  let env0;
  try { env0 = decode(Buffer.from(h[1], 'base64')); } catch (e) { if (e instanceof Malformed || e instanceof TypeError) return deny('cacao-malformed'); throw e; }
  const p = env0?.p; const s = env0?.s;
  if (typeof p !== 'object' || p === null || Array.isArray(p) || typeof s !== 'object' || s === null || Array.isArray(s)) return deny('cacao-malformed');
  if (Object.keys(env0).length !== 2) return deny('cacao-malformed');
  if (STR.some((k) => typeof p[k] !== 'string') || !Array.isArray(p.resources)) return deny('cacao-malformed');
  if (Object.keys(p).some((k) => !STR.includes(k) && k !== 'resources')) return deny('cacao-malformed');
  if (s.t !== 'EdDSA' || typeof s.s !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(s.s)) return deny('cacao-signature-form-not-accepted');
  const pub = ed25519FromDidKey(p.iss);
  if (!pub) return deny('cacao-issuer-not-ed25519-did-key');
  const sig = Buffer.from(s.s, 'base64url');
  if (sig.length !== 64 || b64url(sig) !== s.s) return deny('cacao-signature-form-not-accepted');
  let ok = false;
  try { ok = ed25519.verify(sig, Buffer.from(siweMessage(p), 'utf8'), pub); } catch { ok = false; }
  if (!ok) return deny('cacao-bad-signature');
  if (p.aud !== String(env.CACAO_AUD) || p.domain !== String(env.CACAO_DOMAIN) || p.version !== '1') return deny('cacao-wrong-audience');
  const now = deps.now().getTime(); const iat = time(p.iat); const exp = time(p.exp);
  if (Number.isNaN(iat) || Number.isNaN(exp)) return deny('cacao-malformed');
  if (iat > now + CLOCK_SKEW_S * 1000) return deny('cacao-issued-in-the-future');
  if (exp <= now) return deny('cacao-expired');
  if (exp - iat > MAX_LIFETIME_S * 1000) return deny('cacao-lifetime-too-long');
  const bad = nonceProblem(p.nonce, env, now);
  if (bad) return deny(bad);
  if (p.resources.length !== 1 || p.resources[0] !== resource) return deny('cacao-resource-does-not-match-this-write', 403);
  const writers = String(env.CACAO_WRITER_DIDS).split(',').map((x) => x.trim()).filter(Boolean);
  if (!writers.includes(p.iss)) return deny('cacao-writer-not-allowed', 403);
  return { did: p.iss };
}

/** The single resource a CACAO names, or null: read before the body so a CAR can be checked after. */
export function claimedCarDigest(authorization) {
  const h = HEADER.exec(String(authorization ?? ''));
  if (!h) return null;
  try {
    const r = decode(Buffer.from(h[1], 'base64'))?.p?.resources;
    const m = Array.isArray(r) && r.length === 1 ? /^yataverse:car:([0-9a-f]{64})$/.exec(r[0]) : null;
    return m ? m[1] : null;
  } catch { return null; }
}
