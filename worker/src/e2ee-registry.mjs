// Owner registration table for owner-scoped E2EE packs (design §3).
//
// One table per owner pseudonym, single writer, monotone revocation, plus one
// global device->owner index. The production shape is one Durable Object
// instance per owner plus a single DeviceIndexDO; this module implements the
// same interface in memory so the HTTP layer and its tests run with fake
// storage only. No Durable Object is created here and no binding is wired in
// wrangler.jsonc (pending approval): with no registry configured the HTTP
// layer answers 503, never open.
//
// Rules implemented here (design §0, §3–§5, fix design §§1–5):
// - A pack record is created only after bytes + readback verify (the HTTP
//   layer enforces the order; this table only records). Per-owner pack
//   count/byte caps bound capacity before any owner allowlist is consulted.
// - revokedAt is set once and never cleared; epoch only increases.
// - Registration wait (3 days, provisional) applies ONLY to seed (recovery)
//   registrations and batch revoke. Existing-device additions are admitted
//   immediately (approver signature + device consent already authenticate),
//   and are frozen while a batch revoke is pending.
// - Cancel: a registered, non-revoked device may cancel a pending seed
//   registration once per owner per epoch; the budget resets on epoch
//   advance and on admission of a seed registration. The seed ultimately
//   wins: a new seed application supersedes a pending one for the same device.
// - Batch revoke (epoch advance) carries the same wait, is applied BEFORE
//   pending admissions in _settle, and exempts seed-registered devices
//   (only existing-device terminals are revoked). Existing-device additions
//   are frozen while a batch revoke is pending, so a stolen terminal cannot
//   survive one by adding its own device.
// - Head ordering: the table is the ordering authority; publish requires the
//   next sequence and binds the head name at first publish.
// - Every GET reads the table at request time: revocation takes effect for
//   the next request, not after a cache window.
// - Signed statements are single-use: consumeStatement rejects replays,
//   expired statements and epoch-stale statements.
//
// Concurrency note (DO wiring): the in-memory methods below contain no await
// between their validation and their writes, so each call is atomic in this
// process. Cloudflare Durable Objects can interleave requests at awaits;
// the DO wiring step must keep the same no-await-between-check-and-write
// discipline (or use a transaction) and keep capacity reservations, which
// already make concurrent PUTs safe against overshoot.

import { ed25519PubFromDidKey } from './cacao-auth.mjs';
import { ownerFromRegistrationPub } from '../../src/recovery-derivation.mjs';

export const RECOVERY_WAIT_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_PER_LANE = 3;
export const MAX_APPLICATIONS_PER_LANE_PER_HOUR = 10;
export const MAX_BATCH_REVOKES_PER_DAY = 1;
export const MAX_HEAD_PUBLISHES_PER_HOUR = 100;
// Pack caps encode the assumed scale: one owner holds originals of about
// 1.6 GiB in packs of at most 12 MiB, plus head records; 1024 packs and
// 4 GiB total cover that with headroom. Real B2 cost and production caps
// are handled as a separate item before public exposure.
export const MAX_PACKS_PER_OWNER = 1024;
export const MAX_PACK_BYTES_PER_OWNER = 4 * 1024 * 1024 * 1024;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export class RegistryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const OWNER_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;

function checkOwner(owner) { if (!OWNER_RE.test(String(owner ?? ''))) throw new RegistryError('bad-owner'); }
function checkSha(sha) { if (!SHA_RE.test(String(sha ?? ''))) throw new RegistryError('bad-sha256'); }
function checkDid(did) { if (!DID_RE.test(String(did ?? ''))) throw new RegistryError('bad-device-did'); }
const within = (arr, now, window) => arr.filter((t) => t > now - window);

/** Owner <-> registration-key binding: owner must equal sha256(prefix || reg pub). */
export function checkOwnerBinding(owner, registrationDid) {
  const pub = ed25519PubFromDidKey(registrationDid);
  if (!pub || ownerFromRegistrationPub(pub) !== owner) throw new RegistryError('owner-binding-mismatch');
}

export class MemoryRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.owners = new Map();
    this.deviceIndex = new Map(); // deviceDid -> owner (global DeviceIndexDO shape)
    this.usedStatements = new Map(); // raw signature -> expiresAt (global; no owner record needed)
  }

  _rec(owner) {
    checkOwner(owner);
    let r = this.owners.get(owner);
    if (!r) {
      r = { owner, devices: new Map(), packs: new Map(), pending: [], batchRevokes: [],
            pendingReleases: [], pendingRevokes: [],
            headSeq: 0, headSha: null, headName: null, epoch: 0, registrationDid: null,
            cancelsUsed: 0, nextId: 1, reservations: new Map(),
            appTimes: { seed: [], existing: [] }, batchTimes: [], headTimes: [] };
      this.owners.set(owner, r);
    }
    return r;
  }

  /** Read-only lookup: never creates an owner record. */
  _get(owner) { checkOwner(owner); return this.owners.get(owner) ?? null; }

  _liveDevices(r) { return [...r.devices.values()].filter((d) => !d.revokedAt && !d.released); }

  /** Unified cancel + provisional-index release for one pending application. */
  _cancelApplication(r, p, now) {
    p.cancelledAt = now;
    if (p.deviceDid && this.deviceIndex.get(p.deviceDid) === r.owner) {
      const d = r.devices.get(p.deviceDid);
      const live = d && !d.revokedAt && !d.released;
      const other = [...r.pending, ...r.pendingReleases, ...r.pendingRevokes]
        .some((q) => q !== p && (q.deviceDid === p.deviceDid || q.targetDid === p.deviceDid)
          && !q.cancelledAt && !q.admittedAt && !q.doneAt);
      if (!live && !other) this.deviceIndex.delete(p.deviceDid);
    }
  }

  /** End every not-yet-effective application for one device (entry via another path). */
  _endApplicationsFor(r, did, now) {
    for (const p of r.pending) if (p.deviceDid === did && !p.admittedAt && !p.cancelledAt) this._cancelApplication(r, p, now);
  }

  /** Settle in effective-time order, one event at a time, so the outcome
   *  never depends on when reads happen. Same-time order: batch revokes and
   *  zero-terminal ops before admissions (revocation wins ties). Exclusion
   *  from a batch is by application time, including later-added devices:
   *  pendings applied before the batch request are cancelled at its effect. */
  _settle(r, now) {
    const events = [];
    for (const b of r.batchRevokes) if (!b.appliedAt && b.effectiveAt <= now) events.push({ t: b.effectiveAt, pri: 0, kind: 'batch', ref: b });
    for (const p of r.pendingReleases) if (!p.cancelledAt && !p.doneAt && p.effectiveAt <= now) events.push({ t: p.effectiveAt, pri: 0, kind: 'release', ref: p });
    for (const p of r.pendingRevokes) if (!p.cancelledAt && !p.doneAt && p.effectiveAt <= now) events.push({ t: p.effectiveAt, pri: 0, kind: 'revoke', ref: p });
    for (const p of r.pending) if (!p.cancelledAt && !p.admittedAt && p.admitAt <= now) events.push({ t: p.admitAt, pri: 1, kind: 'admit', ref: p });
    events.sort((a, b) => a.t - b.t || a.pri - b.pri);
    for (const e of events) {
      if (e.kind === 'batch') {
        const b = e.ref;
        b.appliedAt = e.t;
        r.epoch += 1;
        r.cancelsUsed = 0;
        for (const d of r.devices.values()) {
          const appliedAt = d.appliedAt ?? d.approvedAt;
          if (!d.revokedAt && !d.released && !(d.kind === 'seed' && appliedAt >= b.requestedAt)) {
            d.revokedAt = e.t;
            if (this.deviceIndex.get(d.did) === r.owner) this.deviceIndex.delete(d.did);
          }
        }
        for (const p of r.pending) if (!p.admittedAt && !p.cancelledAt && p.appliedAt < b.requestedAt) this._cancelApplication(r, p, e.t);
      } else if (e.kind === 'release') {
        const p = e.ref;
        p.doneAt = e.t;
        const d = r.devices.get(p.deviceDid);
        if (d) { d.released = true; d.releasedAt = e.t; }
        for (const q of [...r.pending]) if (q.deviceDid === p.deviceDid && !q.admittedAt) this._cancelApplication(r, q, e.t);
        if (this.deviceIndex.get(p.deviceDid) === r.owner) this.deviceIndex.delete(p.deviceDid);
      } else if (e.kind === 'revoke') {
        const p = e.ref;
        p.doneAt = e.t;
        const d = r.devices.get(p.targetDid);
        if (d && !d.revokedAt) d.revokedAt = e.t;
        if (this.deviceIndex.get(p.targetDid) === r.owner) this.deviceIndex.delete(p.targetDid);
      } else {
        const p = e.ref;
        p.admittedAt = e.t;
        const old = r.devices.get(p.deviceDid);
        // Never overwrite a live record: entry via another path already ended this one.
        if (old && !old.revokedAt && !old.released) continue;
        // An application issued before a revocation/release must not revive.
        const killAt = Math.max(old?.revokedAt ?? 0, old?.releasedAt ?? 0);
        if (old && killAt && p.appliedAt < killAt) { this._cancelApplication(r, p, e.t); continue; }
        // A revoked/released device coming back via seed gets a new generation.
        r.devices.set(p.deviceDid, { did: p.deviceDid, approvedBy: p.approverDid, kind: p.kind,
          approvedAt: e.t, appliedAt: p.appliedAt, revokedAt: 0, released: false, releasedAt: 0,
          generation: (old?.generation ?? 0) + 1 });
        if (p.kind === 'seed') r.cancelsUsed = 0;
      }
    }
    r.appTimes.seed = within(r.appTimes.seed, now, HOUR);
    r.appTimes.existing = within(r.appTimes.existing, now, HOUR);
    r.batchTimes = within(r.batchTimes, now, DAY);
    r.headTimes = within(r.headTimes, now, HOUR);
    for (const [h, rv] of r.reservations) if (rv.expiresAt <= now) r.reservations.delete(h);
  }

  _isLive(r, did) {
    this._settle(r, this.now());
    const d = r.devices.get(did);
    return d && !d.revokedAt && !d.released ? d : null;
  }

  /** Current epoch for statement signing / the status endpoint. Settles first. */
  async epochOf({ owner }) {
    const r = this._get(owner);
    if (r) this._settle(r, this.now());
    return r?.epoch ?? 0;
  }

  /**
   * Single-use statement gate (fix design §1): the HTTP layer verifies the
   * Ed25519 signature and the actor's liveness first, then consumes here.
   * Rejects expired, epoch-stale and replayed statements. Creates no owner
   * record: the used list is global.
   */
  async consumeStatement({ owner, signature, expiresAt, epoch }) {
    checkOwner(owner);
    const now = this.now();
    for (const [h, exp] of this.usedStatements) if (exp <= now) this.usedStatements.delete(h);
    const rec = this._get(owner);
    if (rec) this._settle(rec, now);
    const current = rec?.epoch ?? 0;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new RegistryError('statement-expired');
    if (epoch !== current) throw new RegistryError('statement-stale-epoch');
    const h = String(signature);
    if (this.usedStatements.has(h)) throw new RegistryError('statement-replayed');
    this.usedStatements.set(h, expiresAt);
    return { status: 'consumed' };
  }

  /**
   * Apply a registration. The device index claim happens FIRST
   * (set-if-absent) and is undone if the apply fails, so concurrent claims
   * race safely. kind 'seed': approverDid must be the bound registrationDid
   * (first seed registration binds it); the 3-day wait applies while a
   * non-revoked device remains. kind 'existing-device': approver must be a
   * live device; admitted immediately; frozen while a batch revoke is pending.
   */
  async applyRegistration({ owner, deviceDid, approverDid, kind }) {
    checkDid(deviceDid); checkDid(approverDid);
    checkOwner(owner);
    // Binding before any record, claim or count (unbound attempts are free).
    if (kind === 'seed') checkOwnerBinding(owner, approverDid);
    if (kind !== 'seed' && kind !== 'existing-device') throw new RegistryError('bad-registration-kind');
    // An existing-device application for an unknown owner fails before any record.
    if (kind === 'existing-device' && !this._get(owner)) throw new RegistryError('approver-not-registered');
    const mapped = this.deviceIndex.get(deviceDid);
    if (mapped && mapped !== owner) throw new RegistryError('device-registered-elsewhere');
    const claimed = !mapped;
    if (claimed) this.deviceIndex.set(deviceDid, owner);
    try {
      return await this._applyRegistration({ owner, deviceDid, approverDid, kind });
    } catch (e) {
      if (claimed && this.deviceIndex.get(deviceDid) === owner) this.deviceIndex.delete(deviceDid);
      throw e;
    }
  }

  async _applyRegistration({ owner, deviceDid, approverDid, kind }) {
    const r = this._rec(owner); const now = this.now();
    this._settle(r, now);
    const existing = r.devices.get(deviceDid);
    if (existing && !existing.revokedAt && !existing.released) return { status: 'admitted', repeated: true };
    // A revoked/released device may only come back via a seed application (new generation).
    if ((existing?.revokedAt || existing?.released) && kind !== 'seed') throw new RegistryError('device-revoked-seed-only');
    const lane = kind === 'seed' ? 'seed' : 'existing';
    if (r.appTimes[lane].length >= MAX_APPLICATIONS_PER_LANE_PER_HOUR) throw new RegistryError('registration-rate');
    r.appTimes[lane].push(now);
    if (kind === 'seed') {
      checkOwnerBinding(owner, approverDid);
      if (r.registrationDid && r.registrationDid !== approverDid) throw new RegistryError('registration-key-mismatch');
      // A new seed application supersedes any pending one for the same device.
      for (const p of r.pending) if (p.deviceDid === deviceDid && !p.cancelledAt && !p.admittedAt) p.cancelledAt = now;
      const lanePending = r.pending.filter((p) => p.kind === 'seed' && !p.cancelledAt && !p.admittedAt).length;
      if (lanePending >= MAX_PENDING_PER_LANE) throw new RegistryError('too-many-pending');
    } else {
      if (!this._isLive(r, approverDid)) throw new RegistryError('approver-not-registered');
      if (r.batchRevokes.some((b) => !b.appliedAt)) throw new RegistryError('batch-revoke-pending');
      r.devices.set(deviceDid, { did: deviceDid, approvedBy: approverDid, kind, approvedAt: now,
        appliedAt: now, revokedAt: 0, released: false, releasedAt: 0, generation: (existing?.generation ?? 0) + 1 });
      // Entry via this path ends any other application for the device.
      this._endApplicationsFor(r, deviceDid, now);
      return { status: 'admitted', repeated: false };
    }
    if (this._liveDevices(r).length === 0) {
      r.registrationDid = approverDid;
      r.devices.set(deviceDid, { did: deviceDid, approvedBy: approverDid, kind, approvedAt: now,
        appliedAt: now, revokedAt: 0, released: false, releasedAt: 0, generation: (existing?.generation ?? 0) + 1 });
      r.cancelsUsed = 0;
      return { status: 'admitted', repeated: false };
    }
    const id = r.nextId++;
    const admitAt = now + RECOVERY_WAIT_MS;
    r.pending.push({ id, deviceDid, approverDid, kind, appliedAt: now, admitAt,
                     cancelledAt: 0, cancelledBy: null, cancellable: r.cancelsUsed < 1 });
    // Bound only once the application exists past every check above.
    if (!r.registrationDid) r.registrationDid = approverDid;
    return { status: 'pending', id, admitAt };
  }

  /** Cancel a pending registration or zero-terminal op. Actor must be live; once per epoch. */
  async cancelPending({ owner, actorDid, pendingId }) {
    checkDid(actorDid);
    const r = this._get(owner);
    if (!r) throw new RegistryError('actor-not-registered');
    const now = this.now();
    this._settle(r, now);
    if (!this._isLive(r, actorDid)) throw new RegistryError('actor-not-registered');
    const p = [...r.pending, ...r.pendingReleases, ...r.pendingRevokes].find((x) => x.id === pendingId);
    if (!p || p.cancelledAt || p.admittedAt || p.doneAt) throw new RegistryError('pending-not-found');
    if (!p.cancellable || r.cancelsUsed >= 1) throw new RegistryError('pending-not-cancellable');
    this._cancelApplication(r, p, now);
    r.cancelsUsed += 1;
    return { status: 'cancelled', id: p.id };
  }

  /** Single-device revoke by a live registered device. Revoking the last live
   *  terminal defers by the wait (same rule as release-to-zero). */
  async revokeDevice({ owner, actorDid, targetDid }) {
    checkDid(actorDid); checkDid(targetDid);
    const r = this._get(owner);
    if (!r) throw new RegistryError('actor-not-registered');
    const now = this.now();
    this._settle(r, now);
    if (!this._isLive(r, actorDid)) throw new RegistryError('actor-not-registered');
    const t = r.devices.get(targetDid);
    if (!t || t.revokedAt || t.released) throw new RegistryError('device-not-found');
    // Delete-on-revoke only for a live target; others keep their applications.
    for (const p of r.pending) if (p.deviceDid === targetDid && !p.admittedAt) this._cancelApplication(r, p, now);
    if (this._liveDevices(r).length === 1) {
      const id = r.nextId++;
      const effectiveAt = now + RECOVERY_WAIT_MS;
      r.pendingRevokes.push({ id, targetDid, doneAt: 0, effectiveAt, requestedAt: now,
                              cancelledAt: 0, cancelledBy: null, cancellable: r.cancelsUsed < 1 });
      return { status: 'pending', id, effectiveAt };
    }
    t.revokedAt = now;
    if (this.deviceIndex.get(targetDid) === owner) this.deviceIndex.delete(targetDid);
    return { status: 'revoked', did: targetDid, revokedAt: now };
  }

  /**
   * Batch revoke (epoch advance), signed by the bound registration key.
   * Carries the same wait as registration; on effect it revokes only
   * existing-device terminals (seed-registered devices are exempt).
   */
  async requestBatchRevoke({ owner, registrationDid }) {
    checkDid(registrationDid);
    checkOwnerBinding(owner, registrationDid);
    const r = this._get(owner);
    if (!r) throw new RegistryError('registration-key-mismatch');
    const now = this.now();
    this._settle(r, now);
    if (!r.registrationDid || r.registrationDid !== registrationDid) throw new RegistryError('registration-key-mismatch');
    if (r.batchTimes.length >= MAX_BATCH_REVOKES_PER_DAY) throw new RegistryError('batch-revoke-rate');
    r.batchTimes.push(now);
    const id = r.nextId++;
    const effectiveAt = now + RECOVERY_WAIT_MS;
    r.batchRevokes.push({ id, appliedAt: 0, effectiveAt, requestedAt: now });
    return { status: 'pending', id, effectiveAt };
  }

  /** Release a device from this owner (registration-key signed; seed migration).
   *  Releasing the last live terminal defers by the wait (same rule as revoke-to-zero). */
  async releaseDevice({ owner, deviceDid, registrationDid }) {
    checkDid(deviceDid); checkDid(registrationDid);
    checkOwnerBinding(owner, registrationDid);
    const r = this._get(owner);
    if (!r) throw new RegistryError('registration-key-mismatch');
    const now = this.now();
    this._settle(r, now);
    if (!r.registrationDid || r.registrationDid !== registrationDid) throw new RegistryError('registration-key-mismatch');
    if (!r.devices.has(deviceDid)) throw new RegistryError('device-not-found');
    for (const p of [...r.pending]) if (p.deviceDid === deviceDid && !p.admittedAt) this._cancelApplication(r, p, now);
    if (this._liveDevices(r).length === 1 && !r.devices.get(deviceDid).revokedAt) {
      const id = r.nextId++;
      const effectiveAt = now + RECOVERY_WAIT_MS;
      r.pendingReleases.push({ id, deviceDid, doneAt: 0, effectiveAt, requestedAt: now,
                               cancelledAt: 0, cancelledBy: null, cancellable: r.cancelsUsed < 1 });
      return { status: 'pending', id, effectiveAt };
    }
    // Immediate release keeps a tombstone so revocation state survives.
    const d = r.devices.get(deviceDid);
    d.released = true; d.releasedAt = now;
    if (this.deviceIndex.get(deviceDid) === owner) this.deviceIndex.delete(deviceDid);
    return { status: 'released', did: deviceDid };
  }

  /** Capacity pre-check + reservation for a pack PUT: call before storing
   *  bytes. The reservation expires (120 s) and is refunded on failure or
   *  converted at record time, so races cannot overshoot the cap. */
  async checkPackCapacity({ owner, sha256, size }) {
    checkSha(sha256);
    const r = this._get(owner);
    if (!r) return { status: 'ok' };
    const now = this.now();
    this._settle(r, now);
    if (r.packs.has(sha256) || r.reservations.has(sha256)) return { status: 'ok' };
    let count = r.packs.size + r.reservations.size;
    let total = size;
    for (const p of r.packs.values()) total += p.size;
    for (const rv of r.reservations.values()) total += rv.size;
    if (count >= MAX_PACKS_PER_OWNER) throw new RegistryError('pack-count-cap');
    if (total > MAX_PACK_BYTES_PER_OWNER) throw new RegistryError('pack-bytes-cap');
    r.reservations.set(sha256, { size, expiresAt: now + 120_000 });
    return { status: 'ok' };
  }

  /** Refund a capacity reservation (PUT failed after reserving). */
  async releaseCapacity({ owner, sha256 }) {
    const r = this._get(owner);
    if (r) r.reservations.delete(sha256);
    return { status: 'released' };
  }

  /** Create the pack record. Called only after bytes + readback verify. */
  async recordPack({ owner, deviceDid, sha256, size }) {
    checkDid(deviceDid); checkSha(sha256);
    const existingRec = this._get(owner);
    if (!existingRec || !this._isLive(existingRec, deviceDid)) throw new RegistryError('device-not-registered');
    const r = existingRec;
    const existing = r.packs.get(sha256);
    if (existing) {
      if (existing.size !== size) throw new RegistryError('pack-size-mismatch');
      return { status: 'repeated' };
    }
    // Recount with reservations when this pack has none (or only expired ones).
    const own = r.reservations.get(sha256);
    const reserved = own && own.expiresAt > this.now() ? own : null;
    if (r.packs.size + r.reservations.size - (reserved ? 1 : 0) >= MAX_PACKS_PER_OWNER) throw new RegistryError('pack-count-cap');
    let total = size;
    for (const p of r.packs.values()) total += p.size;
    for (const [h, rv] of r.reservations) if (h !== sha256) total += rv.size;
    if (total > MAX_PACK_BYTES_PER_OWNER) throw new RegistryError('pack-bytes-cap');
    r.reservations.delete(sha256); // the reservation converts to the record
    r.packs.set(sha256, { sha256, size, deviceDid, createdAt: this.now() });
    return { status: 'recorded' };
  }

  /** The owner this live device is registered for, via the index (no scan). */
  async ownerOfDevice(deviceDid) {
    checkDid(deviceDid);
    const owner = this.deviceIndex.get(deviceDid);
    if (!owner) return null;
    const r = this._get(owner);
    return r && this._isLive(r, deviceDid) ? owner : null;
  }

  /** Fetch check at request time: live device + pack record for its owner. */
  async canFetch({ deviceDid, sha256 }) {
    checkSha(sha256);
    const owner = await this.ownerOfDevice(deviceDid);
    if (!owner) return null;
    const r = this._get(owner);
    const pack = r?.packs.get(sha256);
    return pack ? { owner, pack } : null;
  }

  /** Publish a head at the next sequence; stale sequences are rollback. */
  async publishHead({ owner, deviceDid, seq, headSha, headNameHex }) {
    checkDid(deviceDid); checkSha(headSha); checkSha(headNameHex);
    if (!Number.isInteger(seq) || seq < 1) throw new RegistryError('bad-head-seq');
    const r = this._get(owner);
    if (!r) throw new RegistryError('device-not-registered');
    const now = this.now();
    this._settle(r, now);
    if (!this._isLive(r, deviceDid)) throw new RegistryError('device-not-registered');
    if (r.headName && r.headName !== headNameHex) throw new RegistryError('head-name-mismatch');
    if (r.headTimes.length >= MAX_HEAD_PUBLISHES_PER_HOUR) throw new RegistryError('head-rate');
    if (seq < r.headSeq) throw new RegistryError('head-seq-rollback');
    if (seq === r.headSeq && r.headSha) {
      if (r.headSha === headSha) return { status: 'repeated', seq };
      throw new RegistryError('head-seq-conflict');
    }
    if (seq > r.headSeq + 1) throw new RegistryError('head-seq-not-allocated');
    r.headTimes.push(now);
    r.headSeq = seq; r.headSha = headSha; r.headName = headNameHex;
    return { status: 'published', seq };
  }

  /** Current head for a live device (head read path). No record created. */
  async getHead({ owner }) {
    const r = this._get(owner);
    if (!r || !r.headSha) return null;
    return { seq: r.headSeq, headSha: r.headSha, headName: r.headName };
  }

  /** Readback status for one (owner, sha256) pair (internal; not HTTP-exposed). */
  async packStatus({ owner, sha256 }) {
    checkSha(sha256);
    const r = this._get(owner);
    if (!r) return { owner, epoch: 0, pack: null, devices: [] };
    this._settle(r, this.now());
    const pack = r.packs.get(sha256);
    return { owner, epoch: r.epoch, pack: pack ? { ...pack } : null,
             devices: this._liveDevices(r).map((d) => d.did) };
  }
}

/**
 * Durable Object design (design §3): one OwnerRegistryDO per owner pseudonym
 * plus one global DeviceIndexDO (deviceDid -> owner). These classes are the
 * documented shape for a future wiring step; they are NOT exported from the
 * Worker entry and no binding exists yet, so nothing is created by shipping
 * them. MemoryRegistry above implements the same interface for tests.
 */
export class OwnerRegistryDO {
  constructor(state) { this.state = state; }
  static idFromOwner(owner) { checkOwner(owner); return owner; }
  async fetch() { return new Response(JSON.stringify({ error: 'registry-not-wired' }), { status: 503 }); }
}
export class DeviceIndexDO {
  constructor(state) { this.state = state; }
  static id() { return 'device-index'; }
  async fetch() { return new Response(JSON.stringify({ error: 'registry-not-wired' }), { status: 503 }); }
}
