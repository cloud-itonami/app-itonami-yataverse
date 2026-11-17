import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, sha, ENV, NOW, fakeStore, dataKeys } from './worker-fixtures.mjs';
import { handle, tokenAllowed } from '../worker/src/index.mjs';
import { signV4, regionFromEndpoint } from '../worker/src/sigv4.mjs';
import { rawCid, cidFor, CODEC_DAG_CBOR } from '../src/cid.mjs';

const put = (cid, body, { auth = `Bearer ${TOKEN}`, ct = 'application/vnd.ipld.raw' } = {}) =>
  new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'PUT', body, headers: { authorization: auth, 'content-type': ct } });
const get = (cid, method = 'GET') => new Request(`https://yataverse.com/ipfs/${cid}`, { method });

test('PUT stores, reads back and verifies; GET then serves the same bytes', async () => {
  const s = fakeStore(); const bytes = Buffer.from('hello yataverse'); const cid = rawCid(bytes);
  const res = await handle(put(cid, bytes), ENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual({ cid: body.cid, bytes: body.bytes, verified: body.verified }, { cid, bytes: bytes.length, verified: true });
  assert.equal(body.receipt.v, 1); assert.match(body.receiptCid, /^bafyrei/);
  assert.ok(s.objects.has(`ipld/${cid}`));
  assert.ok(s.log.every((r) => r.redirect === 'manual'));
  const g = await handle(get(cid), ENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'application/vnd.ipld.raw');
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), bytes);
  const h = await handle(get(cid, 'HEAD'), ENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(h.status, 200); assert.equal(h.headers.get('content-length'), String(bytes.length));
});

test('PUT refuses a missing or wrong token, wrong type, mismatched bytes and non-raw CIDs before storing', async () => {
  const s = fakeStore(); const bytes = Buffer.from('x'.repeat(20)); const cid = rawCid(bytes);
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  assert.equal((await handle(put(cid, bytes, { auth: 'Bearer wrong-token-0000000' }), ENV, deps)).status, 401);
  assert.equal((await handle(put(cid, bytes, { auth: '' }), ENV, deps)).status, 401);
  assert.equal((await handle(put(cid, bytes, { ct: 'text/plain' }), ENV, deps)).status, 415);
  assert.equal((await handle(put(cid, Buffer.from('other bytes here')), ENV, deps)).status, 400);
  const dagPb = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  assert.equal((await handle(put(dagPb, bytes), ENV, deps)).status, 400);
  assert.equal((await handle(put(cid, Buffer.alloc(2048, 1)), ENV, deps)).status, 413); // size is checked before hashing
  assert.equal(dataKeys(s).length, 0);
  assert.equal(s.log.length, 0);
});

test('PUT over the size cap is 413 and writes are 503 without a configured token', async () => {
  const s = fakeStore(); const big = Buffer.alloc(2048, 7); const cid = rawCid(big);
  assert.equal((await handle(put(cid, big), ENV, { fetchImpl: s.fetchImpl, now: NOW })).status, 413);
  const small = Buffer.from('small block bytes'); const c2 = rawCid(small);
  assert.equal((await handle(put(c2, small), { ...ENV, WRITE_TOKEN_SHA256: '' }, { fetchImpl: s.fetchImpl, now: NOW })).status, 503);
  assert.equal(dataKeys(s).length, 0);
});

test('PUT accepts canonical DAG-CBOR and refuses non-canonical DAG-CBOR under a dag-cbor CID', async () => {
  const s = fakeStore(); const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const doc = Buffer.from('a2616101616202', 'hex');            // {"a":1,"b":2}
  const cid = cidFor(doc, CODEC_DAG_CBOR);
  const ok = await handle(put(cid, doc), ENV, deps);
  assert.equal(ok.status, 201); assert.equal((await ok.json()).cid, cid);
  const g = await handle(get(cid), ENV, deps);
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), doc);
  const unsorted = Buffer.from('a2616201616102', 'hex');       // {"b":1,"a":2}: keys out of order
  const r = await handle(put(cidFor(unsorted, CODEC_DAG_CBOR), unsorted), ENV, deps);
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'not-canonical-dag-cbor:map-keys-not-sorted');
  assert.equal(dataKeys(s).length, 1);
});

test('a failed store write or a corrupt readback is never reported as success', async () => {
  const bytes = Buffer.from('important block'); const cid = rawCid(bytes);
  let s = fakeStore({ mode: 'put-fails' });
  assert.equal((await handle(put(cid, bytes), ENV, { fetchImpl: s.fetchImpl, now: NOW })).status, 502);
  s = fakeStore({ mode: 'corrupt-store' });
  const r = await handle(put(cid, bytes), ENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'readback-does-not-hash-to-cid');
  const g = await handle(get(cid), ENV, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(g.status, 502);
});

test('GET falls back to the configured Reader only on a B2 miss, and verifies those bytes too', async () => {
  const good = Buffer.from('lake block on xavier'); const cid = rawCid(good);
  const other = Buffer.from('another lake block'); const cid2 = rawCid(other);
  const fallback = new Map([[cid, good], [cid2, Buffer.from('tampered')]]);
  const s = fakeStore({ fallback });
  const env = { ...ENV, READ_FALLBACK_URL: 'https://ipfs.yataverse.com' };
  const ok = await handle(get(cid), env, { fetchImpl: s.fetchImpl, now: NOW });
  assert.equal(ok.status, 200); assert.deepEqual(Buffer.from(await ok.arrayBuffer()), good);
  assert.equal((await handle(get(cid2), env, { fetchImpl: s.fetchImpl, now: NOW })).status, 502);
  const absent = rawCid(Buffer.from('nowhere'));
  assert.equal((await handle(get(absent), env, { fetchImpl: s.fetchImpl, now: NOW })).status, 404);
  assert.equal((await handle(get(absent), ENV, { fetchImpl: s.fetchImpl, now: NOW })).status, 404);
  assert.ok(!s.log.some((r) => r.host === 'ipfs.yataverse.com' && r.auth));
});

test('routing: health, bad CIDs, unknown paths and methods; store config is required', async () => {
  const s = fakeStore(); const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const h = await handle(new Request('https://yataverse.com/health'), {}, deps);
  assert.equal(h.status, 200); assert.deepEqual(await h.json(), { ok: true, service: 'yataverse-bytes' });
  assert.equal((await handle(new Request('https://yataverse.com/ipfs/not-a-cid'), ENV, deps)).status, 404);
  assert.equal((await handle(new Request('https://yataverse.com/ipfs/bafkreinotacid'), ENV, deps)).status, 400);
  assert.equal((await handle(new Request('https://yataverse.com/'), ENV, deps)).status, 404);
  const cid = rawCid(Buffer.from('m'));
  assert.equal((await handle(new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'DELETE' }), ENV, deps)).status, 405);
  assert.equal((await handle(get(cid), { ...ENV, B2_APP_KEY: '' }, deps)).status, 503);
  assert.equal(s.log.length, 0);
});

test('the default fetch is called without a foreign `this` (Workers rejects that)', async () => {
  const s = fakeStore(); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = function (input, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls += 1; return s.fetchImpl(input, init);
  };
  try {
    const bytes = Buffer.from('unbound fetch'); const cid = rawCid(bytes);
    assert.equal((await handle(put(cid, bytes), ENV, { now: NOW })).status, 201);
    assert.ok(calls >= 2);
  } finally { globalThis.fetch = original; }
});

test('tokenAllowed accepts any configured digest and ignores malformed entries', () => {
  assert.equal(tokenAllowed(`Bearer ${TOKEN}`, `zz, ${sha('another-token-123456')}, ${sha(TOKEN)}`), true);
  assert.equal(tokenAllowed(`Bearer ${TOKEN}`, 'not-hex'), false);
  assert.equal(tokenAllowed(`Basic ${TOKEN}`, sha(TOKEN)), false);
  assert.equal(tokenAllowed('Bearer short', sha('short')), false);
});

test('signV4 matches the AWS S3 GET Object example signature', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  const h = signV4({
    method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
    + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(regionFromEndpoint('https://s3.eu-central-003.backblazeb2.com'), 'eu-central-003');
  assert.equal(regionFromEndpoint('https://example.com'), null);
});
