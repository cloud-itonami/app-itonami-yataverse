import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDrivePackClient } from '../src/drive-packs.mjs';

const origin = 'https://storage.example';
const bytes = Uint8Array.of(1, 2, 3);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const id = sha256(bytes);

test('publication verifies the receipt before separately requesting digest-verified readback', async () => {
  const seen = [];
  const broker = { async invoke(selector, { input, init }) {
    assert.equal(input, origin + '/awai-drive/v1/packs/' + id);
    assert.deepEqual([selector.capability, selector.service], ['awai.drive.sync', 'awai.fs']);
    seen.push(selector.operation);
    if (selector.operation === 'download') {
      assert.deepEqual(init, { method: 'GET' });
      return new Response(bytes);
    }
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers['Content-Type'], 'application/vnd.ipld.car');
    assert.deepEqual(init.body, bytes);
    return Response.json({ sha256: id, bytes: bytes.length });
  } };
  const client = createDrivePackClient({ origin, capability: 'awai.drive.sync', broker, sha256 });
  assert.equal(await client.publish(bytes, (receipt, expected) => {
    assert.deepEqual(expected, { id, size: bytes.length });
    assert.equal(receipt.sha256, id);
    seen.push('verified');
  }), id);
  assert.deepEqual(seen, ['upload', 'verified', 'download']);
  assert.deepEqual(await client.download(id), bytes);
});

test('rejects denied operations, a mismatched receipt and corrupt bytes', async () => {
  let calls = 0;
  let answer = () => { throw Error('consent-denied'); };
  const broker = { invoke() { calls++; return answer(); } };
  const client = createDrivePackClient({ origin, capability: 'yataverse.store', broker, sha256 });
  await assert.rejects(client.download('../pack'), /invalid-root/);
  await assert.rejects(client.publish(new Uint8Array()), /invalid-pack-size/);
  assert.equal(calls, 0);
  await assert.rejects(client.publish(bytes), /consent-denied/);
  assert.equal(calls, 1);
  answer = () => Response.json({ sha256: id, bytes: bytes.length - 1 });
  await assert.rejects(client.publish(bytes), /receipt-mismatch/);
  assert.equal(calls, 2);
  answer = () => Response.json({ sha256: id, bytes: bytes.length });
  await assert.rejects(client.publish(bytes, () => { throw Error('bad signature'); }), /bad signature/);
  assert.equal(calls, 3);
  answer = () => new Response(Uint8Array.of(1, 2, 4));
  await assert.rejects(client.download(id), /receipt-mismatch/);
});
