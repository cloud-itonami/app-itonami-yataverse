// Shared fixtures for the Worker tests: an in-memory B2 (GET/HEAD/PUT) plus an optional fallback reader.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { keyIdFor } from '../src/receipt.mjs';
import { decodeDagCbor } from '../src/dag-cbor.mjs';

export const TOKEN = 'yv_write_0123456789abcdef';
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** A fake Workers Rate Limiting binding: `limit` units per key, counted until reset. */
export function fakeLimiter(limit = Infinity) {
  const used = new Map();
  return { used, async limit({ key }) { const n = (used.get(key) ?? 0) + 1; used.set(key, n); return { success: n <= limit }; } };
}
export const UNLIMITED = { async limit() { return { success: true }; } };

/** A throwaway Ed25519 receipt key and the key set that publishes it (valid from 0, never revoked). */
export function receiptKey(extra = {}) {
  const j = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const jwk = { kty: j.kty, crv: j.crv, d: j.d, x: j.x };
  const keyId = '0x' + Buffer.from(keyIdFor(new Uint8Array(Buffer.from(j.x, 'base64url')))).toString('hex');
  const keys = { v: 1, signer: 'did:web:yataverse.com', keys: [{ keyId, keyEpoch: 1, alg: 'Ed25519',
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: j.x }, notBefore: 0, notAfter: null, revokedAt: null, ...extra }] };
  return { jwk, keyId, keys };
}
export const RECEIPT_KEY = receiptKey();

export const ENV = {
  RECEIPT_SIGNING_KEY: JSON.stringify(RECEIPT_KEY.jwk), RECEIPT_PUBLIC_KEYS: RECEIPT_KEY.keys, SOURCE_COMMIT: 'test',
  WRITE_REQUEST_LIMITER: UNLIMITED, WRITE_MIB_LIMITER: UNLIMITED,
  B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com', B2_BUCKET: 'bucket', B2_KEY_ID: 'kid', B2_APP_KEY: 'secret',
  B2_PREFIX: 'ipld/', WRITE_TOKEN_SHA256: sha(TOKEN), MAX_BLOCK_BYTES: '1024',
};
export const NOW = () => new Date('2026-11-18T00:00:00Z');

/** In-memory B2 plus an optional fallback reader. `mode` injects faults. */
export function fakeStore({ mode = 'ok', fallback = new Map() } = {}) {
  const objects = new Map(); const log = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const method = init.method ?? 'GET';
    log.push({ host: u.host, method, path: u.pathname, auth: init.headers?.authorization ?? null, redirect: init.redirect });
    if (u.host === 's3.us-west-004.backblazeb2.com') {
      assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=kid\/20261118\/us-west-004\/s3\/aws4_request/);
      const key = u.pathname.replace('/bucket/', '');
      if (method === 'PUT') {
        if (mode === 'put-fails') return new Response(null, { status: 500 });
        const body = Buffer.from(init.body);
        assert.equal(init.headers['x-amz-content-sha256'], sha(body));
        objects.set(key, mode === 'corrupt-store' ? Buffer.from('tampered') : body);
        return new Response(null, { status: 200 });
      }
      const b = objects.get(key);
      if (method === 'HEAD') return new Response(null, { status: b ? 200 : 404 });
      return b ? new Response(b, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (u.host === 'ipfs.yataverse.com') {
      const cid = u.pathname.split('/').pop(); const b = fallback.get(cid);
      return b ? new Response(b, { status: 200 }) : new Response(null, { status: 404 });
    }
    throw new Error(`unexpected host ${u.host}`);
  };
  return { objects, log, fetchImpl };
}

/**
 * Stored data objects (blocks and packs), leaving out receipt records and the policy block that
 * every successful write adds. Counting these keeps "nothing was stored" assertions exact.
 */
export function dataKeys(store) {
  return [...store.objects.entries()].filter(([k, b]) => !k.startsWith('ipld/receipts/') && !isPolicy(b)).map(([k]) => k);
}
function isPolicy(bytes) {
  try { const v = decodeDagCbor(bytes).value; return v instanceof Map && v.has('source') && v.has('limits') && v.has('store'); }
  catch { return false; }
}
