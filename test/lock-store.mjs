// A fake S3-compatible store with object versions and Object Lock, shared by the leased-write tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha, assertGatewayKeyIsEnough } from './worker-fixtures.mjs';

/** A fake S3 with versions and Object Lock. `mode` injects faults into locking writes. */
export function lockStore({ mode = 'ok' } = {}) {
  const objects = new Map(); const log = []; let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const method = init.method ?? 'GET'; const h = init.headers ?? {};
    const cred = /Credential=([^/]+)\//.exec(h.authorization ?? '')?.[1];
    assert.ok(cred === 'kid' || cred === 'lockkid', `unexpected credential ${cred}`);
    const k = u.pathname.replace('/bucket/', ''); const versionId = u.searchParams.get('versionId');
    const lock = h['x-amz-object-lock-mode'];
    // The ordinary key stays within its documented permissions; only the lock key may set a
    // retention or address a version, and it too only reads and writes single objects.
    if (cred === 'kid') assertGatewayKeyIsEnough(u, method, h);
    else {
      assert.ok(['GET', 'HEAD', 'PUT'].includes(method), `the lock key does not allow ${method}`);
      assert.deepEqual([...u.searchParams.keys()].filter((q) => q !== 'versionId'), []);
    }
    log.push({ method, key: k, cred, versionId, lock: lock ?? null });
    const versions = objects.get(k) ?? [];
    if (method === 'PUT') {
      const body = Buffer.from(init.body);
      assert.equal(h['x-amz-content-sha256'], sha(body));
      if (lock) {
        assert.equal(cred, 'lockkid', 'only the lock credential sets a retention');
        assert.equal(h['content-md5'], crypto.createHash('md5').update(body).digest('base64'));
        if (mode === 'lock-write-fails') return new Response(null, { status: 403 });
      }
      const v = { id: `v${++n}`, bytes: mode === 'corrupt-locked' && lock ? Buffer.from('tampered') : body,
        lockMode: lock && mode !== 'lock-ignored' ? lock : null,
        retainUntil: lock && mode !== 'lock-ignored' ? Date.parse(h['x-amz-object-lock-retain-until-date']) - (mode === 'lock-short' ? 1000 : 0) : null };
      objects.set(k, [...versions, v]);
      return new Response(null, { status: 200, headers: mode === 'no-version' && lock ? {} : { 'x-amz-version-id': v.id } });
    }
    const v = versionId ? versions.find((x) => x.id === versionId) : versions[versions.length - 1];
    if (!v) return new Response(null, { status: 404 });
    if (versionId) assert.equal(cred, 'lockkid');
    const headers = { 'content-length': String(v.bytes.length), 'x-amz-version-id': v.id };
    if (v.lockMode) { headers['x-amz-object-lock-mode'] = v.lockMode; headers['x-amz-object-lock-retain-until-date'] = new Date(v.retainUntil).toISOString(); }
    return new Response(method === 'HEAD' ? null : v.bytes, { status: 200, headers });
  };
  const blockVersions = (cid) => objects.get(`ipld/${cid}`) ?? [];
  const lockedVersions = () => [...objects.values()].flat().filter((v) => v.lockMode);
  return { objects, log, fetchImpl, blockVersions, lockedVersions };
}
