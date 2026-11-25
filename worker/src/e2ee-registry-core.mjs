// Sync owner-registry rules (design §1–§2). Pure synchronous state machines:
// every method takes plain data and mutates the record, or throws a
// RegistryError-compatible { code }. Device-index decisions are NOT made
// here (design §2.8: admission consults no index); claim generations are
// passed in by the caller (intent layer). Used by OwnerRegistryDO; the
// in-memory MemoryRegistry keeps its own (untouched) implementation and is
// the differential oracle in tests.
import { RegistryError } from './e2ee-registry.mjs';

export const RECOVERY_WAIT_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_PER_LANE = 3;
export const MAX_APPLICATIONS_PER_LANE_PER_HOUR = 10;
export const MAX_BATCH_REVOKES_PER_DAY = 1;
export const MAX_HEAD_PUBLISHES_PER_HOUR = 100;
export const MAX_PACKS_PER_OWNER = 1024;
export const MAX_PACK_BYTES_PER_OWNER = 4 * 1024 * 1024 * 1024;
export const HELD_GENS_CAP = 32;

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const OWNER_RE = /^[0-9a-f]{64}$/, SHA_RE = /^[0-9a-f]{64}$/, DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const err = (code) => { throw new RegistryError(code); };
const within = (arr, now, window) => arr.filter((t) => t > now - window);
export const checkOwner = (o) => { if (!OWNER_RE.test(String(o ?? ''))) err('bad-owner'); };
export const checkSha = (s) => { if (!SHA_RE.test(String(s ?? ''))) err('bad-sha256'); };
export const checkDid = (d) => { if (!DID_RE.test(String(d ?? ''))) err('bad-device-did'); };

export function emptyRecord(owner) {
  return { owner, devices: new Map(), packs: new Map(), pending: [], batchRevokes: [],
    pendingReleases: [], pendingRevokes: [], headSeq: 0, headSha: null, headName: null,
    epoch: 0, registrationDid: null, cancelsUsed: 0, nextId: 1, reservations: new Map(),
    appTimes: { seed: [], existing: [] }, batchTimes: [], headTimes: [] };
}

export class RegistryCore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.owners = new Map();
    this.usedStatements = new Map();
  }
  rec(owner) {
    checkOwner(owner);
    let r = this.owners.get(owner);
    if (!r) { r = emptyRecord(owner); this.owners.set(owner, r); }
    return r;
  }
  get(owner) { checkOwner(owner); return this.owners.get(owner) ?? null; }
  liveDevices(r) { return [...r.devices.values()].filter((d) => !d.revokedAt && !d.released); }

  cancelApplication(r, p, now) {
    p.cancelledAt = now;
  }
  settle(r, now) {
    const events = [];
    for (const b of r.batchRevokes) if (!b.appliedAt && b.effectiveAt <= now) events.push({ t: b.effectiveAt, pri: 0, kind: 'batch', ref: b });
    for (const p of r.pendingReleases) if (!p.cancelledAt && !p.doneAt && p.effectiveAt <= now) events.push({ t: p.effectiveAt, pri: 0, kind: 'release', ref: p });
    for (const p of r.pendingRevokes) if (!p.cancelledAt && !p.doneAt && p.effectiveAt <= now) events.push({ t: p.effectiveAt, pri: 0, kind: 'revoke', ref: p });
    for (const p of r.pending) if (!p.cancelledAt && !p.admittedAt && p.admitAt <= now) events.push({ t: p.admitAt, pri: 1, kind: 'admit', ref: p });
    events.sort((a, b) => a.t - b.t || a.pri - b.pri);
    for (const e of events) {
      if (e.kind === 'batch') {
        const b = e.ref; b.appliedAt = e.t; r.epoch += 1; r.cancelsUsed = 0;
        for (const d of r.devices.values()) {
          const appliedAt = d.appliedAt ?? d.approvedAt;
          if (!d.revokedAt && !d.released && !(d.kind === 'seed' && appliedAt >= b.requestedAt)) d.revokedAt = e.t;
        }
        for (const p of r.pending) if (!p.admittedAt && !p.cancelledAt && p.appliedAt < b.requestedAt) this.cancelApplication(r, p, e.t);
      } else if (e.kind === 'release') {
        const p = e.ref; p.doneAt = e.t;
        const d = r.devices.get(p.deviceDid);
        if (d) { d.released = true; d.releasedAt = e.t; }
        for (const q of [...r.pending]) if (q.deviceDid === p.deviceDid && !q.admittedAt) this.cancelApplication(r, q, e.t);
      } else if (e.kind === 'revoke') {
        const p = e.ref; p.doneAt = e.t;
        const d = r.devices.get(p.targetDid);
        if (d && !d.revokedAt) d.revokedAt = e.t;
      } else {
        const p = e.ref; p.admittedAt = e.t;
        const old = r.devices.get(p.deviceDid);
        if (old && !old.revokedAt && !old.released) continue;
        const killAt = Math.max(old?.revokedAt ?? 0, old?.releasedAt ?? 0);
        if (old && killAt && p.appliedAt < killAt) { this.cancelApplication(r, p, e.t); continue; }
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
  isLive(r, did) {
    this.settle(r, this.now());
    const d = r.devices.get(did);
    return d && !d.revokedAt && !d.released ? d : null;
  }
  // ---- caller-supplied claim: claimGen = {gen, seq, inc} already recorded
  // in heldGens by the caller, or null for the live fast path (no intent).
  applyRegistration({ owner, deviceDid, approverDid, kind, binding }) {
    checkDid(deviceDid); checkDid(approverDid); checkOwner(owner);
    if (kind !== 'seed' && kind !== 'existing-device') err('bad-registration-kind');
    if (kind === 'existing-device' && !this.get(owner)) err('approver-not-registered');
    const r = this.rec(owner); const now = this.now();
    this.settle(r, now);
    const existing = r.devices.get(deviceDid);
    if (kind === 'existing-device') {
      if (!this.isLive(r, approverDid)) err('approver-not-registered');
      if (r.batchRevokes.some((b) => !b.appliedAt)) err('batch-revoke-pending');
    }
    if (existing && !existing.revokedAt && !existing.released) return { status: 'admitted', repeated: true };
    if ((existing?.revokedAt || existing?.released) && kind !== 'seed') err('device-revoked-seed-only');
    const lane = kind === 'seed' ? 'seed' : 'existing';
    if (r.appTimes[lane].length >= MAX_APPLICATIONS_PER_LANE_PER_HOUR) err('registration-rate');
    if (kind === 'seed') {
      binding(owner, approverDid); // owner<->registration-key check (injected)
      if (r.registrationDid && r.registrationDid !== approverDid) err('registration-key-mismatch');
      for (const p of r.pending) if (p.deviceDid === deviceDid && !p.cancelledAt && !p.admittedAt) this.cancelApplication(r, p, now);
      const lanePending = r.pending.filter((p) => p.kind === 'seed' && !p.cancelledAt && !p.admittedAt).length;
      if (lanePending >= MAX_PENDING_PER_LANE) err('too-many-pending');
    }
    r.appTimes[lane].push(now);
    if (kind === 'existing-device') {
      r.devices.set(deviceDid, { did: deviceDid, approvedBy: approverDid, kind, approvedAt: now,
        appliedAt: now, revokedAt: 0, released: false, releasedAt: 0, generation: (existing?.generation ?? 0) + 1 });
      for (const p of r.pending) if (p.deviceDid === deviceDid && !p.admittedAt && !p.cancelledAt) this.cancelApplication(r, p, now);
      return { status: 'admitted', repeated: false };
    }
    if (this.liveDevices(r).length === 0) {
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
    if (!r.registrationDid) r.registrationDid = approverDid;
    return { status: 'pending', id, admitAt };
  }
  cancelPending({ owner, actorDid, pendingId }) {
    checkDid(actorDid);
    const r = this.get(owner);
    if (!r) err('actor-not-registered');
    const now = this.now();
    this.settle(r, now);
    if (!this.isLive(r, actorDid)) err('actor-not-registered');
    const p = [...r.pending, ...r.pendingReleases, ...r.pendingRevokes].find((x) => x.id === pendingId);
    if (!p || p.cancelledAt || p.admittedAt || p.doneAt) err('pending-not-found');
    if (!p.cancellable || r.cancelsUsed >= 1) err('pending-not-cancellable');
    this.cancelApplication(r, p, now);
    r.cancelsUsed += 1;
    return { status: 'cancelled', id: p.id };
  }
  revokeDevice({ owner, actorDid, targetDid }) {
    checkDid(actorDid); checkDid(targetDid);
    const r = this.get(owner);
    if (!r) err('actor-not-registered');
    const now = this.now();
    this.settle(r, now);
    if (!this.isLive(r, actorDid)) err('actor-not-registered');
    const t = r.devices.get(targetDid);
    if (!t || t.revokedAt || t.released) err('device-not-found');
    const dupRevoke = r.pendingRevokes.find((p) => p.targetDid === targetDid && !p.doneAt && !p.cancelledAt);
    if (dupRevoke) return { status: 'pending', id: dupRevoke.id, effectiveAt: dupRevoke.effectiveAt };
    for (const p of r.pending) if (p.deviceDid === targetDid && !p.admittedAt) this.cancelApplication(r, p, now);
    if (this.liveDevices(r).length === 1) {
      const id = r.nextId++;
      const effectiveAt = now + RECOVERY_WAIT_MS;
      r.pendingRevokes.push({ id, targetDid, doneAt: 0, effectiveAt, requestedAt: now,
                              cancelledAt: 0, cancelledBy: null, cancellable: r.cancelsUsed < 1 });
      return { status: 'pending', id, effectiveAt };
    }
    t.revokedAt = now;
    return { status: 'revoked', did: targetDid, revokedAt: now };
  }
  requestBatchRevoke({ owner, registrationDid }) {
    checkDid(registrationDid);
    const r = this.get(owner);
    if (!r) err('registration-key-mismatch');
    const now = this.now();
    this.settle(r, now);
    if (!r.registrationDid || r.registrationDid !== registrationDid) err('registration-key-mismatch');
    if (r.batchTimes.length >= MAX_BATCH_REVOKES_PER_DAY) err('batch-revoke-rate');
    r.batchTimes.push(now);
    const id = r.nextId++;
    const effectiveAt = now + RECOVERY_WAIT_MS;
    r.batchRevokes.push({ id, appliedAt: 0, effectiveAt, requestedAt: now });
    return { status: 'pending', id, effectiveAt };
  }
  releaseDevice({ owner, deviceDid, registrationDid }) {
    checkDid(deviceDid); checkDid(registrationDid);
    const r = this.get(owner);
    if (!r) err('registration-key-mismatch');
    const now = this.now();
    this.settle(r, now);
    if (!r.registrationDid || r.registrationDid !== registrationDid) err('registration-key-mismatch');
    if (!r.devices.has(deviceDid)) err('device-not-found');
    const cur = r.devices.get(deviceDid);
    if (cur.released) return { status: 'already-released', did: deviceDid };
    const dupRelease = r.pendingReleases.find((p) => p.deviceDid === deviceDid && !p.doneAt && !p.cancelledAt);
    if (dupRelease) return { status: 'pending', id: dupRelease.id, effectiveAt: dupRelease.effectiveAt };
    for (const p of [...r.pending]) if (p.deviceDid === deviceDid && !p.admittedAt) this.cancelApplication(r, p, now);
    if (this.liveDevices(r).length === 1 && !r.devices.get(deviceDid).revokedAt) {
      const id = r.nextId++;
      const effectiveAt = now + RECOVERY_WAIT_MS;
      r.pendingReleases.push({ id, deviceDid, doneAt: 0, effectiveAt, requestedAt: now,
                               cancelledAt: 0, cancelledBy: null, cancellable: r.cancelsUsed < 1 });
      return { status: 'pending', id, effectiveAt };
    }
    const d = r.devices.get(deviceDid);
    d.released = true; d.releasedAt = now;
    return { status: 'released', did: deviceDid };
  }
  consumeStatement({ owner, signature, expiresAt, epoch }) {
    checkOwner(owner);
    const now = this.now();
    for (const [h, exp] of this.usedStatements) if (exp <= now) this.usedStatements.delete(h);
    const rec = this.get(owner);
    if (rec) this.settle(rec, now);
    const current = rec?.epoch ?? 0;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) err('statement-expired');
    if (epoch !== current) err('statement-stale-epoch');
    const h = String(signature);
    if (this.usedStatements.has(h)) err('statement-replayed');
    this.usedStatements.set(h, expiresAt);
    return { status: 'consumed' };
  }
  checkPackCapacity({ owner, sha256, size }) {
    checkSha(sha256);
    const r = this.get(owner);
    if (!r) return { status: 'ok' };
    const now = this.now();
    this.settle(r, now);
    if (r.packs.has(sha256) || r.reservations.has(sha256)) return { status: 'ok' };
    let count = r.packs.size + r.reservations.size;
    let total = size;
    for (const p of r.packs.values()) total += p.size;
    for (const rv of r.reservations.values()) total += rv.size;
    if (count >= MAX_PACKS_PER_OWNER) err('pack-count-cap');
    if (total > MAX_PACK_BYTES_PER_OWNER) err('pack-bytes-cap');
    r.reservations.set(sha256, { size, expiresAt: now + 120_000 });
    return { status: 'ok' };
  }
  releaseCapacity({ owner, sha256 }) {
    const r = this.get(owner);
    if (r) r.reservations.delete(sha256);
    return { status: 'released' };
  }
  recordPack({ owner, deviceDid, sha256, size }) {
    checkDid(deviceDid); checkSha(sha256);
    const rec = this.get(owner);
    if (!rec || !this.isLive(rec, deviceDid)) err('device-not-registered');
    const r = rec;
    const existing = r.packs.get(sha256);
    if (existing) {
      if (existing.size !== size) err('pack-size-mismatch');
      return { status: 'repeated' };
    }
    const own = r.reservations.get(sha256);
    const reserved = own && own.expiresAt > this.now() ? own : null;
    if (r.packs.size + r.reservations.size - (reserved ? 1 : 0) >= MAX_PACKS_PER_OWNER) err('pack-count-cap');
    let total = size;
    for (const p of r.packs.values()) total += p.size;
    for (const [h, rv] of r.reservations) if (h !== sha256) total += rv.size;
    if (total > MAX_PACK_BYTES_PER_OWNER) err('pack-bytes-cap');
    r.reservations.delete(sha256);
    r.packs.set(sha256, { sha256, size, deviceDid, createdAt: this.now() });
    return { status: 'recorded' };
  }
  publishHead({ owner, deviceDid, seq, headSha, headNameHex }) {
    checkDid(deviceDid); checkSha(headSha); checkSha(headNameHex);
    if (!Number.isInteger(seq) || seq < 1) err('bad-head-seq');
    const r = this.get(owner);
    if (!r) err('device-not-registered');
    const now = this.now();
    this.settle(r, now);
    if (!this.isLive(r, deviceDid)) err('device-not-registered');
    if (r.headName && r.headName !== headNameHex) err('head-name-mismatch');
    if (r.headTimes.length >= MAX_HEAD_PUBLISHES_PER_HOUR) err('head-rate');
    if (seq < r.headSeq) err('head-seq-rollback');
    if (seq === r.headSeq && r.headSha) {
      if (r.headSha === headSha) return { status: 'repeated', seq };
      err('head-seq-conflict');
    }
    if (seq > r.headSeq + 1) err('head-seq-not-allocated');
    r.headTimes.push(now);
    r.headSeq = seq; r.headSha = headSha; r.headName = headNameHex;
    return { status: 'published', seq };
  }
  getHead({ owner }) {
    const r = this.get(owner);
    if (!r || !r.headSha) return null;
    return { seq: r.headSeq, headSha: r.headSha, headName: r.headName };
  }
  packStatus({ owner, sha256 }) {
    checkSha(sha256);
    const r = this.get(owner);
    if (!r) return { owner, epoch: 0, pack: null, devices: [] };
    this.settle(r, this.now());
    const pack = r.packs.get(sha256);
    return { owner, epoch: r.epoch, pack: pack ? { ...pack } : null,
             devices: this.liveDevices(r).map((d) => d.did) };
  }
  epochOf({ owner }) {
    const r = this.get(owner);
    if (r) this.settle(r, this.now());
    return r?.epoch ?? 0;
  }
  registrationDidOf({ owner }) {
    const r = this.get(owner);
    if (r) this.settle(r, this.now());
    return r?.registrationDid ?? null;
  }
  isLiveDevice({ owner, did }) {
    const r = this.get(owner);
    return r ? Boolean(this.isLive(r, did)) : false;
  }
  deviceKnown({ owner, did }) {
    const r = this.get(owner);
    return Boolean(r?.devices.has(did));
  }
  pendingState({ owner, id }) {
    const r = this.get(owner);
    if (!r) return null;
    this.settle(r, this.now());
    const p = [...r.pending, ...r.pendingReleases, ...r.pendingRevokes].find((x) => x.id === id);
    if (!p || p.cancelledAt || p.admittedAt || p.doneAt) return null;
    return { cancellable: Boolean(p.cancellable) && r.cancelsUsed < 1 };
  }
  checkRegistrationRates({ owner, kind }) {
    const r = this.get(owner);
    if (!r) return { status: 'ok' };
    this.settle(r, this.now());
    const lane = kind === 'seed' ? 'seed' : 'existing';
    if (r.appTimes[lane].length >= MAX_APPLICATIONS_PER_LANE_PER_HOUR) err('registration-rate');
    if (kind === 'seed') {
      const lanePending = r.pending.filter((p) => p.kind === 'seed' && !p.cancelledAt && !p.admittedAt).length;
      if (lanePending >= MAX_PENDING_PER_LANE) err('too-many-pending');
    } else if (r.batchRevokes.some((b) => !b.appliedAt)) err('batch-revoke-pending');
    return { status: 'ok' };
  }
  checkRegisterable({ owner, deviceDid, kind }) {
    const r = this.get(owner);
    if (!r) return { status: 'ok' };
    this.settle(r, this.now());
    const existing = r.devices.get(deviceDid);
    if (existing && (existing.revokedAt || existing.released) && kind !== 'seed') err('device-revoked-seed-only');
    return { status: 'ok' };
  }
  checkBatchRate({ owner }) {
    const r = this.get(owner);
    if (!r) return { status: 'ok' };
    this.settle(r, this.now());
    if (r.batchTimes.length >= MAX_BATCH_REVOKES_PER_DAY) err('batch-revoke-rate');
    return { status: 'ok' };
  }
}
