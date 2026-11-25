// Two-owner and post-batch-restore controls (fake clock, fake storage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRegistry, RECOVERY_WAIT_MS } from '../worker/src/e2ee-registry.mjs';
import { deriveFromSeed } from '../src/recovery-derivation.mjs';
import { keyFromSeed } from '../src/cacao.mjs';

const A = deriveFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)));
const B = deriveFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 50)));
const X = keyFromSeed(Buffer.alloc(32, 7));
let now = 1_700_000_000_000;
const reg = () => new MemoryRegistry({ now: () => now });

test('two owners: replacement keeps the index; effectiveness never steals it', async () => {
  now = 1_700_000_000_000;
  const r = reg();
  // Owner B applies seed for X (pending, while B has no live device? give B one first).
  const bFirst = keyFromSeed(Buffer.alloc(32, 8));
  await r.applyRegistration({ owner: B.owner, deviceDid: bFirst.did, approverDid: B.registration.did, kind: 'seed' });
  const p1 = await r.applyRegistration({ owner: B.owner, deviceDid: X.did, approverDid: B.registration.did, kind: 'seed' });
  assert.equal(p1.status, 'pending');
  // B applies again: replaces the prior application, index stays reserved.
  const p2 = await r.applyRegistration({ owner: B.owner, deviceDid: X.did, approverDid: B.registration.did, kind: 'seed' });
  assert.equal(p2.status, 'pending');
  assert.equal(r.deviceIndex.get(X.did), B.owner, 'replacement must keep the index');
  // Owner A seed-registers X while B's application is pending.
  await assert.rejects(() => r.applyRegistration({ owner: A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed' }),
    /device-registered-elsewhere/, 'A must not take a device reserved by B');
  now += RECOVERY_WAIT_MS;
  // B's application becomes effective and lives under B only.
  assert.equal(await r.ownerOfDevice(X.did), B.owner);
  const aRec = r._get(A.owner);
  assert.ok(!aRec?.devices.has(X.did), 'A must not also hold X');
});

test('post-batch-revoke restore works without an extra read (idx scenario)', async () => {
  now = 1_700_000_000_000;
  const r = reg();
  await r.applyRegistration({ owner: A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed' });
  now += 1000;
  await r.requestBatchRevoke({ owner: A.owner, registrationDid: A.registration.did });
  now += RECOVERY_WAIT_MS + 1;
  // No read/settle in between: the seed re-registration must settle first,
  // see the freed index, and produce a usable terminal immediately.
  const q = await r.applyRegistration({ owner: A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed' });
  assert.equal(q.status, 'admitted');
  assert.equal(await r.ownerOfDevice(X.did), A.owner, 'restored terminal must be usable');
  assert.equal(r.deviceIndex.get(X.did), A.owner);
});

test('double release is a no-op and never leaves index debris', async () => {
  now = 1_700_000_000_000;
  const r = reg();
  await r.applyRegistration({ owner: A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed' });
  const rel1 = await r.releaseDevice({ owner: A.owner, deviceDid: X.did, registrationDid: A.registration.did });
  assert.equal(rel1.status, 'pending');
  now += RECOVERY_WAIT_MS + 1; // release becomes effective: X is dead but tombstoned
  const Y = keyFromSeed(Buffer.alloc(32, 9));
  await r.applyRegistration({ owner: A.owner, deviceDid: Y.did, approverDid: A.registration.did, kind: 'seed' });
  // A seed application for the same device while another terminal is live.
  const p = await r.applyRegistration({ owner: A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed' });
  assert.equal(p.status, 'pending');
  // Releasing again must not duplicate the pending release or cancel the application via a second path.
  const rel2 = await r.releaseDevice({ owner: A.owner, deviceDid: X.did, registrationDid: A.registration.did });
  assert.equal(rel2.status, 'already-released', 'second release is a no-op');
  // Cancelling the seed application frees the index exactly once.
  await r.cancelPending({ owner: A.owner, actorDid: Y.did, pendingId: p.id });
  assert.ok(!r.deviceIndex.has(X.did), 'index must be clean after cancel');
});

test('two owners randomized: one device lives under at most one owner', async () => {
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  for (const seed of [3, 17, 99]) {
    const rand = mulberry32(seed);
    const r = reg();
    const pool = [];
    for (let i = 0; i < 5; i++) pool.push(keyFromSeed(Buffer.from(cryptoSeed(seed, i))));
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    for (let step = 0; step < 200; step++) {
      const op = Math.floor(rand() * 6);
      const o = rand() < 0.5 ? A : B;
      const d = pick(pool);
      try {
        if (op === 0) await r.applyRegistration({ owner: o.owner, deviceDid: d.did, approverDid: o.registration.did, kind: 'seed' });
        else if (op === 1) await r.applyRegistration({ owner: o.owner, deviceDid: d.did, approverDid: pick(pool).did, kind: 'existing-device' });
        else if (op === 2) await r.revokeDevice({ owner: o.owner, actorDid: d.did, targetDid: pick(pool).did });
        else if (op === 3) await r.cancelPending({ owner: o.owner, actorDid: d.did, pendingId: 1 + Math.floor(rand() * 3) });
        else if (op === 4) await r.requestBatchRevoke({ owner: o.owner, registrationDid: o.registration.did });
        else await r.releaseDevice({ owner: o.owner, deviceDid: d.did, registrationDid: o.registration.did });
      } catch { /* rejected ops are fine */ }
      now += [0, 1000, 3_600_000, 86_400_000][Math.floor(rand() * 4)];
      for (const dv of pool) {
        const owners = [A, B].filter((o) => r._get(o.owner)?.devices.get(dv.did) && !r._get(o.owner).devices.get(dv.did).revokedAt && !r._get(o.owner).devices.get(dv.did).released);
        assert.ok(owners.length <= 1, `seed ${seed} step ${step}: device lives under ${owners.length} owners`);
        const live = owners[0];
        if (live) assert.equal(r.deviceIndex.get(dv.did), live.owner, `seed ${seed} step ${step}: live index mismatch`);
      }
    }
  }
});
function cryptoSeed(seed, i) {
  return Array.from({ length: 32 }, (_, k) => (seed * 31 + i * 17 + k) % 256);
}
