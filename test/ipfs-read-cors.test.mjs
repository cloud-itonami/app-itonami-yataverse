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
    assert.equal(p.headers.get('access-control-allow-headers'), 'accept, range, if-range');
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

// The production list (worker/wrangler.jsonc): the market web viewers on cloud-itonami Pages read
// snapshots; the shared Pages origin gains nothing on writes, and the deny list still holds.
test('production read origins: cloud-itonami Pages reads GET/HEAD only; writes 403, denied CIDs 451', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8');
  const prod = /"IPFS_READ_ORIGINS":\s*"([^"]*)"/.exec(text)[1];
  const denied = /"READ_DENY_CIDS":\s*"([^"]*)"/.exec(text)[1];
  const PAGES = 'https://cloud-itonami.github.io';
  assert.deepEqual(ipfsReadOrigins({ IPFS_READ_ORIGINS: prod }), ['http://tauri.localhost', 'tauri://localhost', PAGES]);
  const PENV = { ...ENV, IPFS_READ_ORIGINS: prod, READ_DENY_CIDS: `${denied}, ${rawCid(Buffer.from('denied stand-in'))}` };
  const s = await stored();
  for (const method of ['GET', 'HEAD']) {
    const r = await handle(req(PAGES, { method }), PENV, deps(s));
    assert.equal(r.status, 200, method);
    assert.equal(r.headers.get('access-control-allow-origin'), PAGES, method);
    assert.equal(r.headers.get('access-control-allow-methods'), 'GET, HEAD');
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
  }
  assert.equal((await handle(preflight(PAGES, `/ipfs/${cid}`, 'GET'), PENV, deps(s))).status, 204);
  // Writes from the shared Pages origin are refused before anything is stored.
  const other = Buffer.from('a write from pages');
  const put = await handle(req(PAGES, { method: 'PUT', body: other,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } }, `/ipfs/${rawCid(other)}`), PENV, deps(s));
  assert.equal(put.status, 403);
  assert.equal((await put.json()).error, 'origin-not-allowed');
  const car = encodeCarV1([rawCid(other)], [{ cid: rawCid(other), bytes: other }]);
  const post = await handle(req(PAGES, { method: 'POST', body: car,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.car' } }, '/ipfs'), PENV, deps(s));
  assert.equal(post.status, 403);
  assert.equal((await post.json()).error, 'origin-not-allowed');
  assert.ok(!s.log.some((x) => x.method === 'PUT'), 'nothing was stored');
  // A denied CID (the production entry and a stored stand-in) stays 451 for this origin.
  const bad = Buffer.from('denied stand-in');
  s.objects.set(`ipld/${rawCid(bad)}`, bad);
  for (const c of [denied, rawCid(bad)]) for (const method of ['GET', 'HEAD']) {
    const r = await handle(req(PAGES, { method }, `/ipfs/${c}`), PENV, deps(s));
    assert.equal(r.status, 451, `${method} ${c}`);
  }
  // Negative controls: the removed origin, look-alikes and other Pages owners get no CORS header.
  for (const origin of ['https://network-awai.github.io', 'https://evil.github.io', 'https://cloud-itonami.github.io.evil.example',
    'http://cloud-itonami.github.io']) {
    const r = await handle(req(origin), PENV, deps(s));
    assert.equal(r.status, 200, 'reads stay public');
    assert.equal(r.headers.get('access-control-allow-origin'), null, origin);
    assert.equal((await handle(preflight(origin, `/ipfs/${cid}`, 'GET'), PENV, deps(s))).status, 403, origin);
  }
});
