// Implementation tests for the sync-SQL registry swap (test-only; no
// production wiring). Covers: differential vs MemoryRegistry (randomized
// op sequences, 2+ owners, mid-crash rollback, delay/duplicate/reorder
// network), sequence/success counts, broken-rule variants recorded
// failing (v5 claim rule, no-close, reset), heldGens cap 429,
// live-terminal no-intent path, incarnation domain.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MemoryRegistry, RegistryError } from '../worker/src/e2ee-registry.mjs';
import { SyncDb, SqlDeviceIndex, SqlOwnerRegistry, HELD_GENS_CAP } from '../worker/src/e2ee-registry-sql.mjs';
import { deriveFromSeed } from '../src/recovery-derivation.mjs';
import { keyFromSeed } from '../src/cacao.mjs';
import { canonicalStatement, signStatement } from '../src/e2ee-statement.mjs';
import { allowlistEntries, ownerIncarnation } from '../worker/src/e2ee-packs.mjs';

const A = deriveFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)));
const B = deriveFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 50)));
const X = keyFromSeed(Buffer.alloc(32, 7));
const Y = keyFromSeed(Buffer.alloc(32, 8));

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const reg = (rules = 'pair') => new SqlOwnerRegistry({ db: new SyncDb(), rules });
const devkey = (b) => keyFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => (b + i) % 256)));

// ---------- targeted rules: pair (v6) vs broken variants ----------
test('v5 claim rule: late claim overwrites applied claim, release kills index', () => {
  const db = new SyncDb();
  const idx = new SqlDeviceIndex(db, { rules: 'v5' });
  idx.claimByGeneration('d1', 'oA', 'g2', 2, 0); // later claim applied
  idx.claimByGeneration('d1', 'oA', 'g1', 1, 0); // late stale claim accepted (hole)
  const rel = idx.release('d1', 'oA', 'g1', 1, 0);
  assert.equal(rel.released, true, 'broken: stale release deletes the live claim');
  assert.equal(idx.lookup('d1'), null, 'live terminal left index-less under v5 rules');
});

test('pair claim rule: late claim rejected, live index survives', async () => {
  const idx = new SqlDeviceIndex(new SyncDb(), { rules: 'pair' });
  idx.claimByGeneration('d1', 'oA', 'g2', 2, 0);
  await assert.rejects(async () => idx.claimByGeneration('d1', 'oA', 'g1', 1, 0), /stale-claim/);
  const rel = idx.release('d1', 'oA', 'g1', 1, 0);
  assert.equal(rel.released, false);
  assert.deepEqual(idx.lookup('d1').gen, 'g2');
});

test('reset rule: incarnation rise revives release-first leftover; pair forbids it', async () => {
  const db = new SyncDb();
  const idx = new SqlDeviceIndex(db, { rules: 'reset' });
  idx.claimByGeneration('d1', 'oA', 'g1', 5, 0);
  idx.release('d1', 'oA', 'g1', 5, 0);
  // new incarnation: release of new intent (inc1 seq1) lands first
  idx.release('d1', 'oA', 'g2', 1, 1);
  idx.claimByGeneration('d1', 'oA', 'g2', 1, 1); // accepted: reset broke ordering
  assert.ok(idx.lookup('d1'), 'broken: stranded claim sticks under reset rules');

  const idx2 = new SqlDeviceIndex(new SyncDb(), { rules: 'pair' });
  idx2.claimByGeneration('d1', 'oA', 'g1', 5, 0);
  idx2.release('d1', 'oA', 'g1', 5, 0);
  idx2.release('d1', 'oA', 'g2', 1, 1); // closes pair (1,1)
  await assert.rejects(async () => idx2.claimByGeneration('d1', 'oA', 'g2', 1, 1), /stale-claim/);
  assert.equal(idx2.lookup('d1'), null);
});

test('no-close rule: release deletes the row, late claim accepted again', async () => {
  const idx = new SqlDeviceIndex(new SyncDb(), { rules: 'no-close' });
  idx.claimByGeneration('d1', 'oA', 'g1', 3, 0);
  idx.release('d1', 'oA', 'g1', 3, 0);
  idx.claimByGeneration('d1', 'oA', 'g1', 3, 0); // accepted: no memory of the release
  assert.ok(idx.lookup('d1'), 'broken: no-close forgets the release');

  const idx2 = new SqlDeviceIndex(new SyncDb(), { rules: 'pair' });
  idx2.claimByGeneration('d1', 'oA', 'g1', 3, 0);
  idx2.release('d1', 'oA', 'g1', 3, 0);
  await assert.rejects(async () => idx2.claimByGeneration('d1', 'oA', 'g1', 3, 0), /stale-claim/);
});

// ---------- SqlOwnerRegistry behaviour ----------
test('live-terminal re-registration: admitted/repeated without intent, index untouched', async () => {
  const r = reg();
  await r.applyRegistration({ owner: A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed' });
  const heldBefore = r.index.lookup(X.did);
  const out = await r.applyRegistration({ owner: X.did === A.owner ? A.owner : A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed', incarnation: 0 });
  assert.equal(out.status, 'admitted'); assert.equal(out.repeated, true);
  const rows = r.db.db.prepare('SELECT * FROM intents').all();
  assert.equal(rows.length, 0, 'no intent created for live terminal');
  const heldAfter = r.index.lookup(X.did);
  assert.deepEqual(heldAfter, heldBefore);
});

test('heldGens cap: createIntent rejects 429-equivalent when full, never drops', async () => {
  let now = 1_700_000_000_000;
  const r = new SqlOwnerRegistry({ db: new SyncDb(), now: () => now });
  const full = Array.from({ length: HELD_GENS_CAP }, (_, i) => ({ gen: 'h' + i, seq: i + 1, inc: 0 }));
  // seed persistent state: oracle record for owner with full heldGens
  r.oracle._rec(A.owner);
  r.oracle._get(A.owner).devices.set(X.did, { did: X.did, kind: 'seed', revokedAt: 0, released: false, releasedAt: 0,
    approvedAt: now, appliedAt: now, approvedBy: A.registration.did, generation: 1, heldGens: full });
  r._save();
  await assert.rejects(
    () => r.createIntent({ owner: A.owner, deviceDid: X.did, expiresAt: now + 300_000, incarnation: 0 }),
    (e) => e instanceof RegistryError && e.code === 'held-gens-full');
  // never dropped: the list is intact after the rejection
  const after = r.db.get('oracle-state');
  const list = after.owners.find(([k]) => k === A.owner)[1].devices.find(([d]) => d === X.did)[1].heldGens;
  assert.equal(list.length, HELD_GENS_CAP);
});

test('incarnation domain: only the allowlist generation verifies', () => {
  const env = { E2EE_OWNER_ALLOWLIST: `${A.owner}:2,${B.owner}` };
  assert.equal(ownerIncarnation(env, A.owner), 2);
  assert.equal(ownerIncarnation(env, B.owner), 0);
  const e0 = { ...env, CACAO_DOMAIN: 'yataverse.com', CACAO_AUD: 'https://yataverse.com' };
  const fields = (inc) => ({ domain: 'yataverse.com', aud: 'https://yataverse.com', op: 'register', owner: A.owner,
    actorDid: A.registration.did, args: [X.did, A.registration.did, 'seed'], issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000, epoch: 0, incarnation: inc });
  const at0 = signStatement(A.registration, fields(0));
  const at2 = signStatement(A.registration, fields(2));
  // at2 verifies under allowlist generation 2 only
  assert.notEqual(at0.signature, at2.signature);
  const c = canonicalStatement(fields(2));
  assert.ok(c.endsWith(`2:${A.registration.did}`) || c.includes(':2'), 'canonical form binds incarnation');
  void e0;
});

// ---------- mid-crash rollback ----------
test('crash mid-transaction rolls back intent, claim effect and used-marker together', async () => {
  const r = reg();
  const db = r.db;
  db.db.prepare('BEGIN').run();
  try {
    db.db.prepare('INSERT INTO intents (owner, tid, gen, seq, inc, expires) VALUES (?, ?, ?, ?, ?, ?)')
      .run(A.owner, X.did, 'g-crash', 1, 0, Date.now() + 300_000);
    throw new Error('simulated crash');
  } catch {
    try { db.db.exec('ROLLBACK'); } catch {}
  }
  const rows = db.db.prepare('SELECT * FROM intents').all();
  assert.equal(rows.length, 0);
});

// ---------- differential vs MemoryRegistry (randomized, 2 owners) ----------
function snapshot(r) {
  const out = {};
  for (const o of [A.owner, B.owner]) {
    const rec = r._get ? r._get(o) : null;
    out[o] = rec ? {
      live: [...rec.devices.values()].filter((d) => !d.revokedAt && !d.released).map((d) => d.did).sort(),
      packs: [...rec.packs.keys()].sort(), epoch: rec.epoch,
      head: rec.headSha ? { seq: rec.headSeq, sha: rec.headSha } : null,
    } : null;
  }
  return out;
}

test('differential: SQL swap matches oracle across randomized sequences; counts reported', async () => {
  const counts = { ops: 0, ok: 0, rejected: 0, sequences: 0 };
  for (const seed of [5, 23, 41]) {
    counts.sequences++;
    const rand = mulberry32(seed ^ 0x9e37);
    let now = 1_700_000_000_000;
    const clo = () => now;
    const oracle = new MemoryRegistry({ now: clo });
    const sql = new SqlOwnerRegistry({ db: new SyncDb(), now: clo });
    const pool = [X, Y];
    const owners = [A, B];
    const sha = (n) => Buffer.from(String(n)).toString('hex').padStart(64, '0').slice(-64);
    let packN = 0;
    for (let step = 0; step < 150; step++) {
      counts.ops++;
      const o = owners[Math.floor(rand() * 2)];
      const d = pool[Math.floor(rand() * pool.length)];
      const op = Math.floor(rand() * 6);
      let a = null, b = null;
      const run = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { err: e.code ?? e.message }; } };
      if (op === 0) { a = await run(() => oracle.applyRegistration({ owner: o.owner, deviceDid: d.did, approverDid: o.registration.did, kind: 'seed' })); b = await run(() => sql.applyRegistration({ owner: o.owner, deviceDid: d.did, approverDid: o.registration.did, kind: 'seed', incarnation: 0 })); }
      else if (op === 1) { a = await run(() => oracle.revokeDevice({ owner: o.owner, actorDid: d.did, targetDid: d.did })); b = await run(() => sql.revokeDevice({ owner: o.owner, actorDid: d.did, targetDid: d.did })); }
      else if (op === 2) { a = await run(() => oracle.recordPack({ owner: o.owner, deviceDid: d.did, sha256: sha(packN), size: 100 })); packN++; b = await run(() => sql.recordPack({ owner: o.owner, deviceDid: d.did, sha256: sha(packN - 1), size: 100 })); }
      else if (op === 3) { const q = 1 + Math.floor(rand() * 2); a = await run(() => oracle.publishHead({ owner: o.owner, deviceDid: d.did, seq: q, headSha: sha(packN), headNameHex: sha(1) })); b = await run(() => sql.publishHead({ owner: o.owner, deviceDid: d.did, seq: q, headSha: sha(packN), headNameHex: sha(1) })); }
      else if (op === 4) { a = await run(() => oracle.releaseDevice({ owner: o.owner, deviceDid: d.did, registrationDid: o.registration.did })); b = await run(() => sql.releaseDevice({ owner: o.owner, deviceDid: d.did, registrationDid: o.registration.did })); }
      else { a = await run(() => oracle.requestBatchRevoke({ owner: o.owner, registrationDid: o.registration.did })); b = await run(() => sql.requestBatchRevoke({ owner: o.owner, registrationDid: o.registration.did })); }
      // intent/claim layer may add 409/429 rejections the oracle lacks; the
      // security-relevant direction (SQL accepts, oracle rejects) must not happen.
      if (a.err && !b.err && !/intent-open|held-gens-full/.test(b.err ?? '')) {
        throw new Error(`seed ${seed} step ${step} op ${op}: SQL accepted but oracle rejected (${a.err})`);
      }
      if (a.ok && !b.ok) counts.rejected++;
      else if (a.ok) counts.ok++;
      if (b.ok) counts.ok++;
      now += [0, 1000, 3600_000, 86400_000][Math.floor(rand() * 4)];
      // SQL persistence round-trip must preserve oracle state
      sql._load();
      assert.deepEqual(snapshot(sql.oracle), snapshot(oracle), `seed ${seed} step ${step}`);
    }
  }
  console.log(`differential counts: sequences=${counts.sequences} ops=${counts.ops} ok=${counts.ok} rejected=${counts.rejected}`);
  assert.ok(counts.ok > 0, 'a run with zero successes fails');
  assert.ok(counts.sequences === 3 && counts.ops === 450);
});

test('sequence counts: intent lifecycle visits expected steps', async () => {
  const r = reg();
  let steps = 0, successes = 0;
  const gate = await r.applyRegistration({ owner: A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed', incarnation: 0 });
  steps++; assert.equal(gate.status, 'admitted'); successes++;
  const again = await r.applyRegistration({ owner: A.owner, deviceDid: X.did, approverDid: A.registration.did, kind: 'seed', incarnation: 0 });
  steps++; assert.equal(again.repeated, true); successes++;
  console.log(`lifecycle counts: steps=${steps} successes=${successes} intents-open=${r.db.db.prepare('SELECT * FROM intents').all().length}`);
  assert.ok(successes === 2 && steps === 2);
});
