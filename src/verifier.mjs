// The retention verifier, minimal form (docs/retention-design.md §6 and §8, AWAI-3671).
//
// One run takes a lease, the storage receipts offered as evidence and a probe of the operator's
// archive bucket, and produces a signed YataverseRetentionStatus plus the evidence record its
// evidenceRoot commits to. It decides nothing about provider nodes: their proofs (design §7) are
// not implemented, so provider replicas are always counted as 0 and a lease of grade R2 or R3 is
// reported as degraded.
//
// The verifier must run as a different principal, process and key from the gateway and from any
// provider (ADR 0041 D2). This module does not publish anything and holds no state.
import crypto from 'node:crypto';
import { encodeDagCbor } from './dag-cbor.mjs';
import { cidFor, cidFromBytes, cidToBytes, CODEC_DAG_CBOR } from './cid.mjs';
import { verifyReceipt, envelopeToDagCbor, KIND, STORE_CLASS, ReceiptError } from './receipt.mjs';
import {
  checkLease, verifyLease, signStatus, gradeSatisfied, inventoryRecord, receiptCountsFor,
  GRADE, STATUS, STATUS_MAX_VALIDITY_PERIODS, RetentionError,
} from './retention.mjs';

export class VerifierError extends Error { constructor(code) { super(code); this.code = code; } }
const bad = (code) => { throw new VerifierError(code); };

const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const STATUS_NAMES = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())]));
export const statusName = (v) => STATUS_NAMES[v] ?? `unknown-${v}`;

/**
 * The blocks a lease covers, as CID strings. A single-block lease names its block in `subject`;
 * any other lease needs the inventory whose commitment is the subject.
 */
export function blocksOf(lease, inventory) {
  if (inventory !== undefined) {
    if (!sameBytes(inventoryRecord(inventory).commitment, lease.subject)) bad('inventory-does-not-match-lease-subject');
    return [...new Set(inventory)].sort();
  }
  const cid = cidFromBytes(lease.subject);
  if (!cid) bad('inventory-required');
  return [cid];
}

/**
 * Check one block in the operator's archive (design §8). `probe.head(cid)` answers
 * null | { size, lockMode, retainUntil (Unix ms or null) }; `probe.read(cid)` the full bytes.
 * With `versionId` (the version the locking write returned) that exact version is checked; without
 * it the newest version of the name is, which a later unlocked write or a hide marker can mask.
 * -> { ok, reason, size, lockMode, retainUntil, read, version }. Never throws for a failing store.
 */
export async function checkArchiveCopy(probe, cid, receipt, lease, { sampleRead = false, versionId } = {}) {
  const out = { ok: false, reason: '', size: 0, lockMode: '', retainUntil: 0, read: false, version: versionId ?? '' };
  const at = versionId === undefined ? {} : { versionId };
  let head;
  try { head = await probe.head(cid, at); } catch (e) { out.reason = `probe-failed:${String(e?.code ?? e?.message ?? e).slice(0, 80)}`; return out; }
  if (!head) { out.reason = 'object-missing'; return out; }
  out.size = Number.isSafeInteger(head.size) ? head.size : 0;
  out.lockMode = typeof head.lockMode === 'string' ? head.lockMode : '';
  out.retainUntil = Number.isSafeInteger(head.retainUntil) ? head.retainUntil : 0;
  if (head.size !== receipt.size) { out.reason = 'size-mismatch'; return out; }
  // Owner decision 2026-11-21 (design §13, decision 2): compliance mode, which the operator cannot lift.
  if (!out.lockMode) { out.reason = 'not-locked'; return out; }
  if (out.lockMode !== 'COMPLIANCE') { out.reason = 'lock-is-not-compliance-mode'; return out; }
  if (!(out.retainUntil >= lease.retentionUntil)) { out.reason = 'lock-ends-before-the-lease'; return out; }
  if (sampleRead) {
    let bytes;
    try { bytes = await probe.read(cid, at); } catch (e) { out.reason = `read-failed:${String(e?.code ?? e?.message ?? e).slice(0, 80)}`; return out; }
    if (!(bytes instanceof Uint8Array) || bytes.length !== receipt.size || !sameBytes(sha256(bytes), receipt.contentDigest)) { out.reason = 'content-mismatch'; return out; }
    out.read = true;
  }
  out.ok = true;
  return out;
}

/**
 * One verifier run. Verifies the lease and every receipt, checks the archive copy of each block,
 * decides the status and signs it.
 *
 *   leaseEnv     lease envelope (both signatures)
 *   receiptEnvs  storage receipt envelopes offered as evidence
 *   keys         published key set (receipt keys and the verifier key)
 *   probe        archive probe, or null when there is no operator archive to look at
 *   signer       the verifier's signing key (importSigningKey); must be the lease's verifier
 *   keyEpoch     the verifier key's published epoch
 *   now          Unix ms
 *   versions     { [cid]: versionId } from the locking writes' responses (optional)
 *
 * -> { status (signed envelope), evidence: { bytes, cid, root }, summary }.
 * Throws when the lease is not valid or the signer is not its verifier: then no status exists.
 */
export async function runVerifierOnce({ leaseEnv, receiptEnvs = [], keys, probe = null, signer, keyEpoch, now, inventory, sampleRead = false, versions = {} }) {
  if (!Number.isSafeInteger(now)) bad('now-required');
  if (!Number.isSafeInteger(keyEpoch)) bad('key-epoch-required');
  let lease;
  try { lease = await verifyLease(leaseEnv, keys); } catch (e) { if (e instanceof RetentionError) bad(`lease-${e.code}`); throw e; }
  if (!sameBytes(lease.verifier, signer.keyId)) bad('signer-is-not-the-lease-verifier');
  const blocks = blocksOf(lease, inventory);
  const notes = [];

  // 1. Receipts: signature, key and store-class rules, then whether each counts for this lease.
  const archiveByBlock = new Map();          // cid -> verified operator-archive receipt
  const receiptCids = [];
  let providerReceipts = 0;
  for (let i = 0; i < receiptEnvs.length; i++) {
    let r, kind;
    try {
      r = await verifyReceipt(receiptEnvs[i], keys);
      kind = receiptCountsFor(r, lease);
    } catch (e) {
      if (e instanceof ReceiptError || e instanceof RetentionError) { notes.push(`receipt ${i} not counted: ${e.code}`); continue; }
      throw e;
    }
    if (r.kind !== KIND.block) { notes.push(`receipt ${i} not counted: not-a-block-receipt`); continue; }
    const cid = cidFromBytes(r.subject);
    if (!cid || !blocks.includes(cid)) { notes.push(`receipt ${i} not counted: block-not-in-lease`); continue; }
    receiptCids.push(envelopeToDagCbor(receiptEnvs[i]).cid);
    if (kind === 'operator-archive') { if (!archiveByBlock.has(cid)) archiveByBlock.set(cid, r); }
    else providerReceipts += 1;
  }
  if (providerReceipts > 0 || lease.grade !== GRADE.R1) notes.push('provider replicas counted as 0: provider proofs are not implemented in this verifier');

  // 2. The operator's archive: every block needs a counted receipt and a passing check.
  const checks = [];
  let archiveOk = blocks.length > 0, archivedBytes = 0;
  for (const cid of blocks) {
    const r = archiveByBlock.get(cid);
    let c;
    const blank = { ok: false, size: 0, lockMode: '', retainUntil: 0, read: false, version: versions[cid] ?? '' };
    if (!r) c = { ...blank, reason: 'no-operator-archive-receipt' };
    else if (!probe) c = { ...blank, reason: 'no-archive-probe' };
    else c = await checkArchiveCopy(probe, cid, r, lease, { sampleRead, versionId: versions[cid] });
    if (c.ok) archivedBytes += r.size; else archiveOk = false;
    checks.push({ block: { cid: cidToBytes(cid) }, class: 'operator-archive', ...c });
  }
  if (archiveOk && archivedBytes !== lease.size) { archiveOk = false; notes.push('archived bytes do not add up to the lease size'); }
  const counts = { providerReplicas: 0, operatorCopies: archiveOk ? 1 : 0 };

  // 3. The status.
  let status;
  if (now >= lease.retentionUntil) status = STATUS.expired;
  else if (now < lease.notBefore) { status = STATUS.degraded; notes.push('the lease has not started'); }
  else status = gradeSatisfied(lease, counts) ? STATUS.policySatisfied : STATUS.degraded;

  // 4. The evidence record, and the signed status that commits to it.
  const evidenceBytes = encodeDagCbor({ v: 1, leaseId: lease.leaseId, observedAt: now,
    receipts: [...new Set(receiptCids)].sort().map((c) => ({ cid: cidToBytes(c) })), checks, notes });
  const root = sha256(evidenceBytes);
  let validUntil = now + STATUS_MAX_VALIDITY_PERIODS * lease.challengePeriod * 1000;
  // A "satisfied" record must not outlive the term it speaks about.
  if (status === STATUS.policySatisfied) validUntil = Math.min(validUntil, lease.retentionUntil);
  const env = await signStatus({ leaseId: lease.leaseId, subject: lease.subject, grade: lease.grade, status,
    providerReplicas: counts.providerReplicas, operatorCopies: counts.operatorCopies, evidenceRoot: root,
    observedAt: now, validUntil, keyId: signer.keyId, keyEpoch }, signer);
  return {
    status: env,
    evidence: { bytes: evidenceBytes, cid: cidFor(evidenceBytes, CODEC_DAG_CBOR), root },
    summary: { status: statusName(status), grade: lease.grade, ...counts, blocks: blocks.length,
               checks: checks.map((c, i) => ({ block: blocks[i], ok: c.ok, reason: c.reason, read: c.read, version: c.version })), notes },
  };
}

export { STORE_CLASS };
