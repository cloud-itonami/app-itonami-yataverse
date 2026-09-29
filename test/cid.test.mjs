import test from 'node:test';
import assert from 'node:assert/strict';
import { rawCid, verifyBlock, parseCid, isCidShape, CODEC_RAW } from '../src/cid.mjs';

test('well-known raw CIDs', () => {
  assert.equal(rawCid(Buffer.alloc(0)), 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  assert.equal(rawCid(Buffer.from('hello\n')), 'bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am');
});
test('verifyBlock accepts the right bytes and refuses others', () => {
  const cid = rawCid(Buffer.from('x'));
  assert.equal(verifyBlock(cid, Buffer.from('x')), true);
  assert.equal(verifyBlock(cid, Buffer.from('y')), false);
  assert.equal(verifyBlock('nonsense', Buffer.from('x')), false);
});
test('parseCid reads version, codec, hash', () => {
  const p = parseCid(rawCid(Buffer.from('x')));
  assert.deepEqual([p.version, p.codec, p.hashCode, p.digest.length], [1, CODEC_RAW, 0x12, 32]);
  assert.equal(parseCid('bnotacid'), null);
});
test('CID shape rejects anything usable as a path', () => {
  for (const bad of ['../x', '/etc/passwd', 'b/../x', '', null, 'B' + 'a'.repeat(30), 'b' + 'a'.repeat(200)])
    assert.equal(isCidShape(bad), false, String(bad));
});
