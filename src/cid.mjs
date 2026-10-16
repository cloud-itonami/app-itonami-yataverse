// CIDv1 helpers. yataverse names a block by the sha2-256 of its bytes, so a reader can
// always re-derive the address and refuse anything that does not match.
import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const CODEC_RAW = 0x55;
export const CODEC_DAG_PB = 0x70;
export const CODEC_DAG_CBOR = 0x71;
export const SHA2_256 = 0x12;

function decodeVarint(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 9; i++) {
    const index = offset + i;
    if (index >= bytes.length) return null;
    const byte = bytes[index];
    value |= BigInt(byte & 0x7f) << BigInt(i * 7);
    if ((byte & 0x80) === 0) {
      // Multiformats unsigned varints must use their shortest representation.
      if (i > 0 && byte === 0) return null;
      return { value, nextOffset: index + 1 };
    }
  }
  return null;
}

function encodeVarint(value) {
  let n = BigInt(value);
  if (n < 0n || n > 0x7fffffffffffffffn) throw new RangeError('varint is outside the supported unsigned 63-bit range');
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

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

/** CIDv0 (implicit dag-pb/sha2-256) or lower-case base32 CIDv1/sha2-256. */
export const CIDV0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
export const CID_PATTERN = /^(?:b[a-z2-7]{20,120}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
export const isCidShape = (cid) => typeof cid === 'string' && CID_PATTERN.test(cid);

function base58Decode(value) {
  if (typeof value !== 'string' || !CIDV0_PATTERN.test(value)) return null;
  let number = 0n;
  for (const ch of value) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
  let zeroes = 0;
  while (value[zeroes] === '1') zeroes++;
  return Buffer.concat([Buffer.alloc(zeroes), body]);
}

/** -> {version, codec, hashCode, digest} or null. */
export function parseCid(cid) {
  if (!isCidShape(cid)) return null;
  if (CIDV0_PATTERN.test(cid)) {
    const bytes = base58Decode(cid);
    if (!bytes || bytes.length !== 34 || bytes[0] !== SHA2_256 || bytes[1] !== 32) return null;
    return { version: 0, codec: CODEC_DAG_PB, hashCode: SHA2_256, digest: bytes.subarray(2) };
  }
  const bytes = base32Decode(cid.slice(1));
  if (!bytes || bytes.length < 4 + 32) return null;
  // Reject base32 aliases with non-zero residual padding bits. CID text is
  // used in deterministic DIDs and manifests, so each byte string needs one
  // canonical spelling.
  if (`b${base32(bytes)}` !== cid) return null;
  const version = decodeVarint(bytes, 0);
  if (!version || version.value !== 1n) return null;
  const codec = decodeVarint(bytes, version.nextOffset);
  if (!codec || codec.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const hashCode = decodeVarint(bytes, codec.nextOffset);
  if (!hashCode || hashCode.value !== BigInt(SHA2_256)) return null;
  const length = decodeVarint(bytes, hashCode.nextOffset);
  if (!length || length.value !== 32n || bytes.length - length.nextOffset !== 32) return null;
  return {
    version: 1,
    codec: Number(codec.value),
    hashCode: SHA2_256,
    digest: bytes.subarray(length.nextOffset),
  };
}

/** Normalize a supported CID to its canonical lower-case base32 CIDv1 form. */
export function normalizeCid(cid) {
  const parsed = parseCid(cid);
  if (!parsed) return null;
  if (parsed.version === 1) return cid;
  const bytes = Buffer.concat([
    encodeVarint(1),
    encodeVarint(parsed.codec),
    encodeVarint(parsed.hashCode),
    encodeVarint(parsed.digest.length),
    parsed.digest,
  ]);
  return `b${base32(bytes)}`;
}

/** true iff `bytes` hash to the digest named by `cid` (any codec; sha2-256 only). */
export function verifyBlock(cid, bytes) {
  const p = parseCid(cid);
  if (!p || p.hashCode !== SHA2_256) return false;
  return crypto.timingSafeEqual(p.digest, sha256(bytes));
}
