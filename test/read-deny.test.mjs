// Read deny list (AWAI-3629): a CID in READ_DENY_CIDS is answered with 451 on every public read
// path, before B2 or the fallback reader is asked. Writes are unaffected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, ENV, NOW, fakeStore } from './worker-fixtures.mjs';
import { handle } from '../worker/src/index.mjs';
import { clearNameCache } from '../worker/src/names.mjs';
import { readDenyList, readDenied, READ_DENIED_HEADER } from '../worker/src/read-deny.mjs';
import { rawCid, parseCid, normalizeCid, cidFor, CODEC_RAW, CODEC_DAG_PB } from '../src/cid.mjs';
import { packFiles } from '../src/unixfs.mjs';
import { encodeCarV1, CAR_CONTENT_TYPE } from '../src/car.mjs';
import { base58btc } from '../src/cacao.mjs';

const deps = (s) => ({ fetchImpl: s.fetchImpl, now: NOW });
const v0 = (cid) => base58btc(Buffer.concat([Buffer.from([0x12, 0x20]), parseCid(cid).digest]));
const get = (path, init = {}, host = 'yataverse.com') => new Request(`https://${host}${path}`, init);
const err = async (r) => (await r.json()).error;
const storeReads = (s) => s.log.filter((l) => l.method === 'GET' || l.method === 'HEAD');

const OK = Buffer.from('a block that stays public');
const BAD = Buffer.from('ISCO-08 full table stand-in');
const okCid = rawCid(OK); const badCid = rawCid(BAD);
const DENV = { ...ENV, READ_DENY_CIDS: badCid };

function storeWith(...blocks) {
  const s = fakeStore();
  for (const b of blocks) s.objects.set(`ipld/${rawCid(b)}`, Buffer.from(b));
  return s;
}

function assertDenied(r, status = 451) {
  assert.equal(r.status, status);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-type'), /^application\/json/);
}

test('the list is parsed by multihash; CIDv0 and CIDv1 of one digest are one entry', () => {
  assert.deepEqual([...readDenyList({}).set], []);
  assert.deepEqual([...readDenyList({ READ_DENY_CIDS: '' }).set], []);
  assert.deepEqual([...readDenyList({ READ_DENY_CIDS: ' , ' }).set], []);
  const pb = cidFor(BAD, CODEC_DAG_PB);
  const one = readDenyList({ READ_DENY_CIDS: `${badCid}, ${v0(badCid)}, ${pb}` });
  assert.equal(one.set.size, 1);
  for (const c of [badCid, v0(badCid), pb, normalizeCid(v0(badCid))])
    assert.deepEqual(readDenied(c, DENV), [451, 'unavailable-for-legal-reasons'], c);
  assert.equal(readDenied(okCid, DENV), null);
  assert.equal(readDenied(badCid, ENV), null);
  assert.deepEqual(readDenyList({ READ_DENY_CIDS: `${badCid},bafytypo` }).invalid, ['bafytypo']);
});

test('the AWAI-3629 entry in wrangler.jsonc parses', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8');
  const m = /"READ_DENY_CIDS":\s*"([^"]*)"/.exec(text);
  assert.ok(m, 'READ_DENY_CIDS is set');
  const list = readDenyList({ READ_DENY_CIDS: m[1] });
  assert.equal(list.invalid, undefined);
  assert.ok(readDenied('bafkreigyi4fpsxzufdfxwbr5zcw4wai5jnuwjpqbonsyfcvo6bsuvjsmke', { READ_DENY_CIDS: m[1] }));
});

test('GET and HEAD of a denied CID are 451 without asking B2; other CIDs are unchanged', async () => {
  const s = storeWith(OK, BAD);
  for (const method of ['GET', 'HEAD']) {
    s.log.length = 0;
    const r = await handle(get(`/ipfs/${badCid}`, { method }), DENV, deps(s));
    assertDenied(r);
    if (method === 'GET') assert.equal(await err(r), 'unavailable-for-legal-reasons');
    assert.deepEqual(storeReads(s), []);
    const ok = await handle(get(`/ipfs/${okCid}`, { method }), DENV, deps(s));
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control'), /immutable/);
  }
  // Negative control: the same block is served when the list is empty or unset.
  for (const env of [ENV, { ...ENV, READ_DENY_CIDS: '' }]) {
    const r = await handle(get(`/ipfs/${badCid}`), env, deps(s));
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), BAD);
  }
});

test('the CIDv0 and CIDv1 spellings of a denied digest are both refused', async () => {
  const node = Buffer.from([0x0a, 0x02, 0x08, 0x01]);            // a UnixFS directory node
  const pb = cidFor(node, CODEC_DAG_PB); const qm = v0(pb);
  const s = fakeStore(); s.objects.set(`ipld/${pb}`, node); s.objects.set(`ipld/${qm}`, node);
  for (const deny of [pb, qm]) {
    const env = { ...ENV, READ_DENY_CIDS: deny };
    for (const asked of [pb, qm, cidFor(node, CODEC_RAW)])
      assertDenied(await handle(get(`/ipfs/${asked}`), env, deps(s)));
  }
  assert.equal((await handle(get(`/ipfs/${pb}`), ENV, deps(s))).status, 200);
});

test('a B2 miss of a denied CID never reaches the fallback reader', async () => {
  const s = fakeStore({ fallback: new Map([[badCid, BAD]]) });
  const env = { ...DENV, READ_FALLBACK_URL: 'https://ipfs.yataverse.com' };
  assertDenied(await handle(get(`/ipfs/${badCid}`), env, deps(s)));
  assert.deepEqual(s.log, []);
  // Control: without the entry the fallback serves it.
  const r = await handle(get(`/ipfs/${badCid}`), { ...ENV, READ_FALLBACK_URL: 'https://ipfs.yataverse.com' }, deps(s));
  assert.equal(r.status, 200);
  assert.ok(s.log.some((l) => l.host === 'ipfs.yataverse.com'));
});

test('CORS headers follow the usual rule on a 451', async () => {
  const s = storeWith(BAD);
  const env = { ...DENV, IPFS_READ_ORIGINS: 'tauri://localhost' };
  const r = await handle(get(`/ipfs/${badCid}`, { headers: { origin: 'tauri://localhost' } }), env, deps(s));
  assertDenied(r);
  assert.equal(r.headers.get('access-control-allow-origin'), 'tauri://localhost');
  assert.match(r.headers.get('vary'), /Origin/);
  const other = await handle(get(`/ipfs/${badCid}`, { headers: { origin: 'https://evil.example' } }), env, deps(s));
  assertDenied(other);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

// A chunked UnixFS file: dag-pb root over raw leaves.
const FILES = { 'index.html': 'home', 'data.bin': Buffer.concat([Buffer.alloc(8, 1), BAD.subarray(0, 8), Buffer.alloc(8, 2)]), 'small.txt': 'tiny' };
const SITE = packFiles(FILES, { chunkBytes: 8 });
const LEAF = rawCid(BAD.subarray(0, 8));                         // the middle chunk of data.bin
const SMALL = rawCid(Buffer.from('tiny'));                       // a one-chunk file: the raw leaf itself
const siteStore = () => { const s = fakeStore(); for (const [c, b] of SITE.blocks) s.objects.set(`ipld/${c}`, Buffer.from(b)); return s; };

test('CAR export: a denied root or a denied block anywhere in the DAG is 451, never a partial CAR', async () => {
  const s = siteStore();
  assert.ok(SITE.blocks.has(LEAF));
  for (const deny of [SITE.root, LEAF]) {
    const env = { ...ENV, READ_DENY_CIDS: deny };
    for (const [method, path, headers] of [
      ['GET', `/ipfs/${SITE.root}?format=car`, {}],
      ['HEAD', `/ipfs/${SITE.root}?format=car`, {}],
      ['GET', `/ipfs/${SITE.root}`, { accept: CAR_CONTENT_TYPE }],
    ]) {
      const r = await handle(get(path, { method, headers }), env, deps(s));
      assertDenied(r);
      if (method === 'GET') assert.equal(await err(r), 'unavailable-for-legal-reasons');
    }
  }
  // dag-scope=block of the root alone does not include the leaf; the root itself is fine.
  const blockOnly = await handle(get(`/ipfs/${SITE.root}?format=car&dag-scope=block`), { ...ENV, READ_DENY_CIDS: LEAF }, deps(s));
  assert.equal(blockOnly.status, 200);
  // Controls: an unrelated entry, and no list.
  for (const env of [ENV, { ...ENV, READ_DENY_CIDS: okCid }]) {
    const r = await handle(get(`/ipfs/${SITE.root}?format=car`), env, deps(s));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /vnd\.ipld\.car/);
  }
});

test('name hosts: a file holding a denied block is 451 on GET and HEAD; other files are served', async () => {
  const s = siteStore();
  const base = { NAME_PLANE_SUFFIXES: '.itonami.app', MAX_BLOCK_BYTES: '4096' };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.host !== 'cloudflare-dns.com') return s.fetchImpl(url, init);
    const name = u.searchParams.get('name');
    return new Response(JSON.stringify({ Status: 0, Answer: [{ name, type: 16, TTL: 60, data: `"dnslink=/ipfs/${SITE.root}"` }] }), { status: 200 });
  };
  const d = { fetchImpl, now: NOW };
  const host = 'demo.itonami.app';
  for (const [deny, path] of [[LEAF, '/data.bin'], [SMALL, '/small.txt'], [v0(SMALL), '/small.txt']]) {
    clearNameCache();
    const env = { ...ENV, ...base, READ_DENY_CIDS: deny };
    for (const method of ['GET', 'HEAD']) {
      s.log.length = 0;
      const r = await handle(get(path, { method }, host), env, d);
      assertDenied(r);
      if (method === 'GET') assert.equal(await err(r), 'unavailable-for-legal-reasons');
      assert.ok(!s.log.some((l) => l.path.endsWith(deny)), 'the denied block is not read');
    }
    const fine = await handle(get('/index.html', {}, host), env, d);
    assert.equal(fine.status, 200);
    assert.equal(await fine.text(), 'home');
  }
  clearNameCache();
  const control = await handle(get('/data.bin', {}, host), { ...ENV, ...base }, d);
  assert.equal(control.status, 200);
  assert.deepEqual(Buffer.from(await control.arrayBuffer()), FILES['data.bin']);
});

test('writes of a denied CID are accepted as before, marked, and the object stays in B2', async () => {
  const s = fakeStore();
  const put = await handle(get(`/ipfs/${badCid}`, { method: 'PUT', body: BAD,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } }), DENV, deps(s));
  assert.equal(put.status, 201);
  assert.equal(put.headers.get(READ_DENIED_HEADER), 'true');
  assert.deepEqual(s.objects.get(`ipld/${badCid}`), BAD);
  assertDenied(await handle(get(`/ipfs/${badCid}`), DENV, deps(s)));
  assert.ok(![...s.log].some((l) => l.method === 'DELETE'));

  const car = encodeCarV1([okCid, badCid], [{ cid: okCid, bytes: OK }, { cid: badCid, bytes: BAD }]);
  const post = await handle(get('/ipfs/', { method: 'POST', body: car,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': CAR_CONTENT_TYPE } }), DENV, deps(s));
  assert.equal(post.status, 201);
  assert.equal(post.headers.get(READ_DENIED_HEADER), 'true');

  // Control: an ordinary write carries no mark.
  const plain = await handle(get(`/ipfs/${okCid}`, { method: 'PUT', body: OK,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } }), DENV, deps(s));
  assert.equal(plain.status, 201);
  assert.equal(plain.headers.get(READ_DENIED_HEADER), null);
});

test('an unparseable list fails reads closed with 503, never serving the intended CID', async () => {
  const s = storeWith(OK, BAD);
  const env = { ...ENV, READ_DENY_CIDS: `${badCid.slice(0, -1)}x` };
  for (const c of [okCid, badCid]) {
    const r = await handle(get(`/ipfs/${c}`), env, deps(s));
    assertDenied(r, 503);
    assert.equal(await err(r), 'read-deny-list-invalid');
  }
  assert.equal((await handle(get('/health'), env, deps(s))).status, 200);
});
