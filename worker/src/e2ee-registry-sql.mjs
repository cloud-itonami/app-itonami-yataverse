// Sync-SQL Durable Object classes for the owner-scoped E2EE registry.
// DESIGN ONLY conversion of DO-DESIGN v6 (intent-first registration,
// per-owner closed pairs, heldGens lists). This file is the TEST-ONLY swap:
// it runs on node:sqlite DatabaseSync (synchronous SQL; every method is a
// single sync transaction, so no inspectable interleaving exists within a
// call). No wrangler binding, no migration, no deploy: production wiring
// stays 503 (see worker/src/index.mjs, worker/wrangler.jsonc).
//
// Differences from MemoryRegistry (the oracle, e2ee-registry.mjs):
// - registrations for non-live terminals go through intents: one open
//   intent per terminal (409 'intent-open' while open), a 128-bit random
//   generation, and a per-terminal monotonic seq;
// - claims/releases are arbitrated by SqlDeviceIndex with single
//   lexicographic (incarnation, seq) order on closed/held pairs, never
//   reset (construction flags `rules` exist ONLY so tests can record the
//   v5/broken rules failing: 'v5', 'no-close', 'reset');
// - a failing/expired intent on a live or pending terminal joins heldGens
//   (cap 32; new intents 429 'held-gens-full' when full, never dropped);
// - live-terminal re-registration returns admitted/repeated with NO intent
//   and never touches the index (same as the oracle);
// - statements carry an incarnation (see e2ee-statement.mjs): the owner
//   record does NOT store it; it comes from the allowlist
//   (`owner:generation`, §9.2) and is passed in by the caller.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryRegistry, RegistryError, RECOVERY_WAIT_MS } from './e2ee-registry.mjs';

export const HELD_GENS_CAP = 32;
export const INTENT_TTL_MS = 300_000; // 5 min, <= statement window

const pairGreater = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const pairGe = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);

/** One shared sync-SQL database (test-only swap). */
export class SyncDb {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.depth = 0; this.spN = 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS devices (tid TEXT PRIMARY KEY, held TEXT, closed TEXT);
      CREATE TABLE IF NOT EXISTS intents (owner TEXT, tid TEXT, gen TEXT, seq INTEGER, inc INTEGER, expires INTEGER, PRIMARY KEY (owner, tid));
      CREATE TABLE IF NOT EXISTS held_gens (owner TEXT, tid TEXT, held TEXT, PRIMARY KEY (owner, tid));
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, tid TEXT, gen TEXT, seq INTEGER, inc INTEGER, created INTEGER);`);
  }
  transactionSync(fn) {
    const outer = this.depth === 0;
    const sp = `sp${++this.spN}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.depth--;
      try { this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}`); } catch {}
      throw e;
    }
  }
  get(k) { const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : undefined; }
  put(k, v) { this.db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, JSON.stringify(v)); }
}

// Lexicographic-pair device index. The row is never deleted; only `held`
// clears. `rules` selects the arbitration variant (tests only):
//   'pair' (v6, default) | 'v5' (seq>closed, inc resets) |
//   'no-close' (release deletes without advancing) | 'reset' (inc rise resets)
export class SqlDeviceIndex {
  constructor(db, { rules = 'pair' } = {}) {
    this.db = db; this.rules = rules;
  }
  _row(tid) {
    const r = this.db.db.prepare('SELECT held, closed FROM devices WHERE tid = ?').get(tid);
    if (!r) return null;
    return { held: r.held ? JSON.parse(r.held) : null, closed: r.closed ? JSON.parse(r.closed) : {} };
  }
  _ensure(tid) {
    this.db.db.prepare('INSERT OR IGNORE INTO devices (tid, held, closed) VALUES (?, NULL, ?)').run(tid, '{}');
  }
  claimByGeneration(tid, owner, gen, seq, inc) {
    return this.db.transactionSync(() => {
      this._ensure(tid);
      const row = this._row(tid);
      const held = row.held;
      const closedMap = { ...row.closed };
      const closedPair = closedMap[owner] ?? (this.rules === 'v5' ? [0, 0] : null);
      if (held && held.owner !== owner) throw new RegistryError('device-registered-elsewhere');
      let ok;
      if (this.rules === 'pair') {
        ok = closedPair === null || pairGreater([inc, seq], closedPair);
        if (ok && held && held.owner === owner) ok = pairGe([inc, seq], [held.inc, held.seq]);
        if (ok && held && held.gen === gen && held.seq === seq && held.inc === inc) ok = true; // retry
      } else if (this.rules === 'v5') {
        ok = closedPair === null || inc > closedPair[0] || (inc === closedPair[0] && seq > closedPair[1]);
      } else { // 'no-close' | 'reset' share pair-accept for claims
        ok = closedPair === null || pairGreater([inc, seq], closedPair);
      }
      if (!ok) throw new RegistryError('stale-claim');
      const nextClosed = { ...closedMap };
      if (this.rules === 'pair') {
        if (closedPair === null || pairGreater([inc, seq], closedPair)) nextClosed[owner] = [inc, seq];
      } else if (this.rules === 'reset' || (this.rules === 'no-close' && closedPair !== null && inc > closedPair[0])) {
        nextClosed[owner] = [inc, 0]; // broken: reset
      } // v5: claim does NOT advance closed (that is what makes it broken)
      this.db.db.prepare('UPDATE devices SET held = ?, closed = ? WHERE tid = ?')
        .run(JSON.stringify({ owner, gen, seq, inc }), JSON.stringify(nextClosed), tid);
      return { status: 'claimed', generation: gen, seq, inc };
    });
  }
  release(tid, owner, gen, seq, inc) {
    return this.db.transactionSync(() => {
      this._ensure(tid);
      const row = this._row(tid);
      const held = row.held;
      let released = false;
      if (held && held.owner === owner && held.gen === gen) released = true;
      if (released) {
        this.db.db.prepare('UPDATE devices SET held = NULL WHERE tid = ?').run(tid);
      }
      const closedMap = { ...row.closed };
      if (this.rules === 'no-close') {
        delete closedMap[owner]; // broken: no memory of the release
        this.db.db.prepare('UPDATE devices SET closed = ? WHERE tid = ?').run(JSON.stringify(closedMap), tid);
      } else if (this.rules === 'reset') {
        if (released) closedMap[owner] = [0, 0]; // broken: reset
        this.db.db.prepare('UPDATE devices SET closed = ? WHERE tid = ?').run(JSON.stringify(closedMap), tid);
      } else {
        // pair + v5: always advance (pair form: lexicographic max, per owner)
        const cur = closedMap[owner];
        if (cur === undefined) closedMap[owner] = [inc, seq];
        else if (this.rules === 'pair') {
          if (pairGreater([inc, seq], cur)) closedMap[owner] = [inc, seq];
        } else { // v5: numeric max within same incarnation
          if (inc === cur[0]) closedMap[owner] = [cur[0], Math.max(cur[1], seq)];
        }
        this.db.db.prepare('UPDATE devices SET closed = ? WHERE tid = ?').run(JSON.stringify(closedMap), tid);
      }
      return { released, generation: gen, seq, inc };
    });
  }
  lookup(tid) { const r = this._row(tid); return r ? r.held : null; }
}

// Owner registry over a MemoryRegistry oracle for state transitions, with
// durable intent/outbox tables in sync SQL. State persists as JSON in `kv`
// per owner; every public method runs in one sync transaction.
// Lifetime mapping to the oracle: live/pack/head/epoch semantics are the
// oracle's; intents + claims are the v6 layer on top.
export class SqlOwnerRegistry {
  constructor({ db, index, now = () => Date.now(), incarnation = 0, rules = 'pair' } = {}) {
    if (!db) throw new Error('SqlOwnerRegistry needs a SyncDb');
    this.db = db; this.index = index ?? new SqlDeviceIndex(db, { rules });
    this.now = now; this.incarnation = incarnation;
    this.oracle = new MemoryRegistry({ now });
  }
  // ---- durable oracle state (hex-safe JSON clone of the Maps) ----
  _snapshot() {
    const o = this.oracle;
    return {
      owners: [...o.owners.keys()].map((k) => [k, {
        owner: k, epoch: o._get(k).epoch, registrationDid: o._get(k).registrationDid,
        headSeq: o._get(k).headSeq, headSha: o._get(k).headSha, headName: o._get(k).headName,
        cancelsUsed: o._get(k).cancelsUsed, nextId: o._get(k).nextId,
        devices: [...o._get(k).devices.entries()],
        packs: [...o._get(k).packs.entries()],
        pending: o._get(k).pending, batchRevokes: o._get(k).batchRevokes,
        pendingReleases: o._get(k).pendingReleases, pendingRevokes: o._get(k).pendingRevokes,
        reservations: [...o._get(k).reservations.entries()],
        appTimes: o._get(k).appTimes, batchTimes: o._get(k).batchTimes, headTimes: o._get(k).headTimes,
      }]),
      deviceIndex: [...o.deviceIndex.entries()],
      usedStatements: [...o.usedStatements.entries()],
    };
  }
  _restore(s) {
    const o = this.oracle;
    o.owners = new Map(s.owners.map(([k, r]) => [k, {
      ...r, devices: new Map(r.devices), packs: new Map(r.packs), reservations: new Map(r.reservations),
    }]));
    o.deviceIndex = new Map(s.deviceIndex);
    o.usedStatements = new Map(s.usedStatements);
  }
  _save() { this.db.put('oracle-state', this._snapshot()); }
  _load() { const s = this.db.get('oracle-state'); if (s) this._restore(s); }

  _intentRow(owner, tid) {
    return this.db.db.prepare('SELECT gen, seq, inc, expires FROM intents WHERE owner = ? AND tid = ?').get(owner, tid);
  }
  _heldGens(owner, tid) {
    const raw = this.db.db.prepare('SELECT held FROM held_gens WHERE owner = ? AND tid = ?').get(owner, tid);
    return raw ? JSON.parse(raw.held) : [];
  }
  _setHeldGens(owner, tid, list) {
    if (!list.length) {
      this.db.db.prepare('DELETE FROM held_gens WHERE owner = ? AND tid = ?').run(owner, tid);
      return;
    }
    this.db.db.prepare('INSERT OR REPLACE INTO held_gens (owner, tid, held) VALUES (?, ?, ?)')
      .run(owner, tid, JSON.stringify(list.slice(-HELD_GENS_CAP)));
  }

  // ---- intent API (v6 §2.2) ----
  async createIntent({ owner, deviceDid, expiresAt, incarnation }) {
    return this.db.transactionSync(() => {
      this._load();
      this.oracle.epochOf({ owner }); // settle (no-op if absent)
      const open = this._intentRow(owner, deviceDid);
      if (open && open.expires > this.now()) throw new RegistryError('intent-open');
      const gen = randomBytes(16).toString('hex');
      const seq = (this.db.get(`seq:${owner}:${deviceDid}`) ?? 0) + 1;
      const r = this.oracle._get(owner);
      const held = r?.devices.get(deviceDid)?.heldGens ?? [];
      if (held.length >= HELD_GENS_CAP) throw new RegistryError('held-gens-full');
      this.db.db.prepare('INSERT OR REPLACE INTO intents (owner, tid, gen, seq, inc, expires) VALUES (?, ?, ?, ?, ?, ?)')
        .run(owner, deviceDid, gen, seq, incarnation, expiresAt);
      this.db.put(`seq:${owner}:${deviceDid}`, seq);
      this._save();
      return { generation: gen, seq, incarnation };
    });
  }
  async clearIntent({ owner, deviceDid, generation, seq }) {
    return this.db.transactionSync(() => {
      this._load();
      const open = this._intentRow(owner, deviceDid);
      if (!open) return { cleared: false };
      if (open.gen !== generation || open.seq !== seq) return { cleared: false };
      this.db.db.prepare('DELETE FROM intents WHERE owner = ? AND tid = ?').run(owner, deviceDid);
      this._save();
      return { cleared: true };
    });
  }
  // expire open intents: live/pending -> heldGens; else outbox + clear (same tx)
  async expireIntents() {
    return this.db.transactionSync(() => {
      this._load();
      const rows = this.db.db.prepare('SELECT owner, tid, gen, seq, inc, expires FROM intents WHERE expires <= ?').all(this.now());
      for (const row of rows) {
        const r = this.oracle._get(row.owner);
        const term = r?.devices.get(row.tid);
        const live = term && !term.revokedAt && !term.released;
        const pend = (r?.pending ?? []).some((p) => p.deviceDid === row.tid && !p.cancelledAt && !p.admittedAt);
        if (live || pend) {
          const held = this._heldGens(row.owner, row.tid);
          if (!held.some((g) => g.gen === row.gen && g.seq === row.seq)) held.push({ gen: row.gen, seq: row.seq, inc: row.inc });
          this._setHeldGens(row.owner, row.tid, held);
        } else {
          this.db.db.prepare('INSERT INTO outbox (owner, tid, gen, seq, inc, created) VALUES (?, ?, ?, ?, ?, ?)')
            .run(row.owner, row.tid, row.gen, row.seq, row.inc, this.now());
        }
        this.db.db.prepare('DELETE FROM intents WHERE owner = ? AND tid = ?').run(row.owner, row.tid);
      }
      this._save();
      return { expired: rows.length };
    });
  }
  // drain outbox through the device index; prune delivered gens from heldGens.
  // `_drainTx` assumes oracle state is loaded in the current transaction.
  async drainOutbox() {
    return this.db.transactionSync(() => {
      this._load();
      const r = this._drainTx();
      this._save();
      return r;
    });
  }
  _drainTx() {
      const rows = this.db.db.prepare('SELECT id, owner, tid, gen, seq, inc FROM outbox ORDER BY id').all();
      let delivered = 0;
      for (const row of rows) {
        const res = this.index.release(row.tid, row.owner, row.gen, row.seq, row.inc);
        if (res.released) delivered++;
        this.db.db.prepare('DELETE FROM outbox WHERE id = ?').run(row.id);
        const held = this._heldGens(row.owner, row.tid);
        this._setHeldGens(row.owner, row.tid, held.filter((g) => !(g.gen === row.gen && g.seq === row.seq)));
      }
      return { drained: rows.length, delivered };
  }

  // After a mutating oracle op, queue + drain index releases for every
  // terminal that no longer relies on the index (revoked/released with no
  // live record and no pending application). This mirrors design §2.4/§2.9
  // (tombstone + outbox in the same commit) inside the test-only swap.
  _syncIndexReleases() {
    for (const [owner, rec] of this.oracle.owners) {
      for (const [tid, term] of rec.devices) {
        const live = !term.revokedAt && !term.released;
        const pend = (rec.pending ?? []).some((p) => p.deviceDid === tid && !p.cancelledAt && !p.admittedAt);
        if (live || pend) continue;
        const held = this._heldGens(owner, tid);
        for (const g of held) {
          this.db.db.prepare('INSERT INTO outbox (owner, tid, gen, seq, inc, created) VALUES (?, ?, ?, ?, ?, ?)')
            .run(owner, tid, g.gen, g.seq, g.inc, this.now());
        }
        if (held.length) this._setHeldGens(owner, tid, []);
      }
    }
    this._drainTx();
  }
  _mut(fn) {
    return this.db.transactionSync(() => {
      this._load();
      const r = fn();
      this._syncIndexReleases();
      this._save();
      return r;
    });
  }

  // ---- legacy interface (delegates to the oracle; intents wrap register) ----
  async consumeStatement(args) { return this._mut(() => this.oracle.consumeStatement(args)); }
  async checkBatchRate(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.checkBatchRate(a); }); }
  async isLiveDevice(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.isLiveDevice(a); }); }
  async pendingState(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.pendingState(a); }); }
  async deviceKnown(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.deviceKnown(a); }); }
  async checkRegistrationRates(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.checkRegistrationRates(a); }); }
  async checkRegisterable(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.checkRegisterable(a); }); }
  async checkClaimable(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.checkClaimable(a); }); }
  async registrationDidOf(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.registrationDidOf(a); }); }
  async epochOf(a) { return this._mut(() => this.oracle.epochOf(a)); }
  async checkPackCapacity(a) { return this._mut(() => this.oracle.checkPackCapacity(a)); }
  async releaseCapacity(a) { return this._mut(() => this.oracle.releaseCapacity(a)); }
  async recordPack(a) { return this._mut(() => this.oracle.recordPack(a)); }
  async ownerOfDevice(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.ownerOfDevice(a); }); }
  async canFetch(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.canFetch(a); }); }
  async publishHead(a) { return this._mut(() => this.oracle.publishHead(a)); }
  async getHead(a) { return this.db.transactionSync(() => { this._load(); return this.oracle.getHead(a); }); }
  async packStatus(a) { return this._mut(() => this.oracle.packStatus(a)); }
  async cancelPending(a) { return this._mut(() => this.oracle.cancelPending(a)); }
  async revokeDevice(a) { return this._mut(() => this.oracle.revokeDevice(a)); }
  async requestBatchRevoke(a) { return this._mut(() => this.oracle.requestBatchRevoke(a)); }
  async releaseDevice(a) { return this._mut(() => this.oracle.releaseDevice(a)); }

  // Registration with intent-first claim/settle (v6 §2.2). Live-terminal
  // fast path: admitted/repeated with no intent and no index touch.
  async applyRegistration({ owner, deviceDid, approverDid, kind, incarnation = this.incarnation }) {
    // Three legs (test-only swap): [A] settle + fast-path + intent+seq
    // alloc, committed; [B] claim (own tx); [C] apply + clear, committed.
    // A claim failure therefore never rolls back the seq allocation.
    const legA = () => this.db.transactionSync(() => {
      this._load();
      // Settle the registering owner's record only (same scope as the
      // oracle's applyRegistration); index releases from earlier ops were
      // already synced into outbox+held at those ops' commits.
      const prior = this.oracle._get(owner);
      if (prior) this.oracle._settle(prior, this.now());
      this._syncIndexReleases();
      const existing = this.oracle._get(owner)?.devices.get(deviceDid);
      if (existing && !existing.revokedAt && !existing.released) {
        // Permission check must still run (approver liveness etc.)
        if (kind === 'existing-device') {
          const r = this.oracle._get(owner);
          if (!r || !this.oracle._isLive(r, approverDid)) throw new RegistryError('approver-not-registered');
          if (r.batchRevokes.some((b) => !b.appliedAt)) throw new RegistryError('batch-revoke-pending');
        }
        return { fast: { status: 'admitted', repeated: true } };
      }
      const open = this._intentRow(owner, deviceDid);
      if (open && open.expires > this.now()) throw new RegistryError('intent-open');
      const held = existing?.heldGens ?? [];
      if (held.length >= HELD_GENS_CAP) throw new RegistryError('held-gens-full');
      const gen = randomBytes(16).toString('hex');
      const seq = (this.db.get(`seq:${owner}:${deviceDid}`) ?? 0) + 1;
      this.db.db.prepare('INSERT OR REPLACE INTO intents (owner, tid, gen, seq, inc, expires) VALUES (?, ?, ?, ?, ?, ?)')
        .run(owner, deviceDid, gen, seq, incarnation, this.now() + INTENT_TTL_MS);
      this.db.put(`seq:${owner}:${deviceDid}`, seq);
      this._save();
      return { gen, seq };
    });
    const a = legA();
    if (a.fast) return a.fast;
    // [B] claim
    try {
      this.index.claimByGeneration(deviceDid, owner, a.gen, a.seq, incarnation);
    } catch (e) {
      await this.clearIntent({ owner, deviceDid, generation: a.gen, seq: a.seq });
      throw e;
    }
    // [C] apply + clear
    return this.db.transactionSync(() => {
      this._load();
      let out;
      try {
        out = this.oracle.applyRegistration({ owner, deviceDid, approverDid, kind });
      } catch (e) {
        this.db.db.prepare('DELETE FROM intents WHERE owner = ? AND tid = ?').run(owner, deviceDid);
        this._save();
        throw e;
      }
      this.db.db.prepare('DELETE FROM intents WHERE owner = ? AND tid = ?').run(owner, deviceDid);
      // record held generation (covers admitted and pending applications)
      const heldNow = this._heldGens(owner, deviceDid);
      heldNow.push({ gen: a.gen, seq: a.seq, inc: incarnation });
      this._setHeldGens(owner, deviceDid, heldNow);
      this._save();
      return out;
    });
  }
}
