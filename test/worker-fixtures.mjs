// Shared fixtures for the Worker tests: an in-memory B2 (GET/HEAD/PUT) plus an optional fallback reader.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export const TOKEN = 'yv_write_0123456789abcdef';
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const ENV = {
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
