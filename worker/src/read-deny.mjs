// Read deny list (AWAI-3629): CIDs that must not be served publicly, for example because their
// redistribution needs a licence the operator does not hold.
//
// READ_DENY_CIDS is a comma-separated list of CIDs. Entries are compared by multihash, so a
// CIDv0 (Qm...) and every CIDv1 spelling or codec of the same sha2-256 digest are the same
// entry. A denied CID is answered with 451 on every public read path (GET/HEAD /ipfs/<cid>,
// CAR export as root or anywhere in the DAG, files on a name host) before B2 or
// READ_FALLBACK_URL is asked. Writes are not affected: B2 keeps the object.
//
// An entry that is not a supported CID makes the list invalid, and every public read then fails
// closed with 503 read-deny-list-invalid: a typo must never leave the intended CID readable.
// Empty or unset: nothing is denied.
import { parseCid, SHA2_256 } from '../../src/cid.mjs';

export const DENIED_ERROR = 'unavailable-for-legal-reasons';
export const DENY_INVALID_ERROR = 'read-deny-list-invalid';
/** Response header on a write whose block (or a block in whose CAR) is read-denied. */
export const READ_DENIED_HEADER = 'yataverse-read-denied';

const multihashOf = (cid) => {
  const p = parseCid(String(cid));
  if (!p || p.hashCode !== SHA2_256) return null;
  return `1220${Buffer.from(p.digest).toString('hex')}`;
};

const parsed = new Map(); // raw var -> { set } | { invalid: [entries] }

/** -> { set: Set<multihash hex> } or { invalid: [entries that are not CIDs] }. */
export function readDenyList(env) {
  const raw = String(env?.READ_DENY_CIDS ?? '');
  const hit = parsed.get(raw);
  if (hit) return hit;
  const set = new Set(); const invalid = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const mh = multihashOf(entry);
    if (mh) set.add(mh); else invalid.push(entry);
  }
  const value = invalid.length ? { invalid } : { set };
  if (parsed.size > 8) parsed.clear();
  parsed.set(raw, value);
  return value;
}

/**
 * null when `cid` may be read; otherwise the [status, error] to answer with:
 * [451, unavailable-for-legal-reasons] for a denied CID, [503, read-deny-list-invalid] when the
 * list cannot be parsed.
 */
export function readDenied(cid, env) {
  const list = readDenyList(env);
  if (list.invalid) return [503, DENY_INVALID_ERROR];
  if (!list.set.size) return null;
  const mh = multihashOf(cid);
  return mh && list.set.has(mh) ? [451, DENIED_ERROR] : null;
}

/** true when the list is non-empty (or invalid): callers may skip extra checks otherwise. */
export function readDenyActive(env) {
  const list = readDenyList(env);
  return Boolean(list.invalid || list.set.size);
}

/** Headers for a deny answer: never cached by Cloudflare or a browser. */
export const DENY_HEADERS = { 'cache-control': 'no-store' };
