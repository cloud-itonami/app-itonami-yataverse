// Unified seed derivation for owner-scoped E2EE recovery (design §2).
//
// HKDF-SHA256 (seed as IKM, no salt, info `awai-drive/v1/<label>`) produces
// domain-separated sub-keys. The owner pseudonym is NOT an HKDF row: it is
// SHA-256("awai-drive/v1/owner" || registration public key), verifiable from
// the registration public key alone. The server never derives: it never sees
// the seed. This module is client-side.
import crypto from 'node:crypto';
import { keyFromSeed, mintDirect, e2eeGetResource } from './cacao.mjs';

export const DERIVATION_PREFIX = 'awai-drive/v1/';
export const OWNER_PREFIX = 'awai-drive/v1/owner';

/** The agreed table (Drive §3.2 verbatim labels; head is two separate labels). */
export const DERIVATION_TABLE = Object.freeze([
  { label: 'recovery-recipient', bytes: 96, use: 'KEM coins (64 B) + X25519 scalar (32 B)' },
  { label: 'device-registration', bytes: 32, use: 'Registration key (32 B)' },
  { label: 'head/name', bytes: 32, use: 'Head name (32 B)' },
  { label: 'head/sign-root', bytes: 32, use: 'Signing-root material (32 B)' },
]);

const hex = (b) => Buffer.from(b).toString('hex');

/** HKDF-SHA256(seed, info=`awai-drive/v1/<label>`, length) for one table row. */
export function deriveLabel(seed, label, bytes) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('seed must be 32 bytes');
  const row = DERIVATION_TABLE.find((r) => r.label === label);
  if (!row) throw new Error(`unknown derivation label: ${label}`);
  const len = bytes ?? row.bytes;
  return new Uint8Array(crypto.hkdfSync('sha256', Buffer.from(seed), '', DERIVATION_PREFIX + label, len));
}

/** Owner pseudonym from the registration public key: SHA-256(prefix || pubkey). */
export function ownerFromRegistrationPub(pubRaw) {
  return crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from(OWNER_PREFIX, 'utf8'), Buffer.from(pubRaw)])).digest('hex');
}

/**
 * All seed-derived values in one call. `registration` is the Ed25519 key
 * object for the registration key (its did is the approverDid a seed-signed
 * registration must present, and its public key binds the owner pseudonym).
 */
export function deriveFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('seed must be 32 bytes');
  const recoveryRecipient = deriveLabel(seed, 'recovery-recipient');
  const registrationKey = deriveLabel(seed, 'device-registration');
  const headName = deriveLabel(seed, 'head/name');
  const headSignRoot = deriveLabel(seed, 'head/sign-root');
  const registration = keyFromSeed(registrationKey);
  const owner = ownerFromRegistrationPub(registration.publicRaw);
  return {
    recoveryRecipient: {
      kemCoins: recoveryRecipient.subarray(0, 64),
      x25519Scalar: recoveryRecipient.subarray(64, 96),
    },
    registrationKey,
    registration,
    owner,
    headName,
    headNameHex: hex(headName),
    headSignRoot,
  };
}

/**
 * The unified recovery fetch credential: a per-device CACAO naming one pack.
 * The owner pseudonym never appears in the CACAO; the server maps the
 * device did to the owner through the registry.
 */
export function mintE2eeFetchCacao(deviceKey, sha256Hex, { nonce, aud, domain, now = Date.now(), ttlSec = 300 } = {}) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256Hex ?? ''))) throw new Error('sha256 must be 64 hex');
  return mintDirect(deviceKey, { aud, domain, nonce, resources: [e2eeGetResource(sha256Hex)], now, ttlSec });
}
