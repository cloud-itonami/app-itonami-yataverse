// CIDv1 helpers. yataverse names a block by the sha2-256 of its bytes, so a reader can
// always re-derive the address and refuse anything that does not match.
import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const CODEC_RAW = 0x55;
export const CODEC_DAG_CBOR = 0x71;
export const SHA2_256 = 0x12;

export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest();

/** CIDv1 / raw / sha2-256, base32 lower — e.g. bafkrei... */
export function rawCid(bytes) {
  return 'b' + base32(Buffer.concat([Buffer.from([0x01, CODEC_RAW, SHA2_256, 0x20]), sha256(bytes)]));
}

/** A CID string is only ever used as a URL path segment and a filename: keep it strict. */
export const CID_PATTERN = /^b[a-z2-7]{20,120}$/;
export const isCidShape = (cid) => typeof cid === 'string' && CID_PATTERN.test(cid);

/** -> {version, codec, hashCode, digest} or null. */
export function parseCid(cid) {
  if (!isCidShape(cid)) return null;
  const bytes = base32Decode(cid.slice(1));
  if (!bytes || bytes.length < 4 + 32) return null;
  const [version, codec, hashCode, len] = bytes;
  if (version !== 1 || len !== bytes.length - 4 || len !== 32) return null;
  return { version, codec, hashCode, digest: bytes.subarray(4) };
}

/** true iff `bytes` hash to the digest named by `cid` (any codec; sha2-256 only). */
export function verifyBlock(cid, bytes) {
  const p = parseCid(cid);
  if (!p || p.hashCode !== SHA2_256) return false;
  return crypto.timingSafeEqual(p.digest, sha256(bytes));
}
