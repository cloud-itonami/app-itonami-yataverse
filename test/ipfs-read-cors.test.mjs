// Read-only CORS origins on /ipfs (AWAI-3472). A read-only origin may read public blocks from a
// browser page; it gains nothing on the write paths, which keep IPFS_ALLOWED_ORIGINS alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, ENV, NOW, fakeStore } from './worker-fixtures.mjs';
import { handle, ipfsReadOrigins } from '../worker/src/index.mjs';
import { rawCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';

const READERS = ['http://tauri.localhost', 'tauri://localhost'];
const RENV = { ...ENV, IPFS_READ_ORIGINS: READERS.join(', ') };
const deps = (s) => ({ fetchImpl: s.fetchImpl, now: NOW });
const bytes = Buffer.from('natural earth mirror block');
const cid = rawCid(bytes);

async function stored() {
  const s = fakeStore();
  const r = await handle(new Request(`https://yataverse.com/ipfs/${cid}`, {
    method: 'PUT', body: bytes, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } }), ENV, deps(s));
  assert.equal(r.status, 201);
  s.log.length = 0;
  return s;
}
const req = (origin, init = {}, path = `/ipfs/${cid}`) =>
  new Request(`https://yataverse.com${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(origin ? { origin } : {}) } });
const preflight = (origin, path, method) => req(origin, { method: 'OPTIONS', headers: { 'access-control-request-method': method } }, path);

test('read origins: exact scheme://host[:port] entries only, empty by default', () => {
  assert.deepEqual(ipfsReadOrigins({}), []);
  assert.deepEqual(ipfsReadOrigins(RENV), READERS);
  assert.deepEqual(ipfsReadOrigins({ IPFS_READ_ORIGINS: ' *, null, https://a.example/x, https://B.example, http://localhost:5174 ,, tauri://localhost' }),
    ['http://localhost:5174', 'tauri://localhost']);
});

test('a read-only origin can read a block from a page, GET and HEAD', async () => {
  const s = await stored();
  for (const origin of READERS) {
    const g = await handle(req(origin), RENV, deps(s));
    assert.equal(g.status, 200, origin);
    assert.equal(g.headers.get('access-control-allow-origin'), origin);
    assert.equal(g.headers.get('access-control-allow-methods'), 'GET, HEAD');
    assert.equal(g.headers.get('access-control-allow-credentials'), null);
    assert.match(g.headers.get('vary'), /Origin/);
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), bytes);
    const h = await handle(req(origin, { method: 'HEAD' }), RENV, deps(s));
    assert.equal(h.headers.get('access-control-allow-origin'), origin);
    const p = await handle(preflight(origin, `/ipfs/${cid}`, 'GET'), RENV, deps(s));
    assert.equal(p.status, 204);
    assert.equal(p.headers.get('access-control-allow-headers'), 'accept');
  }
});

test('a read-only origin cannot write: PUT and POST are refused before anything is stored', async () => {
  const s = await stored();
  const other = Buffer.from('another block');
  for (const origin of READERS) {
    const put = await handle(req(origin, { method: 'PUT', body: other,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } }, `/ipfs/${rawCid(other)}`), RENV, deps(s));
    assert.equal(put.status, 403, origin);
    assert.equal((await put.json()).error, 'origin-not-allowed');
    const car = encodeCarV1([rawCid(other)], [{ cid: rawCid(other), bytes: other }]);
    const post = await handle(req(origin, { method: 'POST', body: car,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.car' } }, '/ipfs'), RENV, deps(s));
    assert.equal(post.status, 403);
    assert.equal(post.headers.get('access-control-allow-origin'), null);
    // No preflight for a write either.
    assert.equal((await handle(preflight(origin, '/ipfs', 'POST'), RENV, deps(s))).status, 403);
    assert.equal((await handle(preflight(origin, `/ipfs/${rawCid(other)}`, 'PUT'), RENV, deps(s))).status, 403);
  }
  assert.ok(!s.log.some((x) => x.method === 'PUT'), 'nothing was stored');
});

test('an unlisted origin still gets no CORS header on reads', async () => {
  const s = await stored();
  for (const origin of ['https://evil.example', 'tauri://localhost.evil.example', 'null']) {
    const g = await handle(req(origin), RENV, deps(s));
    assert.equal(g.status, 200, 'reads stay public');
    assert.equal(g.headers.get('access-control-allow-origin'), null, origin);
    assert.equal((await handle(preflight(origin, `/ipfs/${cid}`, 'GET'), RENV, deps(s))).status, 403);
  }
});
