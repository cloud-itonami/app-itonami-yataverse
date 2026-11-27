import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, ENV, NOW, fakeStore, dataKeys } from './worker-fixtures.mjs';
import { handle } from '../worker/src/index.mjs';
import { isNameHost, underNameSuffix, parseDnslink, clearNameCache } from '../worker/src/names.mjs';
import { packFiles } from '../src/unixfs.mjs';
import { encodeCarV1, parseCar, CAR_CONTENT_TYPE } from '../src/car.mjs';
import { rawCid } from '../src/cid.mjs';

const NAME_ENV = { ...ENV, NAME_PLANE_SUFFIXES: '.itonami.app', MAX_BLOCK_BYTES: '4096' };
const FILES = { 'index.html': '<h1>home</h1>', 'app.js': 'console.log(1)', 'docs/index.html': 'docs', 'docs/big.bin': Buffer.alloc(20, 7), 'a b.txt': 'space' };
const SITE = packFiles(FILES, { chunkBytes: 8 });

/** A store holding SITE, plus a DoH answer per host. `txt` maps host -> [TXT data] | {status} | 'down'. */
function world(txt = { 'demo.itonami.app': [`"dnslink=/ipfs/${SITE.root}"`] }) {
  clearNameCache();
  const s = fakeStore(); const dns = [];
  for (const [cid, bytes] of SITE.blocks) s.objects.set(`ipld/${cid}`, Buffer.from(bytes));
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host !== 'cloudflare-dns.com') return s.fetchImpl(url, init);
    assert.equal(init.redirect, 'manual'); assert.equal(init.headers.accept, 'application/dns-json');
    assert.equal(u.searchParams.get('type'), 'TXT');
    const name = u.searchParams.get('name'); dns.push(name);
    const a = txt[name.replace(/^_dnslink\./, '')];
    if (a === 'down') throw new Error('network');
    if (a && !Array.isArray(a)) return new Response(JSON.stringify({ Status: a.status }), { status: a.http ?? 200 });
    if (!a) return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    return new Response(JSON.stringify({ Status: 0, Answer: a.map((data) => ({ name, type: 16, TTL: 60, data })) }), { status: 200 });
  };
  return { s, dns, deps: { fetchImpl, now: NOW } };
}
const req = (path, { host = 'demo.itonami.app', method = 'GET', headers = {}, body } = {}) =>
  new Request(`https://${host}${path}`, { method, headers, body });
const err = async (res) => (await res.json()).error;

test('isNameHost: one label under a configured suffix, and nothing when the var is empty', () => {
  assert.equal(isNameHost('demo.itonami.app', NAME_ENV), true);
  assert.equal(isNameHost('DEMO.itonami.app', NAME_ENV), true);
  for (const h of ['itonami.app', 'a.b.itonami.app', 'yataverse.com', 'demo.itonami.app.evil.test', 'evilitonami.app', '-x.itonami.app', '_dnslink.itonami.app'])
    assert.equal(isNameHost(h, NAME_ENV), false, h);
  assert.equal(isNameHost('demo.itonami.app', ENV), false);
  assert.equal(isNameHost('demo.itonami.app', { NAME_PLANE_SUFFIXES: 'itonami.app' }), false);   // a suffix must start with "."
  assert.equal(isNameHost('x.example.test', { NAME_PLANE_SUFFIXES: '.itonami.app, .example.test' }), true);
  assert.equal(underNameSuffix('itonami.app', NAME_ENV), true);
  assert.equal(underNameSuffix('a.b.itonami.app', NAME_ENV), true);
  assert.equal(underNameSuffix('evilitonami.app', NAME_ENV), false);
  assert.equal(underNameSuffix('yataverse.com', NAME_ENV), false);
  assert.equal(underNameSuffix('itonami.app', ENV), false);
});

test('a name host serves files from its DNSLink with a type, an etag and the IPFS path', async () => {
  const { deps, dns } = world();
  const home = await handle(req('/'), NAME_ENV, deps);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('x-ipfs-roots'), SITE.root);
  assert.equal(await home.text(), '<h1>home</h1>');
  const js = await handle(req('/app.js'), NAME_ENV, deps);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(js.headers.get('etag'), /^"bafybei[a-z2-7]+"$/);          // 14 bytes over 8-byte chunks: a file node
  assert.equal(js.headers.get('x-ipfs-path'), `/ipfs/${SITE.root}/app.js`);
  assert.equal(await js.text(), 'console.log(1)');
  const big = await handle(req('/docs/big.bin'), NAME_ENV, deps);
  assert.equal(big.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Buffer.from(await big.arrayBuffer()), Buffer.alloc(20, 7));
  assert.equal(await (await handle(req('/docs/'), NAME_ENV, deps)).text(), 'docs');
  const spaced = await handle(req('/a%20b.txt'), NAME_ENV, deps);
  assert.equal(spaced.headers.get('etag'), `"${rawCid(Buffer.from(FILES['a b.txt']))}"`);   // one chunk: the raw leaf itself
  assert.equal(spaced.headers.get('x-ipfs-path'), `/ipfs/${SITE.root}/a%20b.txt`);
  assert.equal(await spaced.text(), 'space');
  assert.deepEqual(dns, ['_dnslink.demo.itonami.app']);       // one lookup, then the cache
});

test('HEAD, If-None-Match, directory redirect and misses', async () => {
  const { deps } = world();
  const head = await handle(req('/docs/big.bin', { method: 'HEAD' }), NAME_ENV, deps);
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '20'); assert.equal(await head.text(), '');
  const etag = head.headers.get('etag');
  const same = await handle(req('/docs/big.bin', { headers: { 'if-none-match': `W/${etag}` } }), NAME_ENV, deps);
  assert.equal(same.status, 304); assert.equal(same.headers.get('etag'), etag);
  const dir = await handle(req('/docs?x=1'), NAME_ENV, deps);
  assert.equal(dir.status, 301); assert.equal(dir.headers.get('location'), '/docs/?x=1');
  assert.equal((await handle(req('/missing.html'), NAME_ENV, deps)).status, 404);
  assert.equal((await handle(req('/app.js/under'), NAME_ENV, deps)).status, 404);
});

test('paths that try to leave the site are refused before any lookup', async () => {
  const { deps, dns } = world();
  for (const p of ['/docs/%2Fetc', '/docs/%2e%2e%2fx', '/x%00y', '/a//b', '/bad%zz', '/a%5Cb'])
    assert.equal(await err(await handle(req(p), NAME_ENV, deps)), 'bad-path', p);
  assert.equal((await handle(req('/' + Array(40).fill('d').join('/')), NAME_ENV, deps)).status, 400);
  assert.equal(dns.length, 0);
  // The URL parser folds dot segments (also percent-encoded) before the Worker sees the path, so
  // these stay inside the site and are plain misses.
  for (const p of ['/%2e%2e/secret', '/docs/%2E%2E/%2E%2E/secret', '/../../secret'])
    assert.equal(await err(await handle(req(p), NAME_ENV, deps)), 'not-found', p);
});

test('a name host is read-only: no bytes-plane route exists on it', async () => {
  const { deps, s } = world(); const before = dataKeys(s).length;
  const bytes = Buffer.from('write attempt'); const cid = rawCid(bytes);
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' };
  const put = await handle(req(`/ipfs/${cid}`, { method: 'PUT', headers: auth, body: bytes }), NAME_ENV, deps);
  assert.equal(put.status, 405); assert.equal(put.headers.get('allow'), 'GET, HEAD');
  const post = await handle(req('/ipfs/', { method: 'POST', headers: { ...auth, 'content-type': CAR_CONTENT_TYPE }, body: encodeCarV1([cid], [{ cid, bytes }]) }), NAME_ENV, deps);
  assert.equal(post.status, 405);
  assert.equal((await handle(req('/app.js', { method: 'OPTIONS', headers: { origin: 'https://tauri.localhost', 'access-control-request-method': 'GET' } }), NAME_ENV, deps)).status, 405);
  assert.equal((await handle(req('/app.js', { method: 'DELETE' }), NAME_ENV, deps)).status, 405);
  assert.equal(dataKeys(s).length, before);
  // API paths are site paths here: /health is not the Worker's liveness answer.
  assert.equal((await handle(req('/health'), NAME_ENV, deps)).status, 404);
  assert.equal((await handle(req(`/ipfs/${SITE.root}`), NAME_ENV, deps)).status, 404);
});

test('other hosts under a name suffix get neither a site nor the bytes-plane API', async () => {
  const { deps, dns, s } = world(); const before = dataKeys(s).length;
  const bytes = Buffer.from('write attempt'); const cid = rawCid(bytes);
  for (const host of ['itonami.app', 'a.b.itonami.app', '-x.itonami.app', '_dnslink.demo.itonami.app']) {
    for (const path of ['/health', `/ipfs/${SITE.root}`, '/.well-known/did.json', '/']) {
      const res = await handle(req(path, { host }), NAME_ENV, deps);
      assert.equal(res.status, 404, `${host}${path}`); assert.equal(await err(res), 'not-a-name-host');
    }
    const put = await handle(req(`/ipfs/${cid}`, { host, method: 'PUT', body: bytes,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } }), NAME_ENV, deps);
    assert.equal(put.status, 404);
  }
  assert.equal(dataKeys(s).length, before); assert.equal(dns.length, 0);
});

test('with the name plane off, the same host gets the ordinary API and no DNS lookup', async () => {
  const { deps, dns } = world();
  const res = await handle(req('/health'), ENV, deps);
  assert.equal(res.status, 200); assert.equal((await res.json()).service, 'yataverse-bytes');
  assert.equal((await handle(req('/'), ENV, deps)).status, 200);
  assert.equal((await handle(req('/no-such-route'), ENV, deps)).status, 404);
  assert.equal(dns.length, 0);
  // And the API host is unaffected when it is on.
  assert.equal((await handle(new Request('https://yataverse.com/health'), NAME_ENV, deps)).status, 200);
});

test('DNSLink answers: none, several, IPNS, malformed, and DNS failures', async () => {
  const one = (data) => world({ 'demo.itonami.app': data }).deps;
  assert.equal(await err(await handle(req('/'), NAME_ENV, one(undefined))), 'name-not-published');
  assert.equal(await err(await handle(req('/'), NAME_ENV, one(['"v=spf1 -all"']))), 'name-not-published');
  const two = await handle(req('/'), NAME_ENV, one([`"dnslink=/ipfs/${SITE.root}"`, `"dnslink=/ipfs/${rawCid(Buffer.from('x'))}"`]));
  assert.equal(two.status, 502); assert.equal(await err(two), 'dnslink-ambiguous');
  const ipns = await handle(req('/'), NAME_ENV, one(['"dnslink=/ipns/k51qzi5uqu5dexample"']));
  assert.equal(ipns.status, 501); assert.equal(await err(ipns), 'dnslink-ipns-not-supported');
  assert.equal(await err(await handle(req('/'), NAME_ENV, one(['"dnslink=/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"']))), 'dnslink-not-ipfs-cidv1');
  assert.equal(await err(await handle(req('/'), NAME_ENV, one(['"dnslink=https://example.test/"']))), 'dnslink-not-ipfs-cidv1');
  assert.equal(await err(await handle(req('/'), NAME_ENV, one([`"dnslink=/ipfs/${SITE.root}/../x"`]))), 'dnslink-path-not-accepted');
  const down = await handle(req('/'), NAME_ENV, one('down'));
  assert.equal(down.status, 504); assert.equal(await err(down), 'dns-unreachable');
  assert.equal(await err(await handle(req('/'), NAME_ENV, one({ status: 2 }))), 'dns-status-2');
  assert.equal(await err(await handle(req('/'), NAME_ENV, one({ status: 0, http: 500 }))), 'dns-failed-500');
  // A split TXT record is joined; a subpath in the record is the site root.
  const split = one([`"dnslink=/ipfs/${SITE.root.slice(0, 20)}" "${SITE.root.slice(20)}/docs"`]);
  assert.equal(await (await handle(req('/'), NAME_ENV, split)).text(), 'docs');
  assert.deepEqual(parseDnslink(`/ipfs/${SITE.root}/`), { root: SITE.root, base: [] });
});

test('a failed lookup is not cached; a clear answer is, for a minute', async () => {
  const txt = { 'demo.itonami.app': 'down' };
  const w = world(txt);
  assert.equal((await handle(req('/'), NAME_ENV, w.deps)).status, 504);
  txt['demo.itonami.app'] = [`"dnslink=/ipfs/${SITE.root}"`];
  assert.equal((await handle(req('/'), NAME_ENV, w.deps)).status, 200);
  delete txt['demo.itonami.app'];
  assert.equal((await handle(req('/'), NAME_ENV, w.deps)).status, 200);
  const later = { ...w.deps, now: () => new Date(NOW().getTime() + 61_000) };
  assert.equal((await handle(req('/'), NAME_ENV, later)).status, 404);
  assert.equal(w.dns.length, 3);
});

test('content the store does not hold in full, or that fails its hash, is an error and never partial', async () => {
  const w = world();
  const big = [...SITE.blocks.keys()].filter((c) => c.startsWith('bafkrei'));
  const chunk = rawCid(Buffer.alloc(8, 7));
  assert.ok(big.includes(chunk));
  w.s.objects.delete(`ipld/${chunk}`);
  const missing = await handle(req('/docs/big.bin'), NAME_ENV, w.deps);
  assert.equal(missing.status, 502); assert.equal(await err(missing), 'site-block-not-found');
  w.s.objects.set(`ipld/${chunk}`, Buffer.from('tampered'));
  const bad = await handle(req('/docs/big.bin'), NAME_ENV, w.deps);
  assert.equal(bad.status, 502); assert.equal(await err(bad), 'stored-block-does-not-hash-to-cid');
  const w2 = world({ 'demo.itonami.app': [`"dnslink=/ipfs/${rawCid(Buffer.from('not here'))}"`] });
  assert.equal(await err(await handle(req('/'), NAME_ENV, w2.deps)), 'site-block-not-found');
  const w3 = world();
  assert.equal((await handle(req('/docs/big.bin'), { ...NAME_ENV, NAME_PLANE_MAX_FILE_BLOCKS: '2' }, w3.deps)).status, 413);
  assert.equal((await handle(req('/'), { ...NAME_ENV, B2_BUCKET: '' }, w3.deps)).status, 503);
});

test('a UnixFS site can be imported as a CAR and exported again', async () => {
  clearNameCache();
  const s = fakeStore(); const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const car = encodeCarV1([SITE.root], [...SITE.blocks].map(([cid, bytes]) => ({ cid, bytes })));
  const imp = await handle(new Request('https://yataverse.com/ipfs/', { method: 'POST', body: car,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': CAR_CONTENT_TYPE } }), NAME_ENV, deps);
  assert.equal(imp.status, 201, JSON.stringify(await imp.clone().json()));
  for (const cid of SITE.blocks.keys()) assert.ok(s.objects.has(`ipld/${cid}`));
  const exp = await handle(new Request(`https://yataverse.com/ipfs/${SITE.root}?format=car`), NAME_ENV, deps);
  assert.equal(exp.status, 200);
  const back = parseCar(Buffer.from(await exp.arrayBuffer()));
  assert.deepEqual(back.roots, [SITE.root]);
  assert.equal(back.blocks[0].cid, SITE.root);                             // depth-first from the root
  assert.deepEqual(new Map(back.blocks.map((b) => [b.cid, Buffer.from(b.bytes)])), new Map([...SITE.blocks].map(([c, b]) => [c, Buffer.from(b)])));
});
