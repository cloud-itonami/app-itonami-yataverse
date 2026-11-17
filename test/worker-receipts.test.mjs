import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handle } from '../worker/src/index.mjs';
import { rawCid, cidToBytes, parseCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';
import { verifyReceipt, envelopeFromJson, envelopeFromDagCbor, envelopeToDagCbor, rootsCommitment, blockSetDigest, KIND, ZERO32 } from '../src/receipt.mjs';
import { ENV, TOKEN, NOW, fakeStore, dataKeys, receiptKey, RECEIPT_KEY } from './worker-fixtures.mjs';

const deps = (s, now = NOW) => ({ fetchImpl: s.fetchImpl, now });
const sha = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const hex = (b) => Buffer.from(b).toString('hex');
const putBlock = (bytes, headers = {}) => new Request(`https://yataverse.com/ipfs/${rawCid(bytes)}`, { method: 'PUT', body: bytes,
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw', ...headers } });
const pack = fs.readFileSync(new URL('./fixtures/drive-v1.car', import.meta.url));
const packId = hex(sha(pack));
const putPack = (headers = {}) => new Request(`https://yataverse.com/awai-drive/v1/packs/${packId}`, { method: 'PUT', body: pack,
  headers: { 'content-type': 'application/vnd.ipld.car', origin: 'http://tauri.localhost', ...headers } });
const verify = (body, expect) => verifyReceipt(envelopeFromJson(body.receipt), RECEIPT_KEY.keys, expect);

test('block, CAR and Drive pack writes return receipts that verify against the published keys', async () => {
  const s = fakeStore();
  const bytes = Buffer.from('a receipted block');
  const b = await (await handle(putBlock(bytes), ENV, deps(s))).json();
  const r1 = await verify(b, { kind: KIND.block, subject: cidToBytes(rawCid(bytes)), contentDigest: sha(bytes), size: bytes.length });
  assert.deepEqual(r1.requester, sha(TOKEN), 'requester is the SHA-256 of the write token');
  assert.deepEqual(r1.requestId, sha(bytes), 'without a request id header, requestId is the content digest');
  assert.equal(r1.acceptedAt, NOW().getTime()); assert.equal(r1.retentionUntil, 0);

  const leaf = Buffer.from('leaf'); const leafCid = rawCid(leaf);
  const car = encodeCarV1([leafCid], [{ cid: leafCid, bytes: leaf }]);
  const c = await (await handle(new Request('https://yataverse.com/ipfs/', { method: 'POST', body: car,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.car' } }), ENV, deps(s))).json();
  await verify(c, { kind: KIND.car, subject: rootsCommitment([leafCid]), contentDigest: blockSetDigest([leafCid]), size: leaf.length });

  const res = await handle(putPack(), ENV, deps(s));
  const raw = new Uint8Array(await res.arrayBuffer());
  assert.ok(raw.length <= 2048, `Drive receipt bound: ${raw.length} bytes`);
  const d = JSON.parse(new TextDecoder().decode(raw));
  assert.equal(d.sha256, packId); assert.equal(d.bytes, pack.length);   // Drive's own check still passes
  const r3 = await verify(d, { kind: KIND.drivePack, subject: sha(pack), contentDigest: sha(pack), size: pack.length });
  assert.deepEqual(r3.requester, ZERO32, 'Drive sends no credentials: requester 0, no IP hash');

  // The stored record is the same receipt, and its CID is the one returned.
  const rec = s.objects.get(`ipld/receipts/by-request/${packId}`);
  assert.equal(envelopeToDagCbor(envelopeFromDagCbor(rec)).cid, d.receiptCid);
  await verifyReceipt(envelopeFromDagCbor(rec), RECEIPT_KEY.keys);
});

test('a repeated request gets the same receipt; a different write under the same id is 409 and stores nothing', async () => {
  const s = fakeStore();
  const rid = 'ab'.repeat(32);
  const one = Buffer.from('first write');
  const a = await (await handle(putBlock(one, { 'yataverse-request-id': rid }), ENV, deps(s))).json();
  const later = () => new Date(NOW().getTime() + 60_000);
  const again = await (await handle(putBlock(one, { 'yataverse-request-id': rid }), ENV, deps(s, later))).json();
  assert.deepEqual(again.receipt, a.receipt, 'same receipt, same acceptedAt');
  assert.equal(again.receiptCid, a.receiptCid);
  const before = dataKeys(s).length;
  const conflict = await handle(putBlock(Buffer.from('other write'), { 'yataverse-request-id': rid }), ENV, deps(s, later));
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, 'request-id-conflict');
  assert.equal(dataKeys(s).length, before, 'the conflicting block was not stored');
  // Same id and bytes but another requester (another token) is also a conflict.
  const other = 'yv_write_other_token_0000';
  const env2 = { ...ENV, WRITE_TOKEN_SHA256: `${ENV.WRITE_TOKEN_SHA256},${hex(sha(other))}` };
  const r = await handle(putBlock(one, { 'yataverse-request-id': rid, authorization: `Bearer ${other}` }), env2, deps(s));
  assert.equal(r.status, 409);
  // Drive re-upload of the same pack: same receipt.
  const p1 = await (await handle(putPack(), ENV, deps(s))).json();
  const p2 = await (await handle(putPack(), ENV, deps(s, later))).json();
  assert.deepEqual(p2.receipt, p1.receipt);
  assert.equal((await handle(putBlock(one, { 'yataverse-request-id': 'not-hex' }), ENV, deps(s))).status, 400);
});

test('writes fail closed without a usable, published signing key, and store nothing', async () => {
  const other = receiptKey();
  const cases = [
    [{ ...ENV, RECEIPT_SIGNING_KEY: '' }, 'receipts-not-configured'],
    [{ ...ENV, RECEIPT_SIGNING_KEY: '{"kty":"OKP"}' }, 'receipt-key-invalid'],
    [{ ...ENV, RECEIPT_PUBLIC_KEYS: other.keys }, 'receipt-key-not-published'],
    [{ ...ENV, RECEIPT_PUBLIC_KEYS: receiptKeyWith({ revokedAt: 1 }) }, 'receipt-key-not-valid-now'],
    [{ ...ENV, RECEIPT_PUBLIC_KEYS: receiptKeyWith({ notBefore: NOW().getTime() + 1 }) }, 'receipt-key-not-valid-now'],
  ];
  for (const [env, code] of cases) {
    const s = fakeStore();
    const r = await handle(putBlock(Buffer.from(`no receipt ${code}`)), env, deps(s));
    assert.equal(r.status, 503, code); assert.equal((await r.json()).error, code);
    const p = await handle(putPack(), env, deps(s));
    assert.equal(p.status, 503, code);
    assert.equal(p.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
    assert.equal(s.objects.size, 0, `${code}: nothing stored`);
  }
  // Reads do not need the key.
  const s = fakeStore(); const bytes = Buffer.from('read without key');
  await handle(putBlock(bytes), ENV, deps(s));
  assert.equal((await handle(new Request(`https://yataverse.com/ipfs/${rawCid(bytes)}`), { ...ENV, RECEIPT_SIGNING_KEY: '' }, deps(s))).status, 200);
});
function receiptKeyWith(extra) {
  return { ...RECEIPT_KEY.keys, keys: [{ ...RECEIPT_KEY.keys.keys[0], ...extra }] };
}

test('the receipt is not issued when the store write or receipt write fails', async () => {
  const s = fakeStore({ mode: 'put-fails' });
  const r = await handle(putBlock(Buffer.from('will fail')), ENV, deps(s));
  assert.equal(r.status, 502);
  assert.equal(s.objects.size, 0);
});

test('keys, DID document and policy are published; the policy block is readable by CID', async () => {
  const s = fakeStore();
  const keys = await (await handle(new Request('https://yataverse.com/.well-known/yataverse-receipt-keys.json'), ENV, deps(s))).json();
  assert.deepEqual(keys, RECEIPT_KEY.keys);
  const did = await (await handle(new Request('https://yataverse.com/.well-known/did.json'), ENV, deps(s))).json();
  assert.equal(did.id, 'did:web:yataverse.com');
  assert.equal(did.verificationMethod[0].id, `did:web:yataverse.com#${RECEIPT_KEY.keyId}`);
  assert.deepEqual(did.assertionMethod, [did.verificationMethod[0].id]);
  const revoked = await (await handle(new Request('https://yataverse.com/.well-known/did.json'), { ...ENV, RECEIPT_PUBLIC_KEYS: receiptKeyWith({ revokedAt: 5 }) }, deps(s))).json();
  assert.deepEqual(revoked.assertionMethod, [], 'a revoked key stays listed but not usable for assertions');

  const bytes = Buffer.from('policy check');
  const body = await (await handle(putBlock(bytes), ENV, deps(s))).json();
  const rev = body.receipt.receipt.policyRevision;
  const pol = await (await handle(new Request(`https://yataverse.com/.well-known/yataverse-policy/${rev.slice(2)}.json`), ENV, deps(s))).json();
  assert.equal(pol.revision, rev); assert.equal(pol.policy.source, 'test');
  assert.equal(pol.policy.limits.external.wafRateLimit.requests, 10);
  assert.equal(pol.policy.store.prefix, 'ipld/');
  const cur = await (await handle(new Request('https://yataverse.com/.well-known/yataverse-policy/current.json'), ENV, deps(s))).json();
  assert.equal(cur.revision, rev);
  // The policy is an ordinary dag-cbor block whose sha256 is the revision.
  assert.equal(hex(parseCid(pol.cid).digest), rev.slice(2));
  assert.ok(s.objects.has(`ipld/${pol.cid}`), 'policy block stored');
  assert.equal((await handle(new Request(`https://yataverse.com/ipfs/${pol.cid}`), ENV, deps(s))).status, 200);
  s.objects.delete(`ipld/${pol.cid}`);                                   // lost: the next receipt stores it again
  await handle(putBlock(Buffer.from('policy check 2')), ENV, deps(s));
  assert.ok(s.objects.has(`ipld/${pol.cid}`));
  assert.equal((await handle(new Request(`https://yataverse.com/.well-known/yataverse-policy/${'0'.repeat(64)}.json`), ENV, deps(s))).status, 404);
  assert.equal((await handle(new Request('https://yataverse.com/.well-known/nope'), ENV, deps(s))).status, 404);
  assert.equal((await handle(new Request('https://yataverse.com/.well-known/did.json', { method: 'POST' }), ENV, deps(s))).status, 405);
});
