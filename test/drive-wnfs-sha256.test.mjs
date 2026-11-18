import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import { parseCar } from '../src/car.mjs';
import { parseCid, SHA2_256, verifyBlock } from '../src/cid.mjs';

globalThis.window = globalThis;
const coreSource = await readFile(new URL('../app/generated/wnfs-core.js', import.meta.url), 'utf8');
runInThisContext(coreSource);

test('Drive SHA-256 WNFS capsule and packs are accepted by the Yataverse bytes plane', async () => {
  const { AwaiDriveEncrypted: owner, AwaiDriveWnfs: wnfs } = globalThis;
  const secret = crypto.getRandomValues(new Uint8Array(32));
  try {
    const record = await owner.newRecord(secret);
    const rows = [{ path: 'fixture.txt', bytes: Uint8Array.of(1, 2, 3) }];
    const sealed = await wnfs.seal(record, secret, rows);
    for (const pack of [sealed.capsule.bytes, ...sealed.packs]) {
      const archive = parseCar(pack);
      assert.ok(archive.roots.every(cid => parseCid(cid).hashCode === SHA2_256));
      for (const block of archive.blocks) assert.equal(verifyBlock(block.cid, block.bytes), true);
    }
    assert.equal(parseCar(sealed.packs[0]).roots[0], sealed.basis);
    const restored = await wnfs.openSnapshot(record, secret, sealed.capsule.root, sealed.capsule.bytes, sealed.packs);
    assert.equal(restored.basis, sealed.basis);
    const query = wnfs.project(restored);
    assert.deepEqual(query(restored.basis, 'txt'), [['fixture.txt', 3]]);
    assert.throws(() => query('wrong-basis', 'txt'));
  } finally {
    secret.fill(0);
  }
});
