// Owner registration table for owner-scoped E2EE packs (design §3).
//
// One table per owner pseudonym, single writer, monotone revocation. The
// production shape is one Durable Object instance per owner (SQLite storage);
// this module implements the same interface in memory so the HTTP layer and
// its tests run with fake storage only. No Durable Object is created here
// and no binding is wired in wrangler.jsonc (pending approval):
// with no registry configured the HTTP layer answers 503, never open.
//
// Rules implemented here (design §0, §3–§5):
// - A pack record is created only after bytes + readback verify (the HTTP
//   layer enforces the order; this table only records).
// - revokedAt is set once and never cleared; epoch only increases.
// - Registration wait: 3 days (provisional) while a non-revoked device
//   remains for the owner; the wait always ends.
// - Cancel: a registered, non-revoked device may cancel a pending registration
//   once per owner; a second application is not cancellable. A later
//   seed-signed registration supersedes a cancellation (seed wins).
// - Batch revoke (epoch advance) carries the same wait as registration.
//   Single-device revoke by a registered device is immediate.
// - Head ordering: the table allocates headSeq atomically; publish requires
//   the allocated sequence (stale sequences rejected, same-hash retry ok).
// - Every GET reads the table at request time: revocation takes effect for
//   the next request, not after a cache window.

export const RECOVERY_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

export class RegistryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const OWNER_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;

function checkOwner(owner) { if (!OWNER_RE.test(String(owner ?? ''))) throw new RegistryError('bad-owner'); }
function checkSha(sha) { if (!SHA_RE.test(String(sha ?? ''))) throw new RegistryError('bad-sha256'); }
function checkDid(did) { if (!DID_RE.test(String(did ?? ''))) throw new RegistryError('bad-device-did'); }

export class MemoryRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.owners = new Map();
  }

  _rec(owner) {
    checkOwner(owner);
    let r = this.owners.get(owner);
    if (!r) {
      r = { owner, devices: new Map(), packs: new Map(), pending: [], batchRevokes: [],
            headSeq: 0, headSha: null, epoch: 0, registrationDid: null, cancelsUsed: 0, nextId: 1 };
      this.owners.set(owner, r);
    }
    return r;
  }

  _liveDevices(r) { return [...r.devices.values()].filter((d) => !d.revokedAt); }

  /** Promote pendings whose wait has elapsed; apply effective batch revokes. */
  _settle(r, now) {
    for (const p of r.pending) {
      if (!p.cancelledAt && p.admitAt <= now) {
        p.admittedAt = now;
        if (!r.devices.has(p.deviceDid)) {
          r.devices.set(p.deviceDid, { did: p.deviceDid, approvedBy: p.approverDid, kind: p.kind,
                                       approvedAt: now, revokedAt: 0 });
        }
      }
    }
    for (const b of r.batchRevokes) {
      if (!b.appliedAt && b.effectiveAt <= now) {
        b.appliedAt = now;
        r.epoch += 1;
        for (const d of r.devices.values()) if (!d.revokedAt && d.did !== b.exemptDid) d.revokedAt = now;
      }
    }
  }

  _isLive(r, did) {
    this._settle(r, this.now());
    const d = r.devices.get(did);
    return d && !d.revokedAt ? d : null;
  }

  /**
   * Apply a registration. kind 'seed': approverDid must be the bound
   * registrationDid (first seed registration binds it). kind
   * 'existing-device': approverDid must be a live registered device.
   * -> { status: 'admitted' } | { status: 'pending', id, admitAt }
   */
  async applyRegistration({ owner, deviceDid, approverDid, kind }) {
    checkDid(deviceDid); checkDid(approverDid);
    const r = this._rec(owner); const now = this.now();
    this._settle(r, now);
    if (r.devices.has(deviceDid) && !r.devices.get(deviceDid).revokedAt) return { status: 'admitted', repeated: true };
    if (kind === 'seed') {
      if (r.registrationDid && r.registrationDid !== approverDid) throw new RegistryError('registration-key-mismatch');
      r.registrationDid = approverDid;
    } else if (kind === 'existing-device') {
      if (!this._isLive(r, approverDid)) throw new RegistryError('approver-not-registered');
    } else throw new RegistryError('bad-registration-kind');
    const live = this._liveDevices(r);
    // The wait applies while a non-revoked device remains; it always ends.
    if (live.length === 0) {
      r.devices.set(deviceDid, { did: deviceDid, approvedBy: approverDid, kind, approvedAt: now, revokedAt: 0 });
      return { status: 'admitted', repeated: false };
    }
    // Seed ultimately wins: a seed-signed application supersedes any cancelled
    // or pending state for this owner and is never cancellable a second time.
    const id = r.nextId++;
    const admitAt = now + RECOVERY_WAIT_MS;
    r.pending.push({ id, deviceDid, approverDid, kind, appliedAt: now, admitAt,
                     cancelledAt: 0, cancelledBy: null, cancellable: r.cancelsUsed < 1 });
    return { status: 'pending', id, admitAt };
  }

  /** Cancel a pending registration. Actor must be a live registered device; once per owner. */
  async cancelPending({ owner, actorDid, pendingId }) {
    checkDid(actorDid);
    const r = this._rec(owner); const now = this.now();
    this._settle(r, now);
    if (!this._isLive(r, actorDid)) throw new RegistryError('actor-not-registered');
    const p = r.pending.find((x) => x.id === pendingId);
    if (!p || p.cancelledAt || p.admittedAt) throw new RegistryError('pending-not-found');
    if (!p.cancellable || r.cancelsUsed >= 1) throw new RegistryError('pending-not-cancellable');
    p.cancelledAt = now; p.cancelledBy = actorDid; r.cancelsUsed += 1;
    return { status: 'cancelled', id: p.id };
  }

  /** Single-device revoke by a live registered device: immediate (registry read). */
  async revokeDevice({ owner, actorDid, targetDid }) {
    checkDid(actorDid); checkDid(targetDid);
    const r = this._rec(owner); const now = this.now();
    this._settle(r, now);
    if (!this._isLive(r, actorDid)) throw new RegistryError('actor-not-registered');
    const t = r.devices.get(targetDid);
    if (!t || t.revokedAt) throw new RegistryError('device-not-found');
    t.revokedAt = now;
    return { status: 'revoked', did: targetDid, revokedAt: now };
  }

  /**
   * Batch revoke (epoch advance), signed by the bound registration key.
   * Carries the same wait as registration (design §0.1): it becomes effective
   * RECOVERY_WAIT_MS later, killing only that epoch's devices, never the
   * registration key itself.
   */
  async requestBatchRevoke({ owner, registrationDid }) {
    checkDid(registrationDid);
    const r = this._rec(owner); const now = this.now();
    this._settle(r, now);
    if (!r.registrationDid || r.registrationDid !== registrationDid) throw new RegistryError('registration-key-mismatch');
    const id = r.nextId++;
    const effectiveAt = now + RECOVERY_WAIT_MS;
    r.batchRevokes.push({ id, appliedAt: 0, effectiveAt, requestedAt: now });
    return { status: 'pending', id, effectiveAt };
  }

  /** Create the pack record. Called only after bytes + readback verify. */
  async recordPack({ owner, deviceDid, sha256, size }) {
    checkDid(deviceDid); checkSha(sha256);
    const r = this._rec(owner);
    if (!this._isLive(r, deviceDid)) throw new RegistryError('device-not-registered');
    const existing = r.packs.get(sha256);
    if (existing) {
      if (existing.size !== size) throw new RegistryError('pack-size-mismatch');
      return { status: 'repeated' };
    }
    r.packs.set(sha256, { sha256, size, deviceDid, createdAt: this.now() });
    return { status: 'recorded' };
  }

  /** The owner this device is registered for, or null (revoked devices: null). */
  async ownerOfDevice(deviceDid) {
    checkDid(deviceDid);
    for (const r of this.owners.values()) {
      if (this._isLive(r, deviceDid)) return r.owner;
    }
    return null;
  }

  /** Fetch check at request time: live device + pack record for its owner. */
  async canFetch({ deviceDid, sha256 }) {
    checkSha(sha256);
    const owner = await this.ownerOfDevice(deviceDid);
    if (!owner) return null;
    const r = this._rec(owner);
    const pack = r.packs.get(sha256);
    return pack ? { owner, pack } : null;
  }

  /** Publish a head at the next sequence; stale sequences are rollback. */
  async publishHead({ owner, deviceDid, seq, headSha }) {
    checkDid(deviceDid); checkSha(headSha);
    if (!Number.isInteger(seq) || seq < 1) throw new RegistryError('bad-head-seq');
    const r = this._rec(owner);
    if (!this._isLive(r, deviceDid)) throw new RegistryError('device-not-registered');
    if (seq < r.headSeq) throw new RegistryError('head-seq-rollback');
    if (seq === r.headSeq && r.headSha) {
      if (r.headSha === headSha) return { status: 'repeated', seq };
      throw new RegistryError('head-seq-conflict');
    }
    if (seq > r.headSeq + 1) throw new RegistryError('head-seq-not-allocated');
    r.headSeq = seq; r.headSha = headSha;
    return { status: 'published', seq };
  }

  /** Readback status for one (owner, sha256) pair (deletion/retention proof surface). */
  async packStatus({ owner, sha256 }) {
    checkSha(sha256);
    const r = this._rec(owner);
    this._settle(r, this.now());
    const pack = r.packs.get(sha256);
    return { owner, epoch: r.epoch, pack: pack ? { ...pack } : null,
             devices: this._liveDevices(r).map((d) => d.did) };
  }
}

/**
 * Durable Object design (design §3): one instance per owner pseudonym.
 * This class is the documented shape for a future wiring step; it is NOT
 * exported from the Worker entry and no binding exists yet, so nothing is
 * created by shipping it. The MemoryRegistry above implements the same
 * interface for tests and for the pre-binding HTTP layer.
 */
export class OwnerRegistryDO {
  constructor(state) { this.state = state; }
  static idFromOwner(owner) { checkOwner(owner); return owner; }
  async fetch() { return new Response(JSON.stringify({ error: 'registry-not-wired' }), { status: 503 }); }
}
