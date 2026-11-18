// CORS on /ipfs for the Nagare WebView (AWAI-3274). Only the declared origin is answered;
// other origins are the negative control. Writes keep their token, CID and readback checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, ENV, NOW, fakeStore, fakeLimiter, dataKeys } from './worker-fixtures.mjs';
import { handle, ipfsAllowedOrigins, DEFAULT_IPFS_ALLOWED_ORIGINS } from '../worker/src/index.mjs';
import { rawCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';

const NAGARE = 'https://tauri.localhost';
const OTHERS = ['http://tauri.localhost', 'https://evil.example', 'https://tauri.localhost.evil.example', 'null'];
const deps = (s) => ({ fetchImpl: s.fetchImpl, now: NOW });
const bytes = Buffer.from('nagare video block 0001');
const cid = rawCid(bytes);
const car = () => encodeCarV1([cid], [{ cid, bytes }]);
const post = (origin, { auth = `Bearer ${TOKEN}` } = {}) => new Request('https://yataverse.com/ipfs', {
  method: 'POST', body: car(),
  headers: { authorization: auth, 'content-type': 'application/vnd.ipld.car', ...(origin ? { origin } : {}) } });
const get = (origin, path = `/ipfs/${cid}?format=car`) =>
  new Request(`https://yataverse.com${path}`, { headers: origin ? { origin } : {} });
const preflight = (origin, path, method, headers = 'authorization, content-type') =>
  new Request(`https://yataverse.com${path}`, { method: 'OPTIONS', headers: {
    origin, 'access-control-request-method': method, 'access-control-request-headers': headers } });

test('the default allowed origin is the Nagare WebView only', () => {
  assert.equal(DEFAULT_IPFS_ALLOWED_ORIGINS, NAGARE);
  assert.deepEqual(ipfsAllowedOrigins({}), [NAGARE]);
  // Entries that are not exact origins (paths, wildcards, blanks) are ignored.
  assert.deepEqual(ipfsAllowedOrigins({ IPFS_ALLOWED_ORIGINS: ' https://a.example , *, https://b.example/x,,null' }), ['https://a.example']);
});

test('preflight: Nagare may POST /ipfs and GET /ipfs/<cid>; nothing else is answered', async () => {
  const s = fakeStore();
  const ok = await handle(preflight(NAGARE, '/ipfs', 'POST'), ENV, deps(s));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), NAGARE);
  assert.equal(ok.headers.get('access-control-allow-methods'), 'POST');
  assert.match(ok.headers.get('access-control-allow-headers'), /authorization/);
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  const read = await handle(preflight(NAGARE, `/ipfs/${cid}`, 'GET', 'accept'), ENV, deps(s));
  assert.equal(read.status, 204);
  assert.equal(read.headers.get('access-control-allow-methods'), 'GET, HEAD');
  // Block PUT stays a non-browser operation, and POST is not offered on a block path.
  assert.equal((await handle(preflight(NAGARE, `/ipfs/${cid}`, 'PUT'), ENV, deps(s))).status, 403);
  assert.equal((await handle(preflight(NAGARE, '/ipfs', 'GET'), ENV, deps(s))).status, 403);
  // Negative control: every other origin is refused and gets no CORS header.
  for (const o of OTHERS) {
    for (const [path, m] of [['/ipfs', 'POST'], [`/ipfs/${cid}`, 'GET']]) {
      const r = await handle(preflight(o, path, m), ENV, deps(s));
      assert.equal(r.status, 403, `${o} ${m} ${path}`);
      assert.equal(r.headers.get('access-control-allow-origin'), null);
    }
  }
  assert.equal(s.log.length, 0);
});

test('POST /ipfs from Nagare stores the CAR with the same checks and is readable by the page', async () => {
  const s = fakeStore();
  const r = await handle(post(NAGARE), ENV, deps(s));
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), NAGARE);
  assert.match(r.headers.get('vary'), /Origin/);
  const body = await r.json();
  assert.deepEqual(body.roots, [cid]); assert.equal(body.verified, true);
  assert.ok(s.objects.has(`ipld/${cid}`));
  // Stored, then read back (PUT followed by GET of the same key).
  assert.ok(s.log.some((x) => x.method === 'PUT' && x.path.endsWith(cid)));
  assert.ok(s.log.some((x) => x.method === 'GET' && x.path.endsWith(cid)));
  const g = await handle(get(NAGARE), ENV, deps(s));
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('access-control-allow-origin'), NAGARE);
  assert.match(g.headers.get('vary'), /accept/i); assert.match(g.headers.get('vary'), /Origin/);
  assert.match(g.headers.get('content-type'), /application\/vnd\.ipld\.car/);
});

test('errors reach the Nagare page with CORS headers, and the token is still required', async () => {
  const s = fakeStore();
  const noAuth = await handle(post(NAGARE, { auth: '' }), ENV, deps(s));
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers.get('access-control-allow-origin'), NAGARE);
  assert.equal((await noAuth.json()).error, 'unauthorized');
  const missing = await handle(get(NAGARE), ENV, deps(s));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('access-control-allow-origin'), NAGARE);
  assert.equal(dataKeys(s).length, 0);
});

test('negative control: a write from any other origin is refused before the body is read, even with a valid token', async () => {
  for (const o of OTHERS) {
    const s = fakeStore(); const limiter = fakeLimiter();
    const r = await handle(post(o), { ...ENV, WRITE_REQUEST_LIMITER: limiter }, deps(s));
    assert.equal(r.status, 403, o);
    assert.equal((await r.json()).error, 'origin-not-allowed');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(s.log.length, 0); assert.equal(limiter.used.size, 0);
    const put = new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'PUT', body: bytes,
      headers: { origin: o, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } });
    assert.equal((await handle(put, ENV, deps(s))).status, 403);
    assert.equal(dataKeys(s).length, 0);
  }
});

test('reads from other origins are still served (public bytes) but carry no CORS header', async () => {
  const s = fakeStore();
  assert.equal((await handle(post(null), ENV, deps(s))).status, 201); // CLI: no Origin header
  for (const o of OTHERS) {
    const g = await handle(get(o), ENV, deps(s));
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('access-control-allow-origin'), null);
    assert.match(g.headers.get('vary'), /Origin/);
  }
});

test('the rate limits still apply to Nagare writes', async () => {
  const s = fakeStore();
  const env = { ...ENV, WRITE_REQUEST_LIMITER: fakeLimiter(1) };
  assert.equal((await handle(post(NAGARE), env, deps(s))).status, 201);
  const second = await handle(post(NAGARE), env, deps(s));
  assert.equal(second.status, 429);
  assert.equal(second.headers.get('access-control-allow-origin'), NAGARE);
  const env2 = { ...ENV, WRITE_REQUEST_LIMITER: undefined };
  assert.equal((await handle(post(NAGARE), env2, deps(fakeStore()))).status, 503);
});

test('a configured origin list replaces the default; the Drive route keeps its own list', async () => {
  const s = fakeStore(); const env = { ...ENV, IPFS_ALLOWED_ORIGINS: 'https://nagare.example' };
  assert.equal((await handle(preflight('https://nagare.example', '/ipfs', 'POST'), env, deps(s))).status, 204);
  assert.equal((await handle(preflight(NAGARE, '/ipfs', 'POST'), env, deps(s))).status, 403);
  const id = 'a'.repeat(64);
  const drive = await handle(new Request(`https://yataverse.com/awai-drive/v1/packs/${id}`, { method: 'OPTIONS', headers: { origin: NAGARE } }), ENV, deps(s));
  assert.equal(drive.headers.get('access-control-allow-origin'), null);
});
