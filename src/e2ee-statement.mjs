// Canonical signed statements for owner-scoped E2EE registry operations.
//
// One length-prefixed encoding for every mutating op (register, cancel,
// revoke, batch-revoke, release), so a signature for one op/service can never
// be reused as another: the encoding binds domain, audience, version, op,
// owner, actor, all op arguments, the validity window and the registry epoch.
// The server rebuilds the statement from the submitted fields (never parses
// it), so separator ambiguity with DIDs or arguments cannot arise.
import crypto from 'node:crypto';

export const STATEMENT_VERSION = 'yataverse:e2ee:v2';
export const STATEMENT_WINDOW_MS = 300_000;

/** Length-prefixed canonical form: `<byteLen>:<value>` per field, concatenated. */
export function canonicalStatement({ domain, aud, op, owner, actorDid, args = [], issuedAt, expiresAt, epoch }) {
  const fields = [STATEMENT_VERSION, String(domain), String(aud), String(op), String(owner), String(actorDid),
    ...args.map(String), String(issuedAt), String(expiresAt), String(epoch)];
  return fields.map((f) => { const b = Buffer.from(f, 'utf8'); return `${b.length}:${b.toString('utf8')}`; }).join('');
}

/** Sign a statement with a keyFromSeed() key object -> { fields, signature }. */
export function signStatement(key, fields) {
  const canonical = canonicalStatement(fields);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), key.privateKey).toString('base64url');
  return { fields, signature };
}

/** Verify a base64url Ed25519 signature over the canonical statement. pub = raw 32 B. */
export function verifyStatement(pubRaw, fields, signature) {
  if (!pubRaw || pubRaw.length !== 32 || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const sig = Buffer.from(signature, 'base64url');
  if (sig.length !== 64 || sig.toString('base64url') !== signature) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubRaw)]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonicalStatement(fields), 'utf8'), key, sig);
  } catch { return false; }
}
