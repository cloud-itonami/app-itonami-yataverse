import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { keccak256 } from '../src/keccak.mjs';
import { domainSeparator, hashStruct, Eip712Error } from '../src/eip712.mjs';
import { encodeDagCbor, decodeDagCbor } from '../src/dag-cbor.mjs';
import {
  RECEIPT_FIELDS, RECEIPT_DOMAIN, RECEIPT_TYPE_STRING, STATE, KIND, receiptDigest, keyIdFor, importSigningKey,
  signReceipt, verifyReceipt, envelopeToJson, envelopeFromJson, envelopeToDagCbor, envelopeFromDagCbor,
  rootsCommitment, blockSetDigest, policyRecord, ReceiptError,
} from '../src/receipt.mjs';
import { rawCid } from '../src/cid.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));
// Oracle: viem 2.21.0 hashTypedData/hashDomain/keccak256, run once on 2026-11-18 (record in
// docs/storage-receipt-design.md §11). The Ether Mail domain separator is the EIP-712 example.
const VECTOR = JSON.parse(readFileSync(new URL('./fixtures/receipt-vector.json', import.meta.url), 'utf8'));
const VECTOR_DIGEST = '0e99111ec7716683f80460a9e79243824830ba37dbe3d2ee3b9a9d4b31c0e3a9';
const fieldsFromVector = (j) => Object.fromEntries(RECEIPT_FIELDS.map(([n, t]) => [n, t.startsWith('uint') ? j[n] : unhex(j[n])]));

export function newKeyJwk() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const j = privateKey.export({ format: 'jwk' });
  return { kty: j.kty, crv: j.crv, d: j.d, x: j.x };
}
export function publishedKeys(signer, jwk, extra = {}) {
  return { v: 1, signer: 'did:web:yataverse.com', keys: [{ keyId: '0x' + hex(signer.keyId), keyEpoch: 1, alg: 'Ed25519',
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, notBefore: 0, notAfter: null, revokedAt: null, ...extra }] };
}

test('keccak256 matches known vectors', () => {
  assert.equal(hex(keccak256(new Uint8Array(0))), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(hex(keccak256(Buffer.from('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(hex(keccak256(Buffer.alloc(200, 0x61))), '96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d', 'two blocks (oracle)');
  // Negative control: FIPS SHA3-256 of "" differs, so a sha3 substitution would fail the line above.
  assert.notEqual(crypto.createHash('sha3-256').update('').digest('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});

test('EIP-712 domain separators and the receipt digest match the oracle', () => {
  assert.equal(hex(domainSeparator({ name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: unhex('CcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC') })),
    'f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f');
  assert.equal(hex(domainSeparator(RECEIPT_DOMAIN)), '0a22e1d01718aac7aa4fa15a8ea92d916117fad7b833e886730786bedf6a6b97');
  assert.equal(hex(receiptDigest(fieldsFromVector(VECTOR))), VECTOR_DIGEST);
  assert.match(RECEIPT_TYPE_STRING, /^YataverseStorageReceipt\(uint8 kind,bytes subject,uint64 size,bytes32 contentDigest,/);
  // Every field is in the digest: changing any one of them changes it.
  for (const [n, t] of RECEIPT_FIELDS) {
    const f = fieldsFromVector(VECTOR);
    if (t.startsWith('uint')) f[n] = f[n] === 1 ? 2 : 1; else { f[n] = new Uint8Array(f[n]); f[n][0] ^= 1; }
    assert.notEqual(hex(receiptDigest(f)), VECTOR_DIGEST, n);
  }
});

test('EIP-712 encoding refuses wrong shapes', () => {
  const F = [['a', 'uint8'], ['b', 'bytes32']];
  assert.throws(() => hashStruct('T', F, { a: 256, b: new Uint8Array(32) }), Eip712Error);
  assert.throws(() => hashStruct('T', F, { a: 1, b: new Uint8Array(31) }), Eip712Error);
  assert.throws(() => hashStruct('T', F, { a: 1 }), Eip712Error);
  assert.throws(() => hashStruct('T', F, { a: 1, b: new Uint8Array(32), c: 1 }), Eip712Error);
  assert.throws(() => hashStruct('T', [['a', 'T2']], { a: {} }), Eip712Error);
});

test('DAG-CBOR encoder output is canonical and round-trips', () => {
  const v = { b: 1, aa: 'x', z: [0, 23, 24, 255, 256, 65535, 65536, 2 ** 32, -1, -25], bytes: new Uint8Array([1, 2]), n: null, t: true,
              link: { cid: unhex('01551220' + '00'.repeat(32)) } };
  const bytes = encodeDagCbor(v);
  assert.equal(hex(encodeDagCbor({ b: 1, aa: 2 })), 'a26162016261610' + '2');
  const back = decodeDagCbor(bytes).value;
  assert.equal(back.get('aa'), 'x');
  assert.deepEqual(back.get('z'), [0n, 23n, 24n, 255n, 256n, 65535n, 65536n, 2n ** 32n, -1n, -25n]);
  assert.deepEqual(encodeDagCbor(back), bytes, 're-encoding the decoded value gives the same bytes');
  for (const bad of [1.5, undefined, () => 1, { a: undefined }, 2 ** 64 * 2]) assert.throws(() => encodeDagCbor(bad));
  assert.throws(() => encodeDagCbor(2n ** 64n));
});

test('a signed receipt verifies, in JSON and DAG-CBOR form', async () => {
  const jwk = newKeyJwk();
  const signer = await importSigningKey(jwk);
  assert.deepEqual(signer.keyId, keyIdFor(signer.publicKey));
  const fields = { ...fieldsFromVector(VECTOR), keyId: signer.keyId, acceptedAt: 1795046400000 };
  const env = await signReceipt(fields, signer);
  const keys = publishedKeys(signer, jwk);
  await verifyReceipt(env, keys, { subject: fields.subject, contentDigest: fields.contentDigest, size: fields.size, kind: KIND.drivePack });
  const json = JSON.parse(JSON.stringify(envelopeToJson(env)));
  assert.ok(JSON.stringify({ sha256: 'a'.repeat(64), bytes: 12494, receipt: json }).length < 2048, 'fits the Drive 2048-byte receipt bound');
  await verifyReceipt(envelopeFromJson(json), keys);
  const { bytes, cid } = envelopeToDagCbor(env);
  assert.match(cid, /^bafyrei/);
  await verifyReceipt(envelopeFromDagCbor(bytes), keys);
  assert.deepEqual(envelopeToDagCbor(envelopeFromJson(json)).bytes, bytes, 'JSON and DAG-CBOR carry the same values');
});

test('verification rejects tampering, other keys, key lifetime, and gateway overclaims', async () => {
  const jwk = newKeyJwk(); const signer = await importSigningKey(jwk);
  const other = newKeyJwk(); const otherSigner = await importSigningKey(other);
  const base = { ...fieldsFromVector(VECTOR), keyId: signer.keyId, acceptedAt: 1000 };
  const env = await signReceipt(base, signer);
  const keys = publishedKeys(signer, jwk);
  const rejects = async (e, k, code, expect) => assert.rejects(verifyReceipt(e, k, expect), (err) => err instanceof ReceiptError && err.code === code, code);

  await rejects({ ...env, receipt: { ...env.receipt, size: env.receipt.size + 1 } }, keys, 'bad-signature');
  const flipped = new Uint8Array(env.sig.sig); flipped[0] ^= 1;
  await rejects({ ...env, sig: { ...env.sig, sig: flipped } }, keys, 'bad-signature');
  // Signed by another key but claiming this keyId.
  const forged = await signReceipt({ ...base, keyId: otherSigner.keyId }, otherSigner);
  await rejects({ ...forged, receipt: { ...forged.receipt, keyId: signer.keyId }, sig: { ...forged.sig, key: signer.keyId } }, keys, 'bad-signature');
  await rejects(forged, keys, 'unknown-key');
  await rejects(env, publishedKeys(signer, jwk, { keyEpoch: 2 }), 'key-epoch-mismatch');
  await rejects(env, publishedKeys(signer, jwk, { notBefore: 1001 }), 'accepted-before-key-valid');
  await rejects(env, publishedKeys(signer, jwk, { notAfter: 1000 }), 'accepted-after-key-expired');
  await rejects(env, publishedKeys(signer, jwk, { revokedAt: 1000 }), 'key-revoked');
  await verifyReceipt(env, publishedKeys(signer, jwk, { revokedAt: 1001 }));   // revoked later: still valid
  await rejects(env, publishedKeys(signer, { ...jwk, x: other.x }), 'published-key-does-not-match-key-id');
  // A correctly signed receipt in which the gateway claims policy-satisfied is still refused.
  await rejects(await signReceipt({ ...base, state: STATE.policySatisfied }, signer), keys, 'gateway-claims-policy-satisfied');
  await rejects(await signReceipt({ ...base, storeClass: 9 }, signer), keys, 'unknown-store-class');
  await rejects(env, keys, 'contentDigest-mismatch', { contentDigest: new Uint8Array(32) });
  await rejects(env, keys, 'size-mismatch', { size: 1 });
  await assert.rejects(signReceipt({ ...base, keyId: otherSigner.keyId }, signer), /receipt-key-id-is-not-the-signer/);
  await assert.rejects(importSigningKey({ ...jwk, x: other.x }), /signing-jwk-(rejected|x-does-not-match-d)/);
  assert.throws(() => envelopeFromJson({ ...envelopeToJson(env), receipt: { ...envelopeToJson(env).receipt, extra: 1 } }), /unknown-field/);
});

test('derived field values follow the design', () => {
  const a = rawCid(Buffer.from('a')), b = rawCid(Buffer.from('b'));
  assert.deepEqual(blockSetDigest([a, b]), blockSetDigest([b, a, a]), 'order and duplicates do not matter');
  assert.notDeepEqual(blockSetDigest([a]), blockSetDigest([a, b]));
  assert.notDeepEqual(rootsCommitment([a, b]), rootsCommitment([b, a]), 'root order matters');
  const p = policyRecord({ source: 'abc', limits: { x: 1 }, store: { prefix: 'ipld/' } });
  assert.equal(hex(p.revision), crypto.createHash('sha256').update(p.bytes).digest('hex'));
  assert.ok(p.cid.startsWith('bafyrei'));
});
