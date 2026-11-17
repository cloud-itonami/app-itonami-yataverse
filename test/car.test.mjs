import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCarV1, parseCar } from '../src/car.mjs';
import { cidFor, cidToBytes, CODEC_DAG_CBOR, CODEC_RAW } from '../src/cid.mjs';
import { handle } from '../worker/src/index.mjs';
import { makeClient } from '../src/client.mjs';
import { ENV, TOKEN, NOW, fakeStore } from './worker-fixtures.mjs';

// --- a tiny canonical DAG-CBOR encoder for test fixtures (text keys, links, arrays) ---
const te = new TextEncoder();
const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255];
function enc(v) {
  if (typeof v === 'string') { const b = te.encode(v); return Uint8Array.from([...head(3, b.length), ...b]); }
  if (typeof v === 'number') return Uint8Array.from(head(0, v));
  if (Array.isArray(v)) return Uint8Array.from([...head(4, v.length), ...v.flatMap((x) => [...enc(x)])]);
  if (v && v.link) { const c = Uint8Array.from([0, ...cidToBytes(v.link)]); return Uint8Array.from([0xd8, 0x2a, ...head(2, c.length), ...c]); }
  const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return Uint8Array.from([...head(5, keys.length), ...keys.flatMap((k) => [...enc(k), ...enc(v[k])])]);
}
const raw = (s) => { const bytes = te.encode(s); return { cid: cidFor(bytes, CODEC_RAW), bytes }; };
const node = (v) => { const bytes = enc(v); return { cid: cidFor(bytes, CODEC_DAG_CBOR), bytes }; };

function fixture() {
  const leaf1 = raw('leaf one'), leaf2 = raw('leaf two');
  const child = node({ x: { link: leaf2.cid }, n: 7 });
  const root = node({ a: { link: leaf1.cid }, kids: [{ link: child.cid }, { link: leaf1.cid }], type: 'awai-test' });
  return { root, child, leaf1, leaf2, all: [root, leaf1, child, leaf2] };   // DFS order, dups=n
}

const deps = (s) => ({ fetchImpl: s.fetchImpl, now: NOW });
const post = (body, { auth = `Bearer ${TOKEN}`, ct = 'application/vnd.ipld.car' } = {}) =>
  new Request('https://yataverse.com/ipfs/', { method: 'POST', body, headers: { authorization: auth, 'content-type': ct } });
const getCar = (cid, q = 'format=car') => new Request(`https://yataverse.com/ipfs/${cid}?${q}`);

test('CAR encode/parse round trip; duplicates collapse; CARv2 payload is read', () => {
  const f = fixture();
  const car = encodeCarV1([f.root.cid], [...f.all, f.leaf1]);
  const p = parseCar(car);
  assert.deepEqual(p.roots, [f.root.cid]);
  assert.deepEqual(p.blocks.map((b) => b.cid), f.all.map((b) => b.cid));
  const v1 = encodeCarV1([f.root.cid], f.all);
  const pragma = Uint8Array.from([0x0a, 0xa1, 0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x02]);
  const hdr = new Uint8Array(40); const dv = new DataView(hdr.buffer);
  dv.setBigUint64(16, 51n, true); dv.setBigUint64(24, BigInt(v1.length), true); dv.setBigUint64(32, 0n, true);
  const v2 = parseCar(Uint8Array.from([...pragma, ...hdr, ...v1]));
  assert.equal(v2.version, 2); assert.deepEqual(v2.roots, [f.root.cid]); assert.equal(v2.blocks.length, 4);
});

test('CAR parser refuses malformed input', () => {
  const f = fixture(); const good = encodeCarV1([f.root.cid], f.all);
  assert.throws(() => parseCar(good.subarray(0, good.length - 3)), { code: 'car-truncated' });
  assert.throws(() => parseCar(good, { maxBlocks: 2 }), { code: 'car-too-many-blocks' });
  // header with keys out of order: {version:1, roots:[]} -> not canonical DAG-CBOR
  const badHeader = Uint8Array.from([0x11, 0xa2, 0x67, ...te.encode('version'), 0x01, 0x65, ...te.encode('roots'), 0x80]);
  assert.throws(() => parseCar(badHeader), { code: 'car-header-not-canonical-dag-cbor' });
  const noRoots = Uint8Array.from([0x11, 0xa2, 0x65, ...te.encode('roots'), 0x80, 0x67, ...te.encode('version'), 0x01]);
  assert.throws(() => parseCar(noRoots), { code: 'car-no-roots' });
  const v2 = Uint8Array.from([0x11, 0xa2, 0x65, ...te.encode('roots'), 0x80, 0x67, ...te.encode('version'), 0x02]);
  assert.throws(() => parseCar(v2), { code: 'car-header-invalid' });
});

test('import stores a complete DAG after checking everything; export returns it in DFS order', async () => {
  const s = fakeStore(); const f = fixture();
  const r = await handle(post(encodeCarV1([f.root.cid], f.all)), ENV, deps(s));
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.deepEqual([j.roots, j.blocks, j.external, j.verified], [[f.root.cid], 4, [], true]);
  assert.equal(s.objects.size, 4);
  const e = await handle(getCar(f.root.cid), ENV, deps(s));
  assert.equal(e.status, 200);
  assert.match(e.headers.get('content-type'), /^application\/vnd\.ipld\.car; version=1; order=dfs; dups=n$/);
  const back = parseCar(new Uint8Array(await e.arrayBuffer()));
  assert.deepEqual(back.blocks.map((b) => b.cid), f.all.map((b) => b.cid));
  const one = parseCar(new Uint8Array(await (await handle(getCar(f.root.cid, 'format=car&dag-scope=block'), ENV, deps(s))).arrayBuffer()));
  assert.deepEqual(one.blocks.map((b) => b.cid), [f.root.cid]);
  const viaAccept = await handle(new Request(`https://yataverse.com/ipfs/${f.root.cid}`, { headers: { accept: 'application/vnd.ipld.car' } }), ENV, deps(s));
  assert.equal(viaAccept.status, 200);
});

test('import refuses bad CARs before storing anything', async () => {
  const f = fixture();
  const cases = [
    [encodeCarV1([f.root.cid], [f.leaf1, f.child, f.leaf2]), 400, /^car-root-missing:/],
    [encodeCarV1([f.root.cid], [f.root, f.leaf1, f.child]), 400, /^closure-incomplete:/],
    [encodeCarV1([f.root.cid], [...f.all, raw('stray')]), 400, /^block-not-reachable:/],
    [encodeCarV1([f.root.cid], [f.root, { cid: f.leaf1.cid, bytes: te.encode('tampered') }, f.child, f.leaf2]), 400, /^bytes-do-not-hash-to-cid:/],
  ];
  for (const [car, status, re] of cases) {
    const s = fakeStore();
    const r = await handle(post(car), ENV, deps(s));
    assert.equal(r.status, status); assert.match((await r.json()).error, re);
    assert.equal(s.objects.size, 0);
  }
  const s = fakeStore(); const car = encodeCarV1([f.root.cid], f.all);
  assert.equal((await handle(post(car), { ...ENV, MAX_CAR_BLOCKS: '3' }, deps(s))).status, 413);
  assert.equal((await handle(post(car), { ...ENV, MAX_CAR_BYTES: '64' }, deps(s))).status, 413);
  assert.equal((await handle(post(car, { auth: 'Bearer wrong-token-000000' }), ENV, deps(s))).status, 401);
  assert.equal((await handle(post(car, { ct: 'application/octet-stream' }), ENV, deps(s))).status, 415);
  assert.equal(s.objects.size, 0);
});

test('import accepts links to blocks that are already stored, and reports them as external', async () => {
  const s = fakeStore(); const f = fixture();
  assert.equal((await handle(post(encodeCarV1([f.child.cid], [f.child, f.leaf2])), ENV, deps(s))).status, 201);
  const r = await handle(post(encodeCarV1([f.root.cid], [f.root, f.leaf1])), ENV, deps(s));
  assert.equal(r.status, 201); assert.deepEqual((await r.json()).external, [f.child.cid]);
});

test('export never returns a truncated DAG and refuses unsupported options', async () => {
  const s = fakeStore(); const f = fixture();
  await handle(post(encodeCarV1([f.root.cid], f.all)), ENV, deps(s));
  s.objects.delete(`ipld/${f.leaf2.cid}`);
  const r = await handle(getCar(f.root.cid), ENV, deps(s));
  assert.equal(r.status, 502); assert.match((await r.json()).error, /^closure-incomplete:/);
  assert.equal((await handle(getCar(f.root.cid, 'format=car&dag-scope=entity'), ENV, deps(s))).status, 400);
  assert.equal((await handle(getCar(f.root.cid, 'format=tar'), ENV, deps(s))).status, 400);
  assert.equal((await handle(getCar(raw('absent').cid), ENV, deps(s))).status, 404);
  assert.equal((await handle(getCar(f.root.cid), { ...ENV, MAX_CAR_BLOCKS: '2' }, deps(s))).status, 422);
});

test('client putCar and getCar verify the round trip end to end', async () => {
  const s = fakeStore(); const f = fixture();
  const fetchImpl = (url, init = {}) => handle(new Request(url, init), ENV, deps(s));
  const cfg = { url: 'https://yataverse.com', readUrl: 'https://yataverse.com', prefix: '/ipfs/' };
  const client = makeClient(cfg, { fetchImpl, authorize: async () => `Bearer ${TOKEN}` });
  const put = await client.putCar(encodeCarV1([f.root.cid], f.all));
  assert.deepEqual(put, { roots: [f.root.cid], blocks: 4, external: [], verified: true });
  const got = await client.getCar(f.root.cid);
  assert.deepEqual([...got.blocks.keys()], f.all.map((b) => b.cid));
  // a server that returns a CAR missing a linked block is caught by the client
  const lying = makeClient(cfg, { fetchImpl: async (url, init) => {
    if (String(url).includes('format=car')) return new Response(encodeCarV1([f.root.cid], [f.root, f.leaf1, f.child]), { status: 200 });
    return fetchImpl(url, init);
  } });
  await assert.rejects(lying.getCar(f.root.cid), (e) => e.code === 'car-closure-incomplete');
  await assert.rejects(client.putCar(encodeCarV1([f.root.cid], [f.leaf1])), (e) => e.code === 'car-root-missing');
});
