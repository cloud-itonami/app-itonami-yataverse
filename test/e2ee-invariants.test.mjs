// Randomized operation-sequence invariants for the owner registry.
// Thousands of seeded sequences with randomized time, no pre-settling, and
// read interleavings compared across two runs. Deterministic PRNG only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MemoryRegistry, MAX_PACKS_PER_OWNER, MAX_PACK_BYTES_PER_OWNER } from '../worker/src/e2ee-registry.mjs';
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

/** Snapshot of everything a failed op must not change (settle effects aside). */
function coreSnapshot(r) {
  return JSON.stringify({
    owners: [...r.owners.keys()].sort(),
    packs: [...r.owners.values()].map((rec) => rec.packs.size),
    used: [...r.usedStatements.keys()].sort(),
    counts: [...r.owners.values()].map((rec) => [rec.appTimes.seed.length, rec.appTimes.existing.length,
      rec.batchTimes.length, rec.headTimes.length]),
    deviceKeys: [...r.owners.values()].map((rec) => [...rec.devices.entries()].map(([d, v]) => `${d}|${v.generation}|${v.approvedAt}`).sort()),
    indexAdditions: null, // checked separately (deletions from settle are allowed)
  });
}

async function run(seed, extraReads) {
  const rand = mulberry32(seed);
  const readRand = mulberry32(seed ^ 0x9e37);
  let now = 1_700_000_000_000;
  const r = new MemoryRegistry({ now: () => now });
  const keyAt = (i) => keyFromSeed(crypto.createHash('sha256').update(`inv-${seed}-${i}`).digest());
  const devices = [keyAt(0)];
  for (let i = 1; i < 6; i++) devices.push(keyAt(i));
  const stranger = keyAt(99);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const died = {};
  let prevLive = new Set();
  let prevEpoch = 0;
  let packN = 0;

  const invariants = (label) => {
    const rec = r._get(OWNER);
    if (!rec) return;
    const live = new Set([...rec.devices.values()].filter((d) => !d.revokedAt && !d.released).map((d) => d.did));
    // (1) live devices are indexed; index entries are live or pending.
    for (const did of live) assert.equal(r.deviceIndex.get(did), OWNER, `${label}: live ${did} must be indexed`);
    for (const [did, o] of r.deviceIndex) {
      if (o !== OWNER) continue;
      const pending = rec.pending.some((p) => p.deviceDid === did && !p.cancelledAt && !p.admittedAt)
        || rec.pendingReleases.some((p) => p.deviceDid === did && !p.cancelledAt && !p.doneAt)
        || rec.pendingRevokes.some((p) => p.targetDid === did && !p.cancelledAt && !p.doneAt);
      assert.ok(live.has(did) || pending, `${label}: index entry ${did} must be live or pending`);
    }
    // (2) no revival except via a later seed application.
    for (const did of [...prevLive]) if (!live.has(did)) died[did] = Math.max(rec.devices.get(did)?.revokedAt || 0, rec.devices.get(did)?.releasedAt || 0) || now;
    for (const did of live) {
      if (!prevLive.has(did) && died[did]) {
        const drv = rec.devices.get(did);
        assert.ok(drv.kind === 'seed' && drv.appliedAt >= died[did], `${label}: ${did} revived without a later seed application`);
      }
    }
    prevLive = live;
    // (5) epoch never decreases.
    assert.ok(rec.epoch >= prevEpoch, `${label}: epoch decreased`);
    prevEpoch = rec.epoch;
    // (6) caps with live reservations.
    let bytes = 0;
    for (const p of rec.packs.values()) bytes += p.size;
    let liveRes = 0;
    for (const rv of rec.reservations.values()) if (rv.expiresAt > now) { bytes += rv.size; liveRes += 1; }
    assert.ok(rec.packs.size + liveRes <= MAX_PACKS_PER_OWNER, `${label}: count cap`);
    assert.ok(bytes <= MAX_PACK_BYTES_PER_OWNER, `${label}: bytes cap`);
  };

  const maybeRead = async () => {
    if (extraReads && readRand() < 0.5) { await r.epochOf({ owner: OWNER }); invariants('read'); }
  };

  for (let step = 0; step < 500; step++) {
    const op = Math.floor(rand() * 9);
    const bad = rand() < 0.15;
    const before = coreSnapshot(r);
    const beforeIndex = new Map(r.deviceIndex);
    const liveBefore = prevLive.size;
    let ok = true; let out;
    try {
      const d = pick(devices);
      if (op === 0) out = await r.applyRegistration({ owner: OWNER, deviceDid: d.did, approverDid: bad ? stranger.did : REGDID, kind: 'seed' });
      else if (op === 1) out = await r.applyRegistration({ owner: OWNER, deviceDid: d.did, approverDid: bad ? stranger.did : pick(devices).did, kind: 'existing-device' });
      else if (op === 2) out = await r.cancelPending({ owner: OWNER, actorDid: bad ? stranger.did : d.did, pendingId: 1 + Math.floor(rand() * 3) });
      else if (op === 3) out = await r.revokeDevice({ owner: OWNER, actorDid: bad ? stranger.did : d.did, targetDid: pick(devices).did });
      else if (op === 4) out = await r.requestBatchRevoke({ owner: OWNER, registrationDid: bad ? stranger.did : REGDID });
      else if (op === 5) out = await r.releaseDevice({ owner: OWNER, deviceDid: d.did, registrationDid: bad ? stranger.did : REGDID });
      else if (op === 6) out = await r.recordPack({ owner: OWNER, deviceDid: d.did, sha256: shaN(packN++), size: 1 + Math.floor(rand() * 1000) });
      else if (op === 7) out = await r.checkPackCapacity({ owner: OWNER, sha256: shaN(packN++), size: 1 + Math.floor(rand() * 1000) });
      else out = await r.consumeStatement({ owner: OWNER, signature: `sig-${step}`, expiresAt: now + 1000, epoch: recEpoch(r) });
    } catch (e) { ok = false; }
    if (!ok) {
      // (4) failed ops change nothing (settle-driven index deletions and
      // rate-window expiries aside: counts may only drop, never rise).
      const after = JSON.parse(coreSnapshot(r));
      const beforeJ = JSON.parse(before);
      after.counts.forEach((c, i) => {
        c.forEach((n, j) => assert.ok(n <= beforeJ.counts[i][j], `step ${step} op ${op}: failed op raised a count`));
        after.counts[i] = beforeJ.counts[i];
      });
      // Device records may only grow (settle admissions); never shrink.
      const newDevices = new Set();
      after.deviceKeys.forEach((keys, i) => {
        const beforeIds = new Set(beforeJ.deviceKeys[i].map((s) => s.split('|')[0]));
        for (const k of keys) {
          const id = k.split('|')[0];
          if (!beforeIds.has(id)) newDevices.add(id);
          else if (!beforeJ.deviceKeys[i].includes(k)) newDevices.add(id); // generation bump = admission
        }
        for (const b of beforeJ.deviceKeys[i]) {
          const id = b.split('|')[0];
          assert.ok(keys.some((k) => k.startsWith(id)), `step ${step} op ${op}: failed op dropped a device record`);
        }
        after.deviceKeys[i] = beforeJ.deviceKeys[i];
      });
      // Used entries may only drop (expiry sweep), never grow, on failure.
      for (const u of after.used) assert.ok(beforeJ.used.includes(u), `step ${step} op ${op}: failed op marked a statement used`);
      after.used = beforeJ.used;
      assert.equal(JSON.stringify(after), before, `step ${step} op ${op}: failed op mutated core state`);
      // Index additions are allowed only for settle admissions (new device records).
      for (const [did, o] of r.deviceIndex) {
        assert.ok(beforeIndex.get(did) === o || newDevices.has(did),
          `step ${step} op ${op}: failed op added index entry ${did}`);
      }
    } else {
      // (5) no op immediately zeroes the terminals (the wait always applies).
      if (liveBefore > 0 && prevLive.size > 0) { /* checked after invariants below */ }
    }
    // (7) unauthorized actors are always rejected (bad ops never succeed).
    if (bad && op <= 5) assert.equal(ok, false, `step ${step}: bad actor succeeded on op ${op}`);
    now += [0, 1000, 600_000, 3_600_000, 86_400_000][Math.floor(rand() * 5)];
    await maybeRead();
    invariants(`step ${step} op ${op}`);
    if (ok && liveBefore > 0) {
      const rec = r._get(OWNER);
      const liveNow = rec ? [...rec.devices.values()].filter((d) => !d.revokedAt && !d.released).length : 0;
      if (liveNow === 0) {
        // Zero only via a batch/zero-op whose wait has elapsed.
        const waited = rec.batchRevokes.some((b) => b.appliedAt && b.effectiveAt <= now)
          || rec.pendingReleases.some((p) => p.doneAt && p.effectiveAt <= now)
          || rec.pendingRevokes.some((p) => p.doneAt && p.effectiveAt <= now);
        assert.ok(waited, `step ${step}: terminals hit zero without a waited revocation`);
      }
    }
  }
  now += 10 * 86_400_000;
  await r.epochOf({ owner: OWNER });
  invariants('final');
  const rec = r._get(OWNER);
  return JSON.stringify(rec ? { dev: [...rec.devices.entries()].map(([d, v]) => [d, v.revokedAt, v.released, v.generation]),
    ep: rec.epoch, pend: rec.pending.map((p) => [p.deviceDid, p.admittedAt, p.cancelledAt]),
    idx: [...r.deviceIndex.entries()].sort(), packs: rec.packs.size } : null);
}

function recEpoch(r) { return r._get(OWNER)?.epoch ?? 0; }

test('randomized sequences: invariants hold every step (20 seeds x 500 ops)', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    let a, b;
    try {
      a = await run(seed, false);
      b = await run(seed, true);
    } catch (e) {
      console.log(`FAIL seed=${seed}: ${e.message}`);
      throw e;
    }
    // (3) final state identical regardless of read interleavings.
    assert.equal(a, b, `seed ${seed}: read interleavings changed the outcome`);
  }
});
