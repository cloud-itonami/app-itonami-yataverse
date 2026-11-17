import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateDagCbor, MAX_DEPTH } from '../src/dag-cbor.mjs';
import { checkWritableBlock } from '../src/block.mjs';
import { cidFor, rawCid, CODEC_DAG_CBOR, CODEC_RAW } from '../src/cid.mjs';

const h = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const cidBytes = (bytes) => Buffer.concat([h('01551220'), crypto.createHash('sha256').update(bytes).digest()]);
const link = (bytes) => { const c = Buffer.concat([h('00'), cidBytes(bytes)]); return Buffer.concat([h('d82a58'), Buffer.from([c.length]), c]); };

test('canonical DAG-CBOR values are accepted', () => {
  for (const hex of [
    '01', '17', '1818', '19 0100', '1a 00010000', '1b 0000000100000000', '20', '38 18',  // shortest ints
    '40', '43 010203', '60', '63 616263', '80', '83 010203',                         // bytes, text, arrays
    'a1 6161 01', 'a2 6162 01 6261 61 02',                                           // keys: length-first ("b" < "aa")
    'f4', 'f5', 'f6', 'fb 3ff8000000000000',                                         // false true null 1.5
    'a2 63 646f63 f5 64 74797065 63 646f63',                                         // {"doc": true, "type": "doc"}
  ]) assert.equal(validateDagCbor(h(hex)), null, hex);
  const l = link(Buffer.from('target'));
  assert.equal(validateDagCbor(Buffer.concat([h('a1 6464 6174 61'), l])), null, 'map with a CID link');
  assert.equal(validateDagCbor(Buffer.concat([h('d82a5823 00 1220'), Buffer.alloc(32, 7)])), null, 'CIDv0 link');
});

test('each DAG-CBOR rule rejects its violation', () => {
  const cases = {
    '': 'empty',
    '0101': 'trailing-bytes',
    '1805': 'integer-not-minimal', '1900ff': 'integer-not-minimal', '1a0000ffff': 'integer-not-minimal',
    '1b00000000ffffffff': 'integer-not-minimal',
    '9fff': 'indefinite-length', '5f40ff': 'indefinite-length', 'bfff': 'indefinite-length',
    '1c': 'reserved-additional-info',
    '62c328': 'text-not-utf8',
    'a10101': 'map-key-not-text',
    'a2616201616102': 'map-keys-not-sorted',
    'a2626161016162 02': 'map-keys-not-sorted',          // "aa" before "b" is wrong: length-first
    'a2616101616102': 'map-key-duplicate',
    'c100': 'tag-not-42',
    'd82a01': 'cid-link-not-bytes',
    'd82a4101': 'cid-link-missing-identity-prefix',
    'd82a43000201': 'cid-link-unsupported-version',
    'fa3fc00000': 'float-not-64-bit', 'f93e00': 'float-not-64-bit',
    'fb7ff8000000000000': 'float-not-finite', 'fb7ff0000000000000': 'float-not-finite',
    'f7': 'simple-value-not-allowed', 'f0': 'simple-value-not-allowed', 'ff': 'unexpected-break',
    '5b00000001000000000000': 'length-exceeds-block',
    '83 0102': 'truncated',
  };
  for (const [hex, code] of Object.entries(cases)) assert.equal(validateDagCbor(h(hex)), code, hex || '(empty)');
  const bad = Buffer.concat([h('d82a5826 00 01551220'), Buffer.alloc(33)]);   // multihash longer than declared
  assert.equal(validateDagCbor(bad), 'cid-link-bad-multihash-length');
});

test('nesting deeper than MAX_DEPTH is rejected, at the limit it is accepted', () => {
  const nest = (n) => Buffer.concat([Buffer.alloc(n, 0x81), h('01')]);
  assert.equal(validateDagCbor(nest(MAX_DEPTH)), null);
  assert.equal(validateDagCbor(nest(MAX_DEPTH + 1)), 'too-deep');
});

test('checkWritableBlock: raw and canonical dag-cbor pass; other codecs, mismatches and non-canonical fail', () => {
  const doc = h('a2 6161 01 6162 02');
  assert.equal(checkWritableBlock(cidFor(doc, CODEC_DAG_CBOR), doc), null);
  assert.equal(checkWritableBlock(rawCid(doc), doc), null);                  // any bytes are valid raw
  const unsorted = h('a2 6162 01 6161 02');
  assert.equal(checkWritableBlock(cidFor(unsorted, CODEC_DAG_CBOR), unsorted), 'not-canonical-dag-cbor:map-keys-not-sorted');
  assert.equal(checkWritableBlock(cidFor(doc, CODEC_DAG_CBOR), h('01')), 'bytes-do-not-hash-to-cid');
  assert.equal(checkWritableBlock('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', doc), 'put-codec-not-accepted');
  assert.equal(checkWritableBlock('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', doc), 'put-requires-cidv1-sha2-256');
  assert.throws(() => cidFor(doc, 0x70), RangeError);
  assert.equal(cidFor(doc, CODEC_RAW), rawCid(doc));
});
