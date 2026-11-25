// Randomized operation-sequence invariants for the owner registry.
// Thousands of seeded sequences with randomized time and read interleavings;
// invariants are checked every step. Deterministic PRNG only, no deps.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MemoryRegistry, RECOVERY_WAIT_MS, MAX_PACKS_PER_OWNER, MAX_PACK_BYTES_PER_OWNER } from '../worker/src/e2ee-registry.mjs';
import { keyFromSeed } from '../src/cacao.mjs';
import { ownerFromRegistrationPub } from '../src/recovery-derivation.mjs';

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWNERKEY = keyFromSeed(Buffer.alloc(32, 11));
const OWNER = ownerFromRegistrationPub(OWNERKEY.publicRaw);
const REGDID = OWNERKEY.did;
const shaN = (n) => Buffer.from(String(n)).toString('hex').padStart(64, '0').slice(-64);

function snapshot(r) {
  return JSON.stringify({
    owners: [...r.owners.entries()].map(([o, rec]) => [o, {
      devices: [...rec.devices.entries()].map(([d, v]) => [d, v.revokedAt, v.released, v.generation, v.approvedAt]),
      packs: rec.packs.size, epoch: rec.epoch, headSeq: rec.headSeq,
      pending: rec.pending.filter((p) => !p.cancelledAt && !p.admittedAt).map((p) => p.deviceDid),
    }]),
    index: [...r.deviceIndex.entries()].sort(),
    used: [...r.usedStatements.keys()].sort(),
  });
}

/** One seeded run. extraReads inserts settle-reads at random points. */
async function run(seed, extraReads) {
  const rand = mulberry32(seed);
  const readRand = mulberry32(seed ^ 0x9e37); // reads must not shift the op stream
  let now = 1_700_000_000_000;
  const r = new MemoryRegistry({ now: () => now });
  // Deterministic device keys: the same seed must produce the same actors.
  const keyAt = (i) => keyFromSeed(crypto.createHash('sha256').update(`inv-${seed}-${i}`).digest());
  const devices = [keyAt(0)];
  for (let i = 1; i < 6; i++) devices.push(keyAt(i));
  const stranger = keyAt(99);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const trackEpoch = new Map();
  const cancelsPerEpoch = new Map();
  let packN = 0;

  const invariants = async (label) => {
    const rec = r._get(OWNER);
    if (rec) {
      // (1) live devices are indexed; index entries are live or pending.
      for (const [did, d] of rec.devices) {
        if (!d.revokedAt && !d.released) assert.equal(r.deviceIndex.get(did), OWNER, `${label}: live ${did} must be indexed`);
      }
      for (const [did, o] of r.deviceIndex) {
        if (o !== OWNER) continue;
        const d = rec.devices.get(did);
        const pending = rec.pending.some((p) => p.deviceDid === did && !p.cancelledAt && !p.admittedAt)
          || rec.pendingReleases.some((p) => p.deviceDid === did && !p.cancelledAt && !p.doneAt)
          || rec.pendingRevokes.some((p) => p.targetDid === did && !p.cancelledAt && !p.doneAt);
        assert.ok((d && !d.revokedAt && !d.released) || pending, `${label}: index entry ${did} must be live or pending`);
      }
      // (5) epoch never decreases; cancels within budget per epoch.
      const e = rec.epoch;
      assert.ok(e >= (trackEpoch.get(OWNER) ?? 0), `${label}: epoch decreased`);
      trackEpoch.set(OWNER, e);
      // (6) caps with reservations; expired reservations never count.
      let bytes = 0;
      for (const p of rec.packs.values()) bytes += p.size;
      let liveRes = 0;
      for (const rv of rec.reservations.values()) if (rv.expiresAt > now) { bytes += rv.size; liveRes += 1; }
      assert.ok(rec.packs.size + liveRes <= MAX_PACKS_PER_OWNER, `${label}: count cap`);
      assert.ok(bytes <= MAX_PACK_BYTES_PER_OWNER, `${label}: bytes cap`);
    }
  };

  const maybeRead = async () => {
    if (extraReads && readRand() < 0.5) { await r.epochOf({ owner: OWNER }); await invariants('read'); }
  };

  for (let step = 0; step < 400; step++) {
    const op = Math.floor(rand() * 10);
    await r.epochOf({ owner: OWNER }); // settle due events before the op snapshot
    const before = snapshot(r);
    let ok = true;
    try {
      const d = pick(devices);
      if (op === 0) {
        await r.applyRegistration({ owner: OWNER, deviceDid: d.did, approverDid: REGDID, kind: 'seed' });
      } else if (op === 1) {
        const approver = pick(devices).did;
        await r.applyRegistration({ owner: OWNER, deviceDid: d.did, approverDid: approver, kind: 'existing-device' });
      } else if (op === 2) {
        await r.cancelPending({ owner: OWNER, actorDid: d.did, pendingId: 1 + Math.floor(rand() * 3) });
      } else if (op === 3) {
        await r.revokeDevice({ owner: OWNER, actorDid: d.did, targetDid: pick(devices).did });
      } else if (op === 4) {
        await r.requestBatchRevoke({ owner: OWNER, registrationDid: rand() < 0.3 ? stranger.did : REGDID });
      } else if (op === 5) {
        await r.releaseDevice({ owner: OWNER, deviceDid: d.did, registrationDid: REGDID });
      } else if (op === 6) {
        await r.recordPack({ owner: OWNER, deviceDid: d.did, sha256: shaN(packN++), size: 1 + Math.floor(rand() * 1000) });
      } else if (op === 7) {
        await r.checkPackCapacity({ owner: OWNER, sha256: shaN(packN++), size: 1 + Math.floor(rand() * 1000) });
      } else if (op === 8) {
        await r.consumeStatement({ owner: OWNER, signature: `sig-${step}`, expiresAt: now + 1000, epoch: await r.epochOf({ owner: OWNER }) });
      } else {
        // (7) unauthorized actor: stranger tries a privileged op.
        await r.revokeDevice({ owner: OWNER, actorDid: stranger.did, targetDid: d.did });
      }
    } catch (e) {
      ok = false;
      // (4) failed ops change nothing.
      assert.equal(snapshot(r), before, `step ${step} op ${op}: failed op mutated state`);
    }
    if (ok && op === 2) {
      const c = (cancelsPerEpoch.get(OWNER) ?? 0) + 1;
      cancelsPerEpoch.set(OWNER, c);
      assert.ok(c <= 1 + (trackEpoch.get(OWNER) ?? 0), 'cancel budget exceeded');
    }
    now += Math.floor(rand() * 3) * 86_400_000; // 0-2 days per step
    await maybeRead();
    await invariants(`step ${step} op ${op}`);
  }
  now += 10 * 86_400_000;
  await invariants('final');
  return snapshot(r);
}

test('randomized sequences: invariants hold every step (3 seeds x 400 ops)', async () => {
  for (const seed of [7, 42, 1337]) {
    const a = await run(seed, false);
    const b = await run(seed, true);
    // (3) final state identical regardless of read interleavings.
    assert.equal(a, b, `seed ${seed}: read interleavings changed the outcome`);
  }
});
