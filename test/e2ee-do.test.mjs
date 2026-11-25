// Implementation tests for the Durable-Object-shaped registry classes
// (test-only swap; no binding/wiring). Covers:
// - exhaustive interleaving enumeration over the REAL classes: 1 terminal x
//   2 owners x 2 plans each, begin/claim/finish, delayed/duplicated/swapped/
//   dropped claim and release messages, expiry, revoke/release, time;
// - the same enumeration under three broken claim rules (v5 seq-only,
//   closed-advances-on-claim, no held-pair comparison), each failing;
// - 3000 randomized sequences of 30 steps: device-key actors, split
//   begin/claim/finish, randomized alarm and partial delivery, crash between
//   begin and finish, crash during outbox delivery, differential against
//   MemoryRegistry with only explicitly listed differences;
// - review repros (binding first, cap 429, same-claim redelivery,
//   ownerOfDevice via the index, incarnation domain, ack-based outbox retry,
//   deferred revoke holding a live index);
// - release-path inverses: every way an application ends frees its index
//   entry (cancel, batch effect, intent replacement, application
//   replacement, intent expiry) so no claim is left behind forever;
// - quiet-state invariants: with no letters, outbox rows or open
//   intents/appointments, an index entry may only belong to a live terminal.
// Six single-rule mutant reproductions live in the local-only do-model/
// script (`node do-model/mutants.mjs`); they are not imported here because
// do-model/ is not committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRegistry, RegistryError } from '../worker/src/e2ee-registry.mjs';
import { MapStorage, DeviceIndexDO, OwnerRegistryDO, FakeTransport, INTENT_TTL_MS } from '../worker/src/e2ee-registry-do.mjs';
import { HELD_GENS_CAP } from '../worker/src/e2ee-registry-core.mjs';
import { deriveFromSeed } from '../src/recovery-derivation.mjs';
import { keyFromSeed } from '../src/cacao.mjs';
import { signStatement, canonicalStatement, STATEMENT_VERSION } from '../src/e2ee-statement.mjs';
import { ownerIncarnation } from '../worker/src/e2ee-packs.mjs';

const A = deriveFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)));
const B = deriveFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 50)));
const T = [keyFromSeed(Buffer.alloc(32, 7)), keyFromSeed(Buffer.alloc(32, 8)), keyFromSeed(Buffer.alloc(32, 9))];
const EXTRA = [10, 11, 12, 13].map((i) => keyFromSeed(Buffer.alloc(32, i)));
const STRANGER = keyFromSeed(Buffer.alloc(32, 21));

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class World {
  constructor() {
    this.now = 1_700_000_000_000;
    this.transport = new FakeTransport();
    this.owners = new Map();
    // Harness-only state (the Worker's in-memory claim responses): a claim is
    // usable by finish only after the device DO acknowledged that exact pair.
    this.acks = new Map();    // `${owner}/${gen}` -> 'ok' | error code
    this.claims = [];         // every claim ever sent (for late/replayed arrival)
    this.redeliveryErrors = []; // an accepted claim whose identical retry failed
    for (const o of [A, B]) {
      this.owners.set(o.owner, new OwnerRegistryDO(new MapStorage(), { owner: o.owner, now: () => this.now, transport: this.transport }));
    }
  }
  reg(o, t) {
    const ow = [A, B].find((x) => x.owner === o) ?? A;
    return this.owners.get(o).applyRegistration({ owner: o, deviceDid: t, approverDid: ow.registration.did, kind: 'seed', transport: this.transport });
  }
  claim(owner, tid, intent) {
    const key = `${owner}/${intent.generation}`;
    try {
      this.transport.claim(tid, owner, intent.generation, intent.seq, intent.incarnation);
      this.acks.set(key, 'ok');
      // The design promises an idempotent retry of the same pair while held.
      try { this.transport.claim(tid, owner, intent.generation, intent.seq, intent.incarnation); }
      catch (e) { this.redeliveryErrors.push(e.code ?? e.message); }
    } catch (e) { this.acks.set(key, e.code ?? e.message); }
    const row = { owner, tid, gen: intent.generation, seq: intent.seq, inc: intent.incarnation };
    if (!this.claims.some((c) => c.gen === row.gen)) this.claims.push(row);
    return this.acks.get(key);
  }
  ack(owner, gen) { return this.acks.get(`${owner}/${gen}`); }
  checkInvariants() {
    const v = [];
    if (this.redeliveryErrors.length) v.push(`redelivery-rejected ${this.redeliveryErrors[0]}`);
    for (const tid of T.map((x) => x.did)) {
      const held = this.transport.lookup(tid);
      const liveOwners = [A, B].filter((o) => this.owners.get(o.owner).isLiveDevice({ owner: o.owner, did: tid }));
      if (liveOwners.length > 1) v.push(`two-owners ${tid}`);
      for (const o of liveOwners) if (!(held && held.owner === o.owner)) v.push(`live-no-index ${tid}`);
      if (held && liveOwners.length && !liveOwners.some((o) => o.owner === held.owner)) {
        const rec = this.owners.get(held.owner).core.get(held.owner);
        const pend = rec && [...rec.pending].some((p) => p.deviceDid === tid && !p.cancelledAt && !p.admittedAt);
        if (!pend) v.push(`held-orphan ${tid}`);
      }
    }
    return v;
  }
  // Quiet owner: nothing in flight for it -- no outbox row, no open intent,
  // no open application/release/revoke, no un-applied batch revoke.
  _quietOwner(owner) {
    const ow = this.owners.get(owner);
    ow._load();
    const r = ow.core.get(owner);
    const open = (list, admitted) => (r ? list.filter((p) => !p.cancelledAt && !p.doneAt && !(admitted && p.admittedAt)).length : 0);
    return !ow.storage.keys('outbox/').length && !ow.storage.keys('intent/').length &&
      !open(r?.pending, true) && !open(r?.pendingReleases) && !open(r?.pendingRevokes) &&
      !(r ? r.batchRevokes.filter((b) => !b.appliedAt).length : 0);
  }
  // Quiet-state invariant: no letter is in flight on the transport and the
  // owner has nothing pending, so an index entry it holds can only be for a
  // terminal that is live in that owner's record. (An open application would
  // make the owner non-quiet; its claim is covered by live-or-pending.)
  checkQuiet() {
    const res = { problems: [], checked: 0, all: false };
    if (this.transport.q.length) return res;
    let quietOwners = 0;
    for (const [owner] of this.owners) {
      if (!this._quietOwner(owner)) continue;
      quietOwners++; res.checked++;
      for (const tid of T.map((x) => x.did)) {
        const held = this.transport.lookup(tid);
        if (!held || held.owner !== owner) continue;
        if (!this.owners.get(owner).isLiveDevice({ owner, did: tid })) {
          res.problems.push(`quiet-held ${tid.slice(-6)} owner=${owner.slice(0, 4)}`);
        }
      }
    }
    res.all = quietOwners === this.owners.size;
    return res;
  }
  clone() {
    const w = new World();
    w.now = this.now;
    w.acks = new Map(this.acks);
    w.claims = structuredClone(this.claims);
    w.redeliveryErrors = [...this.redeliveryErrors];
    w.transport = new FakeTransport();
    w.transport.q = this.transport.q.map((m) => ({ row: structuredClone(m.row) }));
    w.transport.indexes = new Map([...this.transport.indexes.entries()].map(([k, v]) => {
      const idx = new DeviceIndexDO(new MapStorage(), {});
      idx.did = k;
      idx.storage.m = new Map(structuredClone([...v.storage.m.entries()]));
      return [k, idx];
    }));
    w.owners = new Map([...this.owners.entries()].map(([k, v]) => {
      const o = new OwnerRegistryDO(new MapStorage(), { owner: k, now: () => w.now, transport: w.transport });
      o.storage.m = new Map(structuredClone([...v.storage.m.entries()]));
      o._load();
      return [k, o];
    }));
    w.transport.rebind(w.owners);
    return w;
  }
  serialize() {
    const ser = (st) => [...st.m.entries()].map(([k, v]) => [k, JSON.stringify(v)]);
    return JSON.stringify({
      now: this.now,
      q: this.transport.q.map((m) => m.row),
      acks: [...this.acks.entries()].sort(),
      claims: this.claims.map((c) => [c.owner.slice(0, 4), c.seq, c.inc]),
      idx: [...this.transport.indexes.entries()].map(([k, v]) => [k, ser(v.storage)]),
      own: [...this.owners.entries()].map(([k, v]) => [k, ser(v.storage)]),
    });
  }
  anyIndex() { return T.some((x) => Boolean(this.transport.lookup(x.did))); }
}

// ---- exhaustive interleavings: 1 terminal x 2 owners, 2 intents ----
const pairGT = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const pairGE = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);

/** Install one deliberately broken claim rule; returns a restore function. */
function installClaimRule(kind) {
  const prev = DeviceIndexDO.prototype.claimByGeneration;
  if (!kind) return () => {};
  DeviceIndexDO.prototype.claimByGeneration = function (tid, owner, gen, seq, inc) {
    return this.storage.transact((tx) => {
      if (tid !== (this.did ?? tid)) throw new RegistryError('bad-device-did');
      const row = this._row(tx); const held = row.held;
      if (held && held.owner !== owner) throw new RegistryError('device-registered-elsewhere');
      const closed = row.closed[owner];
      let ok;
      if (kind === 'v5') {
        // Seq only, reset on a higher incarnation, never compare held.
        ok = closed === undefined || inc > closed[0] || (inc === closed[0] && seq > closed[1]);
      } else if (kind === 'no-held') {
        // Pair order against closed only; a late claim may overwrite a newer one.
        ok = closed === undefined || pairGT([inc, seq], closed);
      } else if (kind === 'closed-claim') {
        // Fixed acceptance, but a claim advances closed (own retry is stale).
        ok = closed === undefined || pairGT([inc, seq], closed);
        if (ok && held && held.owner === owner) ok = pairGE([inc, seq], [held.inc, held.seq]);
        if (!ok) throw new RegistryError('stale-claim');
        tx.put('closed', { ...row.closed, [owner]: [inc, seq] });
        tx.put('held', { owner, gen, seq, inc });
        return { status: 'claimed', generation: gen, seq, inc };
      } else {
        throw new Error(`unknown rule ${kind}`);
      }
      if (!ok) throw new RegistryError('stale-claim');
      tx.put('held', { owner, gen, seq, inc });
      return { status: 'claimed', generation: gen, seq, inc };
    });
  };
  return () => { DeviceIndexDO.prototype.claimByGeneration = prev; };
}

const EX_TID = T[0].did;
function exhaustiveActions(w) {
  const out = [];
  const add = (label, fn) => {
    const c = w.clone(); let r;
    try { r = fn(c); } catch (e) { r = `ERR:${e.code ?? e.message}`; }
    out.push([label, c, r]);
  };
  for (const o of [A, B]) {
    const ow = w.owners.get(o.owner);
    const ing = ow._intent(EX_TID);
    const rec = ow.core.get(o.owner);
    const live = rec ? Boolean(ow.core.isLive(rec, EX_TID)) : false;
    const tag = o.owner.slice(0, 4);
    if (!ing) add(`begin ${tag}`, (c) => c.owners.get(o.owner).beginRegistration({
      owner: o.owner, deviceDid: EX_TID, approverDid: o.registration.did, kind: 'seed', transport: c.transport }));
    if (ing) {
      add(`claim ${tag}`, (c) => c.claim(o.owner, EX_TID, c.owners.get(o.owner)._intent(EX_TID)));
      if (w.ack(o.owner, ing.generation) === 'ok') add(`finish ${tag}`, (c) => c.owners.get(o.owner).finishRegistration({
        owner: o.owner, deviceDid: EX_TID, approverDid: o.registration.did, kind: 'seed',
        generation: ing.generation, seq: ing.seq, incarnation: ing.incarnation }));
      add(`abandon ${tag}`, (c) => c.owners.get(o.owner).clearIntent({ owner: o.owner, deviceDid: EX_TID }));
    }
    if (live) add(`revoke ${tag}`, (c) => c.owners.get(o.owner).revokeDevice({
      owner: o.owner, actorDid: EX_TID, targetDid: EX_TID }));
    if (rec?.devices.has(EX_TID)) add(`release ${tag}`, (c) => c.owners.get(o.owner).releaseDevice({
      owner: o.owner, deviceDid: EX_TID, registrationDid: o.registration.did }));
  }
  // Replay any past claim: a delayed/duplicated claim never disappears.
  for (let k = 0; k < w.claims.length; k++) {
    const row = w.claims[k];
    add(`replay#${k}`, (c) => c.claim(row.owner, row.tid,
      { generation: row.gen, seq: row.seq, incarnation: row.inc }));
  }
  const qlen = w.transport.q.length;
  for (let k = 0; k < Math.min(qlen, 3); k++) add(`deliver#${k}`, (c) => c.transport.deliverNext(k));
  if (qlen) add('duplicateLetter', (c) => { c.transport.duplicateNext(); return 'dup'; });
  if (qlen >= 2) add('swapLetters', (c) => { c.transport.swapNext(0, 1); return 'swap'; });
  if (qlen) add('dropLetter', (c) => { c.transport.dropNext(); return 'drop'; });
  add('alarm', (c) => { for (const ow of c.owners.values()) ow.alarm(c.now); return 'alarm'; });
  add('advanceTTL', (c) => { c.now += INTENT_TTL_MS + 1; });
  add('advanceDay', (c) => { c.now += 86_400_000; });
  add('advanceWait', (c) => { c.now += 3 * 86_400_000 + 1; });
  return out;
}

function exploreExhaustive({ cap = Number(process.env.EX_CAP ?? 0) || 120_000, rule = null, stopOnViolation = false } = {}) {
  const restore = installClaimRule(rule);
  try {
    const init = new World();
    const seen = new Map([[init.serialize(), null]]);
    let queue = [init], explored = 0, filled = 0, violations = [];
    while (queue.length && explored < cap) {
      const nextQ = [];
      for (const w of queue) {
        for (const [label, c] of exhaustiveActions(w)) {
          explored++;
          const key = c.serialize();
          if (seen.has(key)) continue;
          seen.set(key, label);
          const bad = c.checkInvariants();
          bad.push(...c.checkQuiet().problems.map((x) => `quiet:${x}`));
          if (bad.length) {
            violations.push({ label, bad });
            if (stopOnViolation) return { states: seen.size, explored, filled, violations };
            continue;
          }
          if (c.anyIndex()) filled++;
          nextQ.push(c);
        }
      }
      queue = nextQ;
      if (process.env.EX_DEBUG) console.error(`exhaustive: states=${seen.size} explored=${explored} queue=${queue.length}`);
    }
    return { states: seen.size, explored, filled, violations };
  } finally { restore(); }
}

test('exhaustive (real classes): 1 terminal x 2 owners, begin/claim/finish, release letters, time', () => {
  const r = exploreExhaustive();
  console.log(`exhaustive counts: states=${r.states} explored=${r.explored} indexFilled=${r.filled} violations=${r.violations.length}`);
  assert.deepEqual(r.violations, [], 'no invariant violations');
  assert.ok(r.states > 100_000, `state space must be real (got ${r.states})`);
  assert.ok(r.filled > 100, `the index must actually be populated (got ${r.filled})`);
});

// The hole-1 sequence: claim 1 is abandoned (release letter queued, not
// delivered), claim 2 applies the terminal live, then claim 1 arrives late.
// The fixed pair rules reject the late claim; v5 and no-held accept it, so
// the queued release 1 deletes the live terminal's index.
async function hole1Under(rule) {
  const restore = installClaimRule(rule);
  try {
    const w = new World();
    const o = A, tid = EX_TID;
    const b1 = w.owners.get(o.owner).beginRegistration({ owner: o.owner, deviceDid: tid,
      approverDid: o.registration.did, kind: 'seed', transport: w.transport });
    w.claim(o.owner, tid, b1);
    w.owners.get(o.owner).clearIntent({ owner: o.owner, deviceDid: tid }); // release 1 queued
    const b2 = w.owners.get(o.owner).beginRegistration({ owner: o.owner, deviceDid: tid,
      approverDid: o.registration.did, kind: 'seed', transport: w.transport });
    w.claim(o.owner, tid, b2);
    w.owners.get(o.owner).finishRegistration({ owner: o.owner, deviceDid: tid,
      approverDid: o.registration.did, kind: 'seed', generation: b2.generation, seq: b2.seq, incarnation: b2.incarnation });
    assert.equal(w.owners.get(o.owner).isLiveDevice({ owner: o.owner, did: tid }), true);
    w.claim(o.owner, tid, b1); // late claim 1
    await w.transport.deliverAll(); // release 1
    return w.checkInvariants();
  } finally { restore(); }
}

for (const [rule, name] of [
  ['v5', 'v5 seq-only claim rule'],
  ['closed-claim', 'claim advances closed'],
  ['no-held', 'no held-pair comparison'],
]) {
  test(`exhaustive broken variant: ${name} fails the hole-1 gate`, async () => {
    const fixed = await hole1Under(null);
    const broken = await hole1Under(rule);
    console.log(`mutant ${rule}: fixed=${fixed.join(',') || 'clean'} broken=${broken.join(',') || 'clean'}`);
    assert.deepEqual(fixed, []);
    assert.ok(broken.length > 0, `${name} must be caught by the hole-1 gate`);
  });
}

// ---- repros ----
test('repro: unrelated approver leaves no index (binding before claim)', () => {
  const w = new World();
  assert.throws(
    () => w.owners.get(A.owner).applyRegistration({ owner: A.owner, deviceDid: T[0].did, approverDid: STRANGER.did, kind: 'seed', transport: w.transport }),
    (e) => e.code === 'owner-binding-mismatch');
  assert.equal(w.transport.lookup(T[0].did), null);
  const out = w.reg(B.owner, T[0].did);
  assert.equal(out.status, 'admitted');
});

test('repro: heldGens cap 429 (never dropped), live path untouched', async () => {
  const w = new World();
  w.now = 1_700_000_000_000;
  const o = w.owners.get(A.owner);
  o.applyRegistration({ owner: A.owner, deviceDid: T[0].did, approverDid: A.registration.did, kind: 'seed', transport: w.transport });
  const before = w.transport.lookup(T[0].did);
  const again = o.applyRegistration({ owner: A.owner, deviceDid: T[0].did, approverDid: A.registration.did, kind: 'seed', transport: w.transport });
  assert.equal(again.repeated, true);
  assert.deepEqual(w.transport.lookup(T[0].did), before);
  // 32 failed intents on the live terminal accrue heldGens; the 33rd 429s.
  const initialHeld = o._heldGens(A.owner, T[0].did).length; // from the initial admission's claim
  let cycles = 0, refused = null;
  for (let i = 0; i < 40; i++) {
    w.now += 1000;
    o.now = () => w.now;
    try {
      const q = o.createIntent({ owner: A.owner, deviceDid: T[0].did });
      cycles++;
      // claim (same owner, supersedes) but never apply: intent expires
      void q;
    } catch (e) {
      refused = e.code;
      break;
    }
    o.alarm(w.now + 300_001); // TTL lapse -> alarm closes into heldGens (live)
    await w.transport.deliverAll(); // keep queue drained
  }
  assert.equal(refused, 'held-gens-full', 'the intent past the cap is refused (429), not silently trimmed');
  assert.equal(cycles + initialHeld, HELD_GENS_CAP, 'exactly one generation per accepted intent');
  const list = o._heldGens(A.owner, T[0].did);
  assert.equal(list.length, HELD_GENS_CAP, 'heldGens capped at 32, never dropped');
});

test('repro: same-claim redelivery succeeds; only release advances closed', () => {
  const idx = new DeviceIndexDO(new MapStorage(), {});
  idx.did = 't';
  idx.claimByGeneration('t', 'o', 'g', 1, 0);
  assert.equal(idx.claimByGeneration('t', 'o', 'g', 1, 0).status, 'claimed');
  assert.equal(idx.release('t', 'o', 'g', 1, 0).released, true);
  assert.throws(() => idx.claimByGeneration('t', 'o', 'g', 1, 0), (e) => e.code === 'stale-claim');
});

test('device index: (incarnation, seq) pair order, per owner, never reset', () => {
  const idx = new DeviceIndexDO(new MapStorage(), {});
  idx.did = 't';
  assert.equal(idx.claimByGeneration('t', 'o1', 'g2', 2, 0).status, 'claimed');
  // A late stale claim with a smaller seq for the same owner must lose: the
  // held pair is a lower bound for the same owner (subtract either clause
  // and an old intent's claim can overwrite the live terminal's index).
  assert.throws(() => idx.claimByGeneration('t', 'o1', 'g1', 1, 0), (e) => e.code === 'stale-claim');
  assert.equal(idx.lookup('t').gen, 'g2');
  // A higher incarnation wins lexicographically over any seq of the old one.
  assert.equal(idx.claimByGeneration('t', 'o1', 'g3', 1, 1).status, 'claimed');
  assert.equal(idx.lookup('t').gen, 'g3');
  // Another owner never wins while this one holds the device.
  assert.throws(() => idx.claimByGeneration('t', 'o2', 'g9', 1, 0), (e) => e.code === 'device-registered-elsewhere');
});

test('repro: ownerOfDevice routes through the device index', () => {
  const w = new World();
  w.reg(A.owner, T[0].did);
  assert.equal(w.owners.get(A.owner).ownerOfDevice({ deviceDid: T[0].did }), A.owner);
  // owner record still live, but index held row deleted -> null (routes via index)
  w.transport.indexFor(T[0].did).storage.transact((tx) => tx.del('held'));
  assert.equal(w.owners.get(A.owner).ownerOfDevice({ deviceDid: T[0].did }), null);
});

test('incarnation domain: only the allowlist generation verifies', () => {
  const env = { E2EE_OWNER_ALLOWLIST: `${A.owner}:2,${B.owner}` };
  assert.equal(ownerIncarnation(env, A.owner), 2);
  assert.equal(ownerIncarnation(env, B.owner), 0);
  const fields = (inc) => ({ domain: 'yataverse.com', aud: 'https://yataverse.com', op: 'register', owner: A.owner,
    actorDid: A.registration.did, args: [T[0].did, A.registration.did, 'seed'], issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000, epoch: 0, incarnation: inc });
  assert.equal(STATEMENT_VERSION, 'yataverse:e2ee:v3');
  const c0 = canonicalStatement(fields(0)), c2 = canonicalStatement(fields(2));
  assert.notEqual(c0, c2, 'incarnation is a canonical field');
  assert.notEqual(signStatement(A.registration, fields(0)).signature, signStatement(A.registration, fields(2)).signature);
});

// ---- regression: released terminal re-registers into a pending application ----
// Fixed 6-step sequence (no PRNG, no crash injection) shrunk from the
// randomized failure "seed 5 step 501 live-no-index". The tombstone scan
// used to close the fresh intent's claim of the same transaction, so the
// terminal admitted with no index entry.
test('regression: re-registering a released terminal keeps the pending claim', async () => {
  const DAY = 86_400_000, t0 = 1_700_000_000_000;
  let now = t0;
  const transport = new FakeTransport();
  const o = new OwnerRegistryDO(new MapStorage(), { owner: A.owner, now: () => now, transport });
  const T0 = T[0].did, T1 = T[1].did;
  const held = () => transport.lookup(T1);
  const call = (deviceDid, kind = 'seed') => o.applyRegistration({ owner: A.owner, deviceDid, approverDid: A.registration.did, kind, transport });

  // 1) T0 registers into an empty owner: admitted immediately.
  assert.equal(call(T0).status, 'admitted');
  // 2) T1 registers while T0 is live: pending for the recovery wait; the
  //    intent's claim is the index entry and the only held generation.
  const p1 = call(T1);
  assert.equal(p1.status, 'pending');
  assert.equal(p1.admitAt, t0 + 3 * DAY);
  const claim1 = held();
  assert.equal(claim1.owner, A.owner);
  assert.deepEqual(o._heldGens(A.owner, T1), [{ gen: claim1.gen, seq: claim1.seq, inc: claim1.inc }]);
  // 3) The pending admits after the wait; the index entry is unchanged.
  now = p1.admitAt + 1;
  o.alarm(now);
  assert.equal(o.isLiveDevice({ owner: A.owner, did: T1 }), true);
  assert.deepEqual(held(), claim1);
  // 4) Release T1 (T0 still live, so immediate): the outbox deletes the
  //    index entry and advances the closed pair.
  assert.equal(o.releaseDevice({ owner: A.owner, deviceDid: T1, registrationDid: A.registration.did }).status, 'released');
  await transport.deliverAll();
  assert.equal(held(), null);
  assert.deepEqual(transport.indexFor(T1).storage.get('closed')[A.owner], [claim1.inc, claim1.seq]);
  // 5) T1 re-registers (a released record accepts seed only): pending again,
  //    and its fresh claim must not be closed by the tombstone scan.
  const p2 = call(T1);
  assert.equal(p2.status, 'pending');
  const claim2 = held();
  assert.equal(claim2.owner, A.owner);
  assert.deepEqual(o._heldGens(A.owner, T1), [{ gen: claim2.gen, seq: claim2.seq, inc: claim2.inc }],
    'claim kept while the application is pending');
  await transport.deliverAll();
  assert.deepEqual(held(), claim2, 'no release letter for a pending application');
  // 6) The pending admits: live WITH its index entry.
  now = p2.admitAt + 1;
  o.alarm(now);
  assert.equal(o.isLiveDevice({ owner: A.owner, did: T1 }), true);
  assert.deepEqual(held(), claim2);
});

// ---- fixed repros: ack-based outbox, deferred ops hold the index ----
test('fixed: one dropped release letter is retried until acked (index gone after 20 days)', async () => {
  const DAY = 86_400_000, t0 = 1_700_000_000_000;
  let now = t0;
  const transport = new FakeTransport();
  const o = new OwnerRegistryDO(new MapStorage(), { owner: A.owner, now: () => now, transport });
  const reg = (d) => o.applyRegistration({ owner: A.owner, deviceDid: d, approverDid: A.registration.did, kind: 'seed', transport });
  reg(T[0].did); reg(T[1].did);
  now = t0 + 3 * DAY + 1; o.alarm(now);
  assert.equal(o.releaseDevice({ owner: A.owner, deviceDid: T[1].did, registrationDid: A.registration.did }).status, 'released');
  const dropped = transport.dropNext();
  assert.equal(transport.dropped, 1);
  assert.equal(o.storage.keys('outbox/').length, 1, 'the unacked row survives the drop');
  assert.ok(dropped, 'a letter was in flight');
  const deliveredBefore = transport.delivered;
  for (let i = 0; i < 20; i++) { now += DAY; o.alarm(now); await transport.deliverAll(); }
  assert.equal(transport.lookup(T[1].did), null, 'the retried release removes the index');
  assert.equal(o.storage.keys('outbox/').length, 0, 'the ack deletes the outbox row');
  assert.ok(transport.delivered > deliveredBefore, 'the retry actually reached the device DO');
  const rowAttempts = o.storage.get('outbox-counter');
  assert.ok(rowAttempts >= 1);
});

test('fixed: a pending revoke holds a live terminal index until the wait ends', async () => {
  const DAY = 86_400_000, t0 = 1_700_000_000_000;
  let now = t0;
  const transport = new FakeTransport();
  const o = new OwnerRegistryDO(new MapStorage(), { owner: A.owner, now: () => now, transport });
  const T0 = T[0].did, T1 = T[1].did;
  const reg = (d) => o.applyRegistration({ owner: A.owner, deviceDid: d, approverDid: A.registration.did, kind: 'seed', transport });
  reg(T0);
  const p = reg(T1);
  assert.equal(p.status, 'pending');
  // Begin + claim a re-registration, then let the pending admission land
  // without a finish: T1 is live and an intent still holds a second claim.
  now = p.admitAt - 60_000;
  const it = o.createIntent({ owner: A.owner, deviceDid: T1 });
  o.claimRegistration({ owner: A.owner, deviceDid: T1, generation: it.generation, seq: it.seq, incarnation: it.incarnation });
  now = p.admitAt + 1; o.alarm(now);
  assert.equal(o.isLiveDevice({ owner: A.owner, did: T1 }), true);
  assert.equal(o.revokeDevice({ owner: A.owner, actorDid: T1, targetDid: T0 }).status, 'revoked');
  const pend = o.revokeDevice({ owner: A.owner, actorDid: T1, targetDid: T1 });
  assert.equal(pend.status, 'pending');
  await transport.deliverAll();
  assert.equal(o.isLiveDevice({ owner: A.owner, did: T1 }), true);
  assert.equal(transport.lookup(T1)?.gen, it.generation, 'the deferred revoke must not free the live claim');
  assert.equal(o.storage.keys('intent/').length, 0, 'the intent is closed into heldGens, not released');
  now = pend.effectiveAt + 1; o.alarm(now);
  assert.equal(o.isLiveDevice({ owner: A.owner, did: T1 }), false);
  await transport.deliverAll();
  assert.equal(transport.lookup(T1), null, 'the effect releases every possibly-held generation');
  assert.equal(o.storage.keys('outbox/').length, 0);
});

// ---- release-path inverses: an ended application must not keep a claim ----
// Each way an application ends must free its index entry: the terminal ends
// up with no held claim, the owner's closed pair advanced past the ended
// generation, and an empty heldGens list. Skipping too much in the sweep
// would turn "live with no index" into "index held forever", so each path is
// pinned here.
const releaseSetup = () => {
  const st = { now: 1_700_000_000_000 };
  st.transport = new FakeTransport();
  st.o = new OwnerRegistryDO(new MapStorage(), { owner: A.owner, now: () => st.now, transport: st.transport });
  st.o.applyRegistration({ owner: A.owner, deviceDid: T[0].did, approverDid: A.registration.did, kind: 'seed', transport: st.transport });
  return st;
};
const heldGens = (st, did) => st.o._heldGens(A.owner, did);
const closedPair = (st, did) => st.transport.indexFor(did).storage.get('closed')?.[A.owner] ?? null;

test('release path: cancelling the application frees its index entry', async () => {
  const st = releaseSetup();
  const p = st.o.applyRegistration({ owner: A.owner, deviceDid: T[1].did, approverDid: A.registration.did, kind: 'seed', transport: st.transport });
  const claim = st.transport.lookup(T[1].did);
  assert.equal(claim.owner, A.owner);
  assert.equal(st.o.cancelPending({ owner: A.owner, actorDid: T[0].did, pendingId: p.id }).status, 'cancelled');
  assert.deepEqual(heldGens(st, T[1].did), [], 'a cancelled application keeps no held generation');
  assert.ok(st.transport.q.length >= 1, 'a release letter is queued');
  await st.transport.deliverAll();
  assert.equal(st.transport.lookup(T[1].did), null);
  assert.deepEqual(closedPair(st, T[1].did), [claim.inc, claim.seq]);
  assert.deepEqual(heldGens(st, T[1].did), []);
});

test('release path: an effective batch revoke frees the index entry', async () => {
  const st = releaseSetup();
  st.o.applyRegistration({ owner: A.owner, deviceDid: T[1].did, approverDid: A.registration.did, kind: 'seed', transport: st.transport });
  const claim = st.transport.lookup(T[1].did);
  st.now += 3_600_000;
  const batch = st.o.requestBatchRevoke({ owner: A.owner, registrationDid: A.registration.did });
  st.now = batch.effectiveAt + 1;
  st.o.alarm(st.now);
  const rec = st.o.core.get(A.owner);
  // The application was admitted first (its admitAt precedes the batch
  // effect), then the batch revoked the terminal as a seed applied before
  // the request: the freed entry must not depend on the batch's
  // cancelApplication branch.
  assert.equal(rec.devices.get(T[1].did).revokedAt, batch.effectiveAt);
  assert.equal(st.o.isLiveDevice({ owner: A.owner, did: T[1].did }), false);
  assert.deepEqual(heldGens(st, T[1].did), [], 'a revoked terminal keeps no held generation');
  await st.transport.deliverAll();
  assert.equal(st.transport.lookup(T[1].did), null);
  assert.deepEqual(closedPair(st, T[1].did), [claim.inc, claim.seq]);
  assert.deepEqual(heldGens(st, T[1].did), []);
});

test('release path: replacing an expired intent releases the old claim', async () => {
  const st = releaseSetup();
  const it1 = st.o.createIntent({ owner: A.owner, deviceDid: T[1].did });
  st.transport.claim(T[1].did, A.owner, it1.generation, it1.seq, it1.incarnation);
  assert.equal(st.transport.lookup(T[1].did).seq, it1.seq);
  st.now += INTENT_TTL_MS + 1;
  const it2 = st.o.createIntent({ owner: A.owner, deviceDid: T[1].did });
  assert.notEqual(it2.generation, it1.generation);
  assert.deepEqual(heldGens(st, T[1].did), [], 'nothing relies on the expired intent still');
  assert.ok(st.transport.q.length >= 1, 'replacing an expired intent queues its release');
  await st.transport.deliverAll();
  assert.equal(st.transport.lookup(T[1].did), null);
  assert.deepEqual(closedPair(st, T[1].did), [it1.incarnation, it1.seq]);
  assert.deepEqual(heldGens(st, T[1].did), []);
  assert.equal(st.o.storage.keys('intent/').length, 1, 'the new intent stays open');
});

test('release path: a replaced application is released once nothing relies on it', async () => {
  const st = releaseSetup();
  st.o.applyRegistration({ owner: A.owner, deviceDid: T[1].did, approverDid: A.registration.did, kind: 'seed', transport: st.transport });
  const claim1 = st.transport.lookup(T[1].did);
  st.now += 1000;
  const p2 = st.o.applyRegistration({ owner: A.owner, deviceDid: T[1].did, approverDid: A.registration.did, kind: 'seed', transport: st.transport });
  const claim2 = st.transport.lookup(T[1].did);
  assert.equal(claim2.seq, claim1.seq + 1, 'the replacement claim supersedes the old one');
  // While the replacement is pending the terminal still relies on the index,
  // so both generations stay listed (design: live-or-pending keeps them).
  assert.deepEqual(heldGens(st, T[1].did).map((g) => g.seq), [claim1.seq, claim2.seq]);
  await st.transport.deliverAll();
  assert.equal(st.transport.lookup(T[1].did).seq, claim2.seq);
  assert.equal(st.o.cancelPending({ owner: A.owner, actorDid: T[0].did, pendingId: p2.id }).status, 'cancelled');
  assert.deepEqual(heldGens(st, T[1].did), [], 'with the last application gone every generation is released');
  assert.ok(st.transport.q.length >= 2, 'one release per possibly-held generation');
  await st.transport.deliverAll();
  assert.equal(st.transport.lookup(T[1].did), null);
  assert.deepEqual(closedPair(st, T[1].did), [claim2.inc, claim2.seq]);
  assert.deepEqual(heldGens(st, T[1].did), []);
});

test('release path: intent expiry with no live terminal or application frees the index', async () => {
  const st = releaseSetup();
  const it = st.o.createIntent({ owner: A.owner, deviceDid: T[1].did });
  st.transport.claim(T[1].did, A.owner, it.generation, it.seq, it.incarnation);
  st.now += INTENT_TTL_MS + 1;
  st.o.alarm(st.now);
  assert.deepEqual(heldGens(st, T[1].did), [], 'an expired intent on a dead terminal is released, not listed');
  assert.ok(st.transport.q.length >= 1);
  assert.equal(st.o.storage.keys('intent/').length, 0);
  await st.transport.deliverAll();
  assert.equal(st.transport.lookup(T[1].did), null);
  assert.deepEqual(closedPair(st, T[1].did), [it.incarnation, it.seq]);
  assert.deepEqual(heldGens(st, T[1].did), []);
});

// ---- randomized differential + invariants: 3000 sequences ----
const RDAY = 86_400_000, RWAIT = 3 * RDAY;
function liveDids(ow, owner) {
  ow._load();
  const r = ow.core.get(owner);
  return r ? [...r.devices.values()].filter((d) => !d.revokedAt && !d.released).map((d) => d.did) : [];
}
function openPendingIds(ow, owner) {
  ow._load();
  const r = ow.core.get(owner);
  return r ? [...r.pending, ...r.pendingReleases, ...r.pendingRevokes]
    .filter((p) => !p.cancelledAt && !p.doneAt && !p.admittedAt).map((p) => p.id) : [];
}
function restartOwners(owners, transport, nowFn) {
  for (const [k, ow] of owners) {
    const fresh = new OwnerRegistryDO(new MapStorage(), { owner: k, now: nowFn, transport });
    fresh.storage.m = ow.storage.m; // same durable storage object
    fresh._load();
    owners.set(k, fresh);
  }
  transport.rebind(owners);
}

test('randomized: 3000 sequences, device-key actors, delayed delivery, crashes', async () => {
  const counts = {
    sequences: 0, steps: 0, seed: 0, existing: 0, revoke: 0, release: 0, cancel: 0,
    batch: 0, pack: 0, head: 0, begin: 0, claim: 0, finish: 0,
    crashes: 0, outboxCrashes: 0, letters: 0, drops: 0, duplicates: 0, swaps: 0,
  };
  const doReject = new Map(); // oracle ok, DO rejected
  const doAccept = new Map(); // oracle rejected, DO accepted
  const codeOrder = new Map(); // both rejected, different code (check order)
  const ALLOWED_DO_REJECT = new Set(['intent-open', 'held-gens-full']);
  // Devices are partitioned per owner here (cross-owner claim races are the
  // exhaustive test's subject), so no index-timing divergence is tolerated.
  const ALLOWED_DO_ACCEPT = new Set([]);

  const SEQ = Number(process.env.RSEQ ?? 0) || 3000;
  for (let seq = 0; seq < SEQ; seq++) {
    counts.sequences++;
    const rand = mulberry32(((seq + 1) * 2654435761) >>> 0);
    let now = 1_700_000_000_000 + (seq % 5) * RDAY;
    const nowFn = () => now;
    const transport = new FakeTransport();
    const oracle = new MemoryRegistry({ now: nowFn });
    const owners = new Map([A, B].map((o) => [o.owner,
      new OwnerRegistryDO(new MapStorage(), { owner: o.owner, now: nowFn, transport })]));
    const ow = (o) => owners.get(o.owner);
    const view = () => Object.assign(Object.create(World.prototype),
      { owners, transport, acks: new Map(), claims: [], redeliveryErrors: [] });
    const doCall = (fn) => { try { return { ok: fn() }; } catch (e) { return { err: e.code ?? e.message }; } };
    const orc = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { err: e.code ?? e.message }; } };
    const cmp = (label, a, b, ctx = {}) => {
      if (a.ok && b.ok) {
        const sa = a.ok.status ?? 'ok', sb = b.ok.status ?? 'ok';
        if (sa !== sb) throw new Error(`${label} seq ${seq}: status ${sa} vs DO ${sb}`);
      } else if (a.err && b.err) {
        // Both reject: the owner tx checks approver/batch before the claim
        // (design §2.8: it never consults the index), while the oracle claims
        // first. Admission outcomes are identical; record the code order.
        if (a.err !== b.err) {
          const k = `${a.err}->${b.err}`;
          codeOrder.set(k, (codeOrder.get(k) ?? 0) + 1);
        }
      } else if (a.ok && b.err) {
        if (!ALLOWED_DO_REJECT.has(b.err)) throw new Error(`${label} seq ${seq}: oracle ok, DO rejected ${b.err}`);
        doReject.set(b.err, (doReject.get(b.err) ?? 0) + 1);
      } else {
        if (!ALLOWED_DO_ACCEPT.has(a.err)) throw new Error(`${label} seq ${seq}: DO accepted, oracle rejected ${a.err}`);
        doAccept.set(a.err, (doAccept.get(a.err) ?? 0) + 1);
      }
    };
    const regBoth = async (o, did, approver, kind) => {
      const a = await orc(async () => {
        // Same pre-consume checks the Worker runs before apply (main path).
        await oracle.checkRegistrationRates({ owner: o.owner, kind });
        await oracle.checkRegisterable({ owner: o.owner, deviceDid: did, kind });
        return oracle.applyRegistration({ owner: o.owner, deviceDid: did, approverDid: approver, kind });
      });
      let b;
      try {
        const int = ow(o).beginRegistration({ owner: o.owner, deviceDid: did, approverDid: approver, kind });
        if (int.status === 'admitted') b = { ok: int };
        else {
          counts.begin++;
          try { ow(o).claimRegistration({ owner: o.owner, deviceDid: did, generation: int.generation,
            seq: int.seq, incarnation: int.incarnation, transport }); }
          catch (e) { ow(o).clearIntent({ owner: o.owner, deviceDid: did }); throw e; }
          counts.claim++;
          b = { ok: ow(o).finishRegistration({ owner: o.owner, deviceDid: did, approverDid: approver, kind,
            generation: int.generation, seq: int.seq, incarnation: int.incarnation }) };
          counts.finish++;
        }
      } catch (e) { b = { err: e.code ?? e.message }; }
      cmp(`register ${kind}`, a, b, { o, did, kind });
      if (b.ok) counts[kind === 'seed' ? 'seed' : 'existing']++;
      return b;
    };
    const opBoth = async (label, ofn, dfn, counter) => {
      const a = await orc(ofn);
      const b = await orc(dfn);
      cmp(label, a, b);
      if (b.ok) counts[counter]++;
      return b;
    };

    // --- deterministic setup: 3 live terminals, one existing, cancel, revoke, release
    await regBoth(A, T[0].did, A.registration.did, 'seed');
    await regBoth(A, T[1].did, A.registration.did, 'seed');
    now += RWAIT + 1;
    ow(A).alarm(now); oracle._settle(oracle._get(A.owner), now); await transport.deliverAll();
    await regBoth(A, EXTRA[0].did, T[0].did, 'existing-device');
    await regBoth(A, EXTRA[1].did, A.registration.did, 'seed'); // pending
    const pids = openPendingIds(ow(A), A.owner);
    await opBoth('cancel', () => oracle.cancelPending({ owner: A.owner, actorDid: T[0].did, pendingId: pids[0] }),
      () => ow(A).cancelPending({ owner: A.owner, actorDid: T[0].did, pendingId: pids[0] }), 'cancel');
    await opBoth('revoke', () => oracle.revokeDevice({ owner: A.owner, actorDid: T[0].did, targetDid: EXTRA[0].did }),
      () => ow(A).revokeDevice({ owner: A.owner, actorDid: T[0].did, targetDid: EXTRA[0].did }), 'revoke');
    // Owner B gets its own two devices (no cross-owner claim races here).
    await regBoth(B, T[2].did, B.registration.did, 'seed');
    await regBoth(B, EXTRA[2].did, B.registration.did, 'seed'); // pending
    now += RWAIT + 1;
    ow(B).alarm(now); oracle._settle(oracle._get(B.owner), now); await transport.deliverAll();
    await opBoth('release', () => oracle.releaseDevice({ owner: A.owner, deviceDid: T[1].did, registrationDid: A.registration.did }),
      () => ow(A).releaseDevice({ owner: A.owner, deviceDid: T[1].did, registrationDid: A.registration.did }), 'release');
    await opBoth('batch', () => oracle.requestBatchRevoke({ owner: A.owner, registrationDid: A.registration.did }),
      () => ow(A).requestBatchRevoke({ owner: A.owner, registrationDid: A.registration.did }), 'batch');
    const sha = Buffer.from(`p${seq}`).toString('hex').padStart(64, '0').slice(-64);
    await opBoth('pack', () => oracle.recordPack({ owner: A.owner, deviceDid: T[0].did, sha256: sha, size: 100 }),
      () => ow(A).recordPack({ owner: A.owner, deviceDid: T[0].did, sha256: sha, size: 100 }), 'pack');
    await opBoth('head', () => oracle.publishHead({ owner: A.owner, deviceDid: T[0].did, seq: 1, headSha: sha, headNameHex: 'b'.repeat(64) }),
      () => ow(A).publishHead({ owner: A.owner, deviceDid: T[0].did, seq: 1, headSha: sha, headNameHex: 'b'.repeat(64) }), 'head');

    // --- crash during outbox delivery: device applied the release, ack lost
    if (transport.q.length) {
      await transport.deliverNextUnacked(0);
      counts.outboxCrashes++;
      restartOwners(owners, transport, nowFn);
    }
    // --- crash between begin and finish (claim made, no apply) + expiry cleanup
    {
      const b = doCall(() => ow(A).beginRegistration({ owner: A.owner, deviceDid: EXTRA[3].did,
        approverDid: A.registration.did, kind: 'seed' }));
      if (b.ok?.status === 'intent') {
        counts.begin++;
        doCall(() => ow(A).claimRegistration({ owner: A.owner, deviceDid: EXTRA[3].did,
          generation: b.ok.generation, seq: b.ok.seq, incarnation: b.ok.incarnation, transport }));
        counts.claim++; counts.crashes++;
        restartOwners(owners, transport, nowFn);
        now += INTENT_TTL_MS + 1; owners.get(A.owner).alarm(now); await transport.deliverAll();
      }
    }

    for (let step = 0; step < 30; step++) {
      counts.steps++;
      const o = rand() < 0.75 ? A : B;
      const pool = o === A ? [T[0], T[1], EXTRA[0], EXTRA[1], EXTRA[3]] : [T[2], EXTRA[2]];
      const d = pool[Math.floor(rand() * pool.length)];
      const live = liveDids(ow(o), o.owner);
      const actor = live.length ? live[Math.floor(rand() * live.length)] : T[0].did;
      const kind = rand() < 0.08 ? STRANGER.did : (rand() < 0.5 ? o.registration.did : actor);
      const pick = Math.floor(rand() * 10);
      if (pick <= 1) { // seed / existing through begin → claim → finish (crashable)
        const isExisting = pick === 1;
        const approver = isExisting ? actor : o.registration.did;
        const crash = rand() < 0.06;
        if (crash) {
          const b = doCall(() => ow(o).beginRegistration({ owner: o.owner, deviceDid: d.did,
            approverDid: approver, kind: isExisting ? 'existing-device' : 'seed' }));
          if (b.ok?.status === 'intent') {
            counts.begin++;
            const c = doCall(() => ow(o).claimRegistration({ owner: o.owner, deviceDid: d.did,
              generation: b.ok.generation, seq: b.ok.seq, incarnation: b.ok.incarnation, transport }));
            if (c.ok) counts.claim++;
          }
          counts.crashes++;
          restartOwners(owners, transport, nowFn);
          // Let the orphan intent expire and its claim release before the
          // next differential step, so the crash itself is the only gap.
          now += INTENT_TTL_MS + 1; ow(o).alarm(now); await transport.deliverAll();
        } else if (isExisting) {
          await regBoth(o, d.did, approver, 'existing-device');
        } else {
          await regBoth(o, d.did, approver, 'seed');
        }
      } else if (pick === 2) {
        await opBoth('revoke', () => oracle.revokeDevice({ owner: o.owner, actorDid: kind, targetDid: d.did }),
          () => ow(o).revokeDevice({ owner: o.owner, actorDid: kind, targetDid: d.did }), 'revoke');
      } else if (pick === 3) {
        await opBoth('release', () => oracle.releaseDevice({ owner: o.owner, deviceDid: d.did, registrationDid: o.registration.did }),
          () => ow(o).releaseDevice({ owner: o.owner, deviceDid: d.did, registrationDid: o.registration.did }), 'release');
      } else if (pick === 4) {
        const ids = openPendingIds(ow(o), o.owner);
        const pid = ids.length ? ids[Math.floor(rand() * ids.length)] : 1 + Math.floor(rand() * 4);
        await opBoth('cancel', () => oracle.cancelPending({ owner: o.owner, actorDid: kind, pendingId: pid }),
          () => ow(o).cancelPending({ owner: o.owner, actorDid: kind, pendingId: pid }), 'cancel');
      } else if (pick === 5) {
        await opBoth('batch', () => oracle.requestBatchRevoke({ owner: o.owner, registrationDid: o.registration.did }),
          () => ow(o).requestBatchRevoke({ owner: o.owner, registrationDid: o.registration.did }), 'batch');
      } else if (pick === 6) {
        const s2 = Buffer.from(`q${seq}-${step}`).toString('hex').padStart(64, '0').slice(-64);
        await opBoth('pack', () => oracle.recordPack({ owner: o.owner, deviceDid: actor, sha256: s2, size: 100 }),
          () => ow(o).recordPack({ owner: o.owner, deviceDid: actor, sha256: s2, size: 100 }), 'pack');
      } else if (pick === 7) {
        const s2 = Buffer.from(`h${seq}-${step}`).toString('hex').padStart(64, '0').slice(-64);
        const hs = 1 + Math.floor(rand() * 2);
        await opBoth('head', () => oracle.publishHead({ owner: o.owner, deviceDid: actor, seq: hs, headSha: s2, headNameHex: 'b'.repeat(64) }),
          () => ow(o).publishHead({ owner: o.owner, deviceDid: actor, seq: hs, headSha: s2, headNameHex: 'b'.repeat(64) }), 'head');
      } else if (pick === 8) {
        // no alarm/delivery this step: letters and expiries stay due
      } else {
        now += [1000, 3600_000, RDAY, 4 * RDAY][Math.floor(rand() * 4)];
      }
      // Randomized (not per-step) alarm + partial delivery.
      if (rand() < 0.30) { for (const ow2 of owners.values()) ow2.alarm(now); counts.letters += transport.q.length; }
      if (rand() < 0.45 && transport.q.length) {
        const n = 1 + Math.floor(rand() * transport.q.length);
        for (let i = 0; i < n && transport.q.length; i++) await transport.deliverNext(Math.floor(rand() * transport.q.length));
      }
      if (rand() < 0.05 && transport.q.length) { transport.dropNext(); counts.drops++; }
      if (rand() < 0.05 && transport.q.length) { transport.duplicateNext(); counts.duplicates++; }
      if (rand() < 0.05 && transport.q.length > 1) { transport.swapNext(0, 1 + Math.floor(rand() * (transport.q.length - 1))); counts.swaps++; }
      const v = view().checkInvariants();
      assert.deepEqual(v, [], `seq ${seq} step ${step} pick ${pick}`);
    }
    // Drain: 6 days, every alarm, all letters. End state must be quiet.
    now += 6 * RDAY;
    for (const ow2 of owners.values()) ow2.alarm(now);
    await transport.deliverAll();
    assert.deepEqual(view().checkInvariants(), [], `seq ${seq} end invariants`);
    const quiet = view().checkQuiet();
    assert.deepEqual(quiet.problems, [], `seq ${seq} end quiet`);
  }

  const fmt = (m) => [...m.entries()].map(([k, v]) => `${k}=${v}`).join(',') || '-';
  console.log(`randomized counts: sequences=${counts.sequences} steps=${counts.steps} seed=${counts.seed} existing=${counts.existing} revoke=${counts.revoke} release=${counts.release} cancel=${counts.cancel} batch=${counts.batch} pack=${counts.pack} head=${counts.head} begin=${counts.begin} claim=${counts.claim} finish=${counts.finish} crashes=${counts.crashes} outboxCrashes=${counts.outboxCrashes} letters=${counts.letters} drops=${counts.drops} duplicates=${counts.duplicates} swaps=${counts.swaps}`);
  console.log(`randomized tolerances: doReject ${fmt(doReject)}; doAccept ${fmt(doAccept)}; bothRejectOrder ${fmt(codeOrder)}`);
  assert.ok(counts.sequences >= SEQ);
  for (const k of ['seed', 'existing', 'revoke', 'release', 'cancel', 'batch', 'pack', 'head', 'begin', 'claim', 'finish']) {
    assert.ok(counts[k] > 0, `${k} successes must be non-zero`);
  }
  assert.ok(counts.crashes > 0 && counts.outboxCrashes > 0);
  assert.ok(counts.drops + counts.duplicates + counts.swaps > 0);
});

// ---- fixed-rule unit checks (mutants live in do-model/mutants.mjs) ----
test('fixed rules: same-claim redelivery succeeds; unrelated approver is rejected', () => {
  const idx = new DeviceIndexDO(new MapStorage(), {});
  idx.did = 't';
  idx.claimByGeneration('t', 'o', 'g', 1, 0);
  assert.equal(idx.claimByGeneration('t', 'o', 'g', 1, 0).status, 'claimed');
  // Binding before any claim.
  const w = new World();
  assert.throws(
    () => w.owners.get(A.owner).applyRegistration({ owner: A.owner, deviceDid: T[0].did, approverDid: STRANGER.did, kind: 'seed', transport: w.transport }),
    (e) => e.code === 'owner-binding-mismatch');
});
