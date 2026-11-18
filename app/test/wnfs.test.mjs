import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = globalThis;
await import('../generated/core.js');

test('the dapp SDK opens and queries a pinned WNFS forest basis', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  try {
    const owner = globalThis.AwaiDriveEncrypted;
    const wnfs = globalThis.AwaiDriveWNFS;
    const record = await owner.newRecord(secret);
    const sealed = await wnfs.sealSnapshot(record, secret, [{ path: 'fixture.txt', bytes: Uint8Array.of(1, 2, 3) }]);
    const rows = await wnfs.openSnapshot(record, secret, sealed.root, sealed.bytes);
    assert.equal(rows.basis, sealed.basis);
    const query = wnfs.project(rows, sealed.basis);
    assert.deepEqual(query(sealed.basis, 'txt'), [['fixture.txt', 3]]);
    assert.throws(() => query('different-basis', 'txt'));
  } finally {
    secret.fill(0);
  }
});
