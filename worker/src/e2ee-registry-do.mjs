// Durable Object classes for the owner-scoped E2EE registry (test-only
// swap; no binding/migration/deploy — wiring stays 503).
// - DeviceIndexDO: one instance per deviceDid, separate storage. Per-owner
//   closed pairs kept forever; only release advances closed; claims accept
//   lexicographic (incarnation, seq) order > closed and >= held pair.
// - OwnerRegistryDO: one instance per owner; intent-first registration,
//   heldGens (cap 32, 429 when full), outbox + alarm delivery through an
//   injected transport (tests fake delay/duplicate/reorder/drop).
// - RegistryCore (e2ee-registry-core.mjs) holds the sync owner-state rules;
//   MemoryRegistry keeps its own untouched implementation (oracle).
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RegistryError, checkOwnerBinding } from './e2ee-registry.mjs';
import { RegistryCore, checkDid, checkOwner, checkSha, HELD_GENS_CAP } from './e2ee-registry-core.mjs';

export const INTENT_TTL_MS = 300_000;
const err = (code) => { throw new RegistryError(code); };
const pairGreater = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const pairGe = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);

/** Synchronous key-value storage with atomic transactions (test swap). */
export class MapStorage {
  constructor() { this.m = new Map(); }
  transact(fn) {
    const backup = new Map(this.m);
    try { const r = fn(this); return r; }
    catch (e) { this.m = backup; throw e; }
  }
  get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  put(k, v) { this.m.set(k, structuredClone(v)); }
  del(k) { this.m.delete(k); }
  keys(prefix) { return [...this.m.keys()].filter((k) => !prefix || k.startsWith(prefix)); }
}

/** node:sqlite-backed variant (same interface). */
export class SqlStorage {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path); this.depth = 0; this.spN = 0;
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  }
  transact(fn) {
    const outer = this.depth === 0, sp = `sp${++this.spN}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try { const r = fn(this); this.depth--; this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`); return r; }
    catch (e) { this.depth--; try { this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}`); } catch {} throw e; }
  }
  get(k) { const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : undefined; }
  put(k, v) { this.db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, JSON.stringify(v)); }
  del(k) { this.db.prepare('DELETE FROM kv WHERE k = ?').run(k); }
  keys(prefix) {
    const rows = prefix
      ? this.db.prepare('SELECT k FROM kv WHERE k LIKE ? ESCAPE ? ORDER BY k').all(prefix + '%', '\\')
      : this.db.prepare('SELECT k FROM kv ORDER BY k').all();
    return rows.map((r) => r.k);
  }
}

/** One device index instance (deviceDid -> owner claim). */
export class DeviceIndexDO {
  constructor(storage, { transport = null } = {}) {
    this.storage = storage; this.transport = transport; // transport unused here; kept for interface symmetry
    this.did = storage.did ?? null;
  }
  static idFromDevice(did) { return `device:${did}`; }
  _row(tx) {
    const held = tx.get('held') ?? null;
    const closed = tx.get('closed') ?? {};
    return { held, closed };
  }
  claimByGeneration(tid, owner, gen, seq, inc) {
    return this.storage.transact((tx) => {
      if (tid !== (this.did ?? tid)) err('bad-device-did');
      const row = this._row(tx);
      const held = row.held;
      if (held && held.owner !== owner) err('device-registered-elsewhere');
      const closedPair = row.closed[owner];
      let ok = closedPair === undefined || pairGreater([inc, seq], closedPair);
      if (ok && held && held.owner === owner) ok = pairGe([inc, seq], [held.inc, held.seq]);
      if (ok && held && held.gen === gen && held.seq === seq && held.inc === inc) ok = true; // idempotent redelivery
      if (!ok) err('stale-claim');
      // Claim does NOT advance closed (only release may).
      tx.put('held', { owner, gen, seq, inc });
      return { status: 'claimed', generation: gen, seq, inc };
    });
  }
  release(tid, owner, gen, seq, inc) {
    return this.storage.transact((tx) => {
      const row = this._row(tx);
      const held = row.held;
      let released = false;
      if (held && held.owner === owner && held.gen === gen) released = true;
      if (released) tx.del('held');
      // Always advance the closed pair for this owner (even for no-ops).
      const cur = row.closed[owner];
      if (cur === undefined) row.closed[owner] = [inc, seq];
      else if (pairGreater([inc, seq], cur)) row.closed[owner] = [inc, seq];
      tx.put('closed', row.closed);
      return { released, generation: gen, seq, inc };
    });
  }
  lookup(tid) {
    return this.storage.transact((tx) => this._row(tx).held ?? null);
  }
}

/** Fake inter-DO transport (tests control delivery of releases). Claims are
 *  synchronous request/response; releases go through a queue. Routes to a
 *  per-device DeviceIndexDO map (get-or-create). */
export class FakeTransport {
  constructor() { this.indexes = new Map(); this.q = []; this.dropped = 0; this.duplicated = 0; }
  indexFor(tid) {
    if (!this.indexes.has(tid)) this.indexes.set(tid, new DeviceIndexDO(new MapStorage(), {}));
    const idx = this.indexes.get(tid);
    idx.did = tid;
    return idx;
  }
  claim(tid, owner, gen, seq, inc) { return this.indexFor(tid).claimByGeneration(tid, owner, gen, seq, inc); }
  lookup(tid) { return this.indexFor(tid).lookup(tid); }
  enqueueRelease(...args) { this.q.push(args); }
  async queue() { return this.q.length; }
  // Deliver one message (random index if sequence given via chooser).
  async deliverNext(pick = 0) {
    if (!this.q.length) return null;
    const [m] = this.q.splice(Math.min(pick, this.q.length - 1), 1);
    return this.indexFor(m[0]).release(...m);
  }
  async deliverAll() { let n = 0; while (this.q.length) { await this.deliverNext(0); n++; } return n; }
  dropNext() { this.q.shift(); this.dropped++; }
  duplicateNext() { if (this.q.length) { this.q.push([...this.q[0]]); this.duplicated++; } }
}

/** One owner registry instance (one storage per owner). */
export class OwnerRegistryDO {
  constructor(storage, { owner, now = () => Date.now(), transport = null, incarnation = 0 } = {}) {
    if (!owner) throw new Error('OwnerRegistryDO needs { owner } (one instance per owner)');
    checkOwner(owner);
    this.storage = storage; this.owner = owner; this.now = now; this.transport = transport;
    this.incarnation = incarnation;
    this.core = new RegistryCore({ now });
    this._stateKey = 'state';
    this._load();
  }
  static idFromOwner(owner) { checkOwner(owner); return owner; }
  _load() {
    const s = this.storage.get(this._stateKey);
    if (s) {
      const c = this.core;
      c.owners = new Map(s.owners.map(([k, r]) => [k, { ...r,
        devices: new Map(r.devices), packs: new Map(r.packs), reservations: new Map(r.reservations) }]));
      this.storage.__usedDirty = false;
    }
    const used = this.storage.get('used-items');
    if (used) this.core.usedStatements = new Map(used);
  }
  _save() {
    const c = this.core;
    const s = { owners: [...c.owners.entries()].map(([k, r]) => [k, {
      ...r, devices: [...r.devices.entries()], packs: [...r.packs.entries()],
      reservations: [...r.reservations.entries()] }]) };
    this.storage.put(this._stateKey, s);
    this.storage.put('used-items', [...c.usedStatements.entries()]);
  }
  _tx(fn) {
    return this.storage.transact(() => {
      this._load();
      const r = fn();
      this._sweepHeldGens(this.owner);
      this._drainOutbox();
      this._save();
      return r;
    });
  }

  // ---- intent API ----
  _intent(tid) { return this.storage.get(`intent/${tid}`) ?? null; }
  createIntent({ owner, deviceDid, incarnation = this.incarnation }) {
    return this._tx(() => {
      checkOwner(owner); const r = this.core.rec(owner); this.core.settle(r, this.now());
      const open = this._intent(deviceDid);
      if (open && open.expiresAt > this.now()) err('intent-open');
      // An expired intent that a new intent replaces must be closed first,
      // or its claim (if it was made) is never released: the alarm sweep
      // only sees intents that still exist.
      if (open) this._closeIntentLocked(owner, deviceDid, open);
      const seq = (this.storage.get(`seq/${deviceDid}`) ?? 0) + 1;
      const gen = randomBytes(16).toString('hex');
      const held = this._heldGens(owner, deviceDid);
      if (held.length >= HELD_GENS_CAP) err('held-gens-full');
      this.storage.put(`intent/${deviceDid}`, { generation: gen, seq, incarnation, expiresAt: this.now() + INTENT_TTL_MS });
      this.storage.put(`seq/${deviceDid}`, seq);
      return { generation: gen, seq, incarnation };
    });
  }
  _heldGens(owner, tid) { return this.storage.get(`heldGens/${owner}/${tid}`) ?? []; }
  _setHeldGens(owner, tid, list) {
    if (!list.length) this.storage.del(`heldGens/${owner}/${tid}`);
    else this.storage.put(`heldGens/${owner}/${tid}`, list.slice(-HELD_GENS_CAP));
  }
  // expiry cleanup for one terminal's open intent
  clearIntent({ owner, deviceDid }) {
    return this._tx(() => {
      const q = this._intent(deviceDid);
      if (!q) return { cleared: false };
      this._closeIntentLocked(owner, deviceDid, q, { clearOnly: false });
      return { cleared: true };
    });
  }
  _closeIntentLocked(owner, tid, q, { clearOnly = false } = {}) {
    const r = this.core.get(owner);
    const term = r?.devices.get(tid);
    const live = term && !term.revokedAt && !term.released;
    const pend = r && [...r.pending, ...r.pendingReleases, ...r.pendingRevokes].some((p) =>
      (!p.cancelledAt && !p.admittedAt && !p.doneAt) && (p.deviceDid === tid || p.targetDid === tid));
    if (live || pend) {
      const held = this._heldGens(owner, tid);
      if (!held.some((g) => g.gen === q.generation)) held.push({ gen: q.generation, seq: q.seq, inc: q.incarnation });
      this._setHeldGens(owner, tid, held);
    } else if (!clearOnly) {
      this._outboxPush(owner, tid, q.generation, q.seq, q.incarnation);
    }
    this.storage.del(`intent/${tid}`);
  }
  _outboxPush(owner, tid, gen, seq, inc) {
    const n = (this.storage.get('outbox-counter') ?? 0) + 1;
    this.storage.put(`outbox/${n}`, { id: n, owner, tid, gen, seq, inc, created: this.now() });
    this.storage.put('outbox-counter', n);
    this._setAlarm(this.now());
  }
  _setAlarm(ts) { this.alarmAt = Math.min(this.alarmAt ?? Infinity, ts); }
  // alarm handler: expiry + outbox drain (fake clock driven)
  alarm(now) {
    const n = typeof now === 'number' ? () => now : this.now;
    return this.storage.transact(() => {
      this._load();
      for (const rec of this.core.owners.values()) this.core.settle(rec, n());
      const intents = this.storage.keys('intent/');
      for (const k of intents) {
        const q = this.storage.get(k); const tid = k.split('/')[1];
        if (q.expiresAt <= n()) this._closeIntentLocked(this.owner, tid, q);
      }
      this._sweepHeldGens(this.owner);
      const r = this._drainOutbox();
      this._save();
      return r;
    });
  }
  _drainOutbox() {
    const rows = this.storage.keys('outbox/').sort().map((k) => this.storage.get(k));
    let delivered = 0;
    for (const row of rows) {
      const res = this.transport
        ? (this.transport.enqueueRelease(row.tid, row.owner, row.gen, row.seq, row.inc), { released: null, queued: true })
        : this._indexRelease(row);
      if (res.released) delivered++;
      this.storage.del(`outbox/${row.id}`);
      const held = this._heldGens(row.owner, row.tid);
      this._setHeldGens(row.owner, row.tid, held.filter((g) => !(g.gen === row.gen && g.seq === row.seq)));
    }
    return { drained: rows.length, delivered };
  }
  _indexRelease(row) {
    // default direct path (transport absent): resolve index via registry
    return this.index.release(row.tid, row.owner, row.gen, row.seq, row.inc);
  }

  // ---- registration (intent-first; live terminals: no intent) ----
  applyRegistration({ owner, deviceDid, approverDid, kind, incarnation = this.incarnation, transport = this.transport }) {
    if (kind !== 'seed' && kind !== 'existing-device') err('bad-registration-kind');
    checkDid(deviceDid); checkDid(approverDid);
    // Binding/permission first (oracle's applyRegistration wrapper does
    // this too) — the live fast path below must not bypass it.
    if (kind === 'seed') checkOwnerBinding(owner, approverDid);
    // 1) fast path (live terminal): no intent, no index touch
    const live = this._tx(() => {
      const r = this.core.get(owner);
      return r ? this.core.isLive(r, deviceDid) : null;
    });
    if (live) {
      this._tx(() => {
        const r = this.core.rec(owner); this.core.settle(r, this.now());
        if (kind === 'existing-device') {
          if (!this.core.isLive(r, approverDid)) err('approver-not-registered');
          if (r.batchRevokes.some((b) => !b.appliedAt)) err('batch-revoke-pending');
        }
        return { status: 'admitted', repeated: true };
      });
      return { status: 'admitted', repeated: true };
    }
    // 2) validate BEFORE intent/claim: binding, approver, kind, caps
    this._tx(() => {
      const r = this.core.rec(owner); this.core.settle(r, this.now());
      if (kind === 'seed') {
        checkOwnerBinding(owner, approverDid); // throws before any claim
        if (r.registrationDid && r.registrationDid !== approverDid) err('registration-key-mismatch');
      } else {
        if (!this.core.isLive(r, approverDid)) err('approver-not-registered');
        if (r.batchRevokes.some((b) => !b.appliedAt)) err('batch-revoke-pending');
      }
      const existing = r.devices.get(deviceDid);
      if ((existing?.revokedAt || existing?.released) && kind !== 'seed') err('device-revoked-seed-only');
      this.core.checkRegistrationRates({ owner, kind });
      this.core.checkRegisterable({ owner, deviceDid, kind });
    });
    // 3) intent (validates first, so a bad approver leaves no claim)
    const intent = this.createIntent({ owner, deviceDid, incarnation });
    // 4) claim via transport
    const tp = transport ?? this.transport;
    try {
      const target = tp?.lookup ? tp : null;
      if (!target) throw new Error('no-index-transport');
      target.claim(deviceDid, owner, intent.generation, intent.seq, intent.incarnation);
    } catch (e) {
      this.clearIntent({ owner, deviceDid });
      throw e;
    }
    // 5) settle + apply atomically inside the intent
    try {
      const out = this._tx(() => {
        const r = this.core.rec(owner); this.core.settle(r, this.now());
        const open = this._intent(deviceDid);
        if (!open || open.expiresAt <= this.now()) err('intent-gone');
        if (open.generation !== intent.generation) err('intent-gone');
        const res = this.core.applyRegistration({ owner, deviceDid, approverDid, kind, binding: (o, d) => checkOwnerBinding(o, d) });
        this.storage.del(`intent/${deviceDid}`);
        const held = this._heldGens(owner, deviceDid);
        held.push({ gen: intent.generation, seq: intent.seq, inc: intent.incarnation });
        this._setHeldGens(owner, deviceDid, held);
        return res;
      });
      return out;
    } catch (e) {
      // apply failed: intent already gone (consumed in tx above is rolled
      // back); expiry path will release via outbox. Clear defensively.
      this.storage.transact(() => { this._load(); const q = this._intent(deviceDid); if (q) this._closeIntentLocked(owner, deviceDid, q); this._save(); });
      throw e;
    }
  }

  // ---- tombstone ops: immediate tombstone + outbox in the same commit;
  // delayed tombstone (wait) outboxes when settle makes it effective ----
  _closeIntentNow(owner, tid) {
    const q = this._intent(tid);
    if (q) { this._outboxPush(owner, tid, q.generation, q.seq, q.incarnation); this.storage.del(`intent/${tid}`); }
  }
  // Release every generation the terminal may hold unless something still
  // relies on its index entry: a live terminal, or an open application (even
  // while the stored record is still a tombstone, e.g. re-registration after
  // release). Applications end by cancellation, replacement, an effective
  // revoke, or expiry; each of those turns `open` false, so the next sweep
  // empties the list and outboxes a release -- no claim is left behind.
  _sweepHeldGens(owner) {
    const r = this.core.get(owner);
    if (!r) return;
    const openApp = (tid) => r.pending.some((p) => p.deviceDid === tid && !p.cancelledAt && !p.admittedAt);
    const live = (tid) => { const t = r.devices.get(tid); return Boolean(t && !t.revokedAt && !t.released); };
    const tids = new Set(r.devices.keys());
    for (const p of r.pending) tids.add(p.deviceDid);
    const prefix = `heldGens/${owner}/`;
    for (const k of this.storage.keys(prefix)) tids.add(k.slice(prefix.length));
    for (const tid of tids) if (!live(tid) && !openApp(tid)) this._closeForDevice(owner, tid);
  }
  _closeForDevice(owner, tid) { // whole-list close (dead terminals only)
    const held = this._heldGens(owner, tid);
    for (const g of held) this._outboxPush(owner, tid, g.gen, g.seq, g.inc);
    this._setHeldGens(owner, tid, []);
  }
  revokeDevice(a) {
    return this._tx(() => {
      const r = this.core.revokeDevice(a);
      this._closeIntentNow(a.owner, a.targetDid);
      return r; // the transaction's sweep releases the terminal's held generations
    });
  }
  releaseDevice(a) {
    return this._tx(() => {
      const r = this.core.releaseDevice(a);
      this._closeIntentNow(a.owner, a.deviceDid);
      return r;
    });
  }
  cancelPending(a) {
    // Cancelling the last open application for a terminal leaves nothing
    // relying on its index entry; the transaction's sweep releases it.
    return this._tx(() => this.core.cancelPending(a));
  }
  requestBatchRevoke(a) {
    return this._tx(() => {
      const r = this.core.requestBatchRevoke(a);
      // batch revokes existing-device terminals at effect time; settle already
      // armed via core; outbox consequences land on settle (see revoke path).
      return r;
    });
  }
  consumeStatement(a) { return this._tx(() => this.core.consumeStatement(a)); }
  epochOf(a) { return this._tx(() => this.core.epochOf(a)); }
  registrationDidOf(a) { return this._tx(() => this.core.registrationDidOf(a)); }
  isLiveDevice(a) { return this._tx(() => this.core.isLiveDevice(a)); }
  deviceKnown(a) { return this._tx(() => this.core.deviceKnown(a)); }
  pendingState(a) { return this._tx(() => this.core.pendingState(a)); }
  checkRegistrationRates(a) { return this._tx(() => this.core.checkRegistrationRates(a)); }
  checkRegisterable(a) { return this._tx(() => this.core.checkRegisterable(a)); }
  checkBatchRate(a) { return this._tx(() => this.core.checkBatchRate(a)); }
  checkClaimable({ owner, deviceDid }) {
    const tp = this.transport;
    const held = tp ? tp.lookup(deviceDid) : null;
    if (held && held.owner !== owner) err('device-registered-elsewhere');
    return { status: 'ok' };
  }
  checkPackCapacity(a) { return this._tx(() => this.core.checkPackCapacity(a)); }
  releaseCapacity(a) { return this._tx(() => this.core.releaseCapacity(a)); }
  recordPack(a) { return this._tx(() => this.core.recordPack(a)); }
  ownerOfDevice({ deviceDid }) {
    // Index-driven (never the core's map): lookup device DO, then confirm
    // liveness against this owner's record.
    this._load();
    const tp = this.transport;
    const held = tp ? tp.lookup(deviceDid) : null;
    if (!held) return null;
    const r = this.core.get(held.owner);
    return r && this.core.isLive(r, deviceDid) ? held.owner : null;
  }
  canFetch({ deviceDid, sha256 }) {
    const owner = this.ownerOfDevice({ deviceDid });
    if (!owner) return null;
    return this._tx(() => {
      const r = this.core.get(owner);
      const pack = r?.packs.get(sha256);
      return pack ? { owner, pack } : null;
    });
  }
  publishHead(a) { return this._tx(() => this.core.publishHead(a)); }
  getHead(a) { return this._tx(() => this.core.getHead(a)); }
  packStatus(a) { return this._tx(() => this.core.packStatus(a)); }
  async expireIntents() { return this.alarm(this.now()); }
}
