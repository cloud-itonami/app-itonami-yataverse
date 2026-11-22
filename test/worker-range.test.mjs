// Range on GET /ipfs/<cid> (AWAI-3833): one bytes range -> 206 with Content-Range; If-Range
// against the ETag "<cid>"; CAR exports and HEAD ignore Range. Also the CIDv0 -> CIDv1 B2 key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV, NOW, fakeStore } from './worker-fixtures.mjs';
import { handle, blockRange, storeKeys } from '../worker/src/index.mjs';
import { rawCid, cidFor, CODEC_DAG_PB } from '../src/cid.mjs';
import { encodePbNode, encodeUnixfsData, UNIXFS_TYPE } from '../src/dag-pb.mjs';

const BYTES = Buffer.from('0123456789abcdefghij'); // 20 bytes
const CID = rawCid(BYTES);

function seeded() {
  const s = fakeStore(); s.objects.set(`ipld/${CID}`, BYTES);
  return { s, deps: { fetchImpl: s.fetchImpl, now: NOW } };
}
const req = (headers = {}, { method = 'GET', cid = CID, query = '' } = {}) =>
  new Request(`https://yataverse.com/ipfs/${cid}${query}`, { method, headers });

test('a single bytes range is answered with 206, the slice and Content-Range', async () => {
  const { deps } = seeded();
  for (const [range, start, end] of [['bytes=0-4', 0, 4], ['bytes=5-', 5, 19], ['bytes=-3', 17, 19],
    ['bytes=10-999', 10, 19], ['bytes=19-19', 19, 19], ['bytes=-50', 0, 19]]) {
    const r = await handle(req({ range }), ENV, deps);
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/20`, range);
    assert.equal(r.headers.get('content-length'), String(end - start + 1), range);
    assert.equal(r.headers.get('etag'), `"${CID}"`);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), BYTES.subarray(start, end + 1), range);
  }
});

test('an unsatisfiable range is 416 with Content-Range: bytes */length', async () => {
  const { deps } = seeded();
  for (const range of ['bytes=20-', 'bytes=25-30', 'bytes=-0']) {
    const r = await handle(req({ range }), ENV, deps);
    assert.equal(r.status, 416, range);
    assert.equal(r.headers.get('content-range'), 'bytes */20');
    assert.equal((await r.arrayBuffer()).byteLength, 0);
  }
});

test('multi-range, other units and malformed Range headers are ignored: 200 with the whole block', async () => {
  const { deps } = seeded();
  for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=5-2', 'bytes=-', 'bytes=a-b', 'bytes 0-1']) {
    const r = await handle(req({ range }), ENV, deps);
    assert.equal(r.status, 200, range);
    assert.equal(r.headers.get('content-range'), null);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), BYTES, range);
  }
  const plain = await handle(req(), ENV, deps);
  assert.equal(plain.status, 200); assert.equal(plain.headers.get('accept-ranges'), 'bytes');
});

test('If-Range: the strong ETag "<cid>" keeps the range; anything else sends the whole block', async () => {
  const { deps } = seeded();
  const ok = await handle(req({ range: 'bytes=0-1', 'if-range': `"${CID}"` }), ENV, deps);
  assert.equal(ok.status, 206); assert.deepEqual(Buffer.from(await ok.arrayBuffer()), BYTES.subarray(0, 2));
  for (const ifRange of [`W/"${CID}"`, '"other"', 'Sun, 22 Nov 2026 00:00:00 GMT', CID]) {
    const r = await handle(req({ range: 'bytes=0-1', 'if-range': ifRange }), ENV, deps);
    assert.equal(r.status, 200, ifRange); assert.deepEqual(Buffer.from(await r.arrayBuffer()), BYTES);
  }
});

test('HEAD ignores Range and answers for the whole block', async () => {
  const { deps } = seeded();
  const h = await handle(req({ range: 'bytes=0-4' }, { method: 'HEAD' }), ENV, deps);
  assert.equal(h.status, 200); assert.equal(h.headers.get('content-length'), '20');
  assert.equal(h.headers.get('accept-ranges'), 'bytes');
});

test('a CAR export ignores Range and If-Range and sends the whole CAR', async () => {
  const { deps } = seeded();
  const whole = await handle(req({}, { query: '?format=car' }), ENV, deps);
  const ranged = await handle(req({ range: 'bytes=0-4', 'if-range': `"${CID}"` }, { query: '?format=car' }), ENV, deps);
  assert.equal(ranged.status, 200); assert.equal(ranged.headers.get('content-range'), null);
  assert.equal(ranged.headers.get('accept-ranges'), 'none');
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), Buffer.from(await whole.arrayBuffer()));
});

test('a read-denied CID stays 451 with a Range header', async () => {
  const { deps } = seeded();
  const r = await handle(req({ range: 'bytes=0-4' }), { ...ENV, READ_DENY_CIDS: CID }, deps);
  assert.equal(r.status, 451);
});

test('a ranged read through READ_FALLBACK_URL is verified as a whole block, then sliced', async () => {
  const s = fakeStore({ fallback: new Map([[CID, BYTES]]) });
  const r = await handle(req({ range: 'bytes=2-3' }), { ...ENV, READ_FALLBACK_URL: 'https://ipfs.yataverse.com' }, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(r.status, 206); assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from('23'));
  const bad = fakeStore({ fallback: new Map([[CID, Buffer.from('tampered bytes......')]]) });
  const t = await handle(req({ range: 'bytes=2-3' }), { ...ENV, READ_FALLBACK_URL: 'https://ipfs.yataverse.com' }, { fetchImpl: bad.fetchImpl, now: NOW });
  assert.equal(t.status, 502);
});

test('CORS lets an allowed read origin send Range and see Content-Range', async () => {
  const { deps } = seeded();
  const env = { ...ENV, IPFS_READ_ORIGINS: 'https://cloud-itonami.github.io' };
  const pre = await handle(new Request(`https://yataverse.com/ipfs/${CID}`, { method: 'OPTIONS', headers: {
    origin: 'https://cloud-itonami.github.io', 'access-control-request-method': 'GET', 'access-control-request-headers': 'range' } }), env, deps);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /\brange\b/);
  const r = await handle(req({ range: 'bytes=0-0', origin: 'https://cloud-itonami.github.io' }), env, deps);
  assert.equal(r.status, 206);
  assert.match(r.headers.get('access-control-expose-headers'), /content-range/);
});

test('blockRange on an empty block: every range is unsatisfiable', () => {
  const r = (range) => blockRange(new Request('https://x/', { headers: { range } }), CID, 0);
  assert.deepEqual(r('bytes=0-'), { unsatisfiable: true });
  assert.deepEqual(r('bytes=-5'), { unsatisfiable: true });
});

test('a CIDv0 read finds a block stored under its CIDv1 dag-pb key', async () => {
  const node = encodePbNode({ links: [], data: encodeUnixfsData({ type: UNIXFS_TYPE.file, data: Buffer.from('v0 leaf'), filesize: 7 }) });
  const v1 = cidFor(node, CODEC_DAG_PB);
  // base58btc of 0x12 0x20 <digest>, written out by hand so the test does not reuse the code under test.
  const digest = Buffer.from(require_sha(node));
  const v0 = base58([0x12, 0x20, ...digest]);
  assert.deepEqual(storeKeys(v0), [v0, v1]);
  assert.deepEqual(storeKeys(v1), [v1]);
  const s = fakeStore(); s.objects.set(`ipld/${v1}`, node);
  const r = await handle(req({}, { cid: v0 }), ENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), node);
  assert.equal(r.headers.get('etag'), `"${v0}"`);
});

import crypto from 'node:crypto';
function require_sha(b) { return crypto.createHash('sha256').update(b).digest(); }
function base58(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')); let out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

test('Yataverse-Read-Source tells a B2 copy from a READ_FALLBACK_URL copy', async () => {
  const s = fakeStore({ fallback: new Map([[CID, BYTES]]) });
  const env = { ...ENV, READ_FALLBACK_URL: 'https://ipfs.yataverse.com' };
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const fb = await handle(req({}, { method: 'HEAD' }), env, deps);
  assert.equal(fb.status, 200); assert.equal(fb.headers.get('yataverse-read-source'), 'fallback');
  s.objects.set(`ipld/${CID}`, BYTES);
  const st = await handle(req({ range: 'bytes=0-0' }), env, deps);
  assert.equal(st.status, 206); assert.equal(st.headers.get('yataverse-read-source'), 'store');
});
