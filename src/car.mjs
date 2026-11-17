// CAR (Content Addressable aRchive) read and write, strict and bounded.
//   CARv1: https://ipld.io/specs/transport/car/carv1/
//   CARv2: https://ipld.io/specs/transport/car/carv2/  (read only: its inner CARv1 payload)
// The header must be canonical DAG-CBOR {roots: [link...], version: 1}. Sections are
// varint(length) || CID || block. Only CIDv1/sha2-256 sections are accepted here; every
// block is hashed against its CID by the caller (see checkWritableBlock / verifyBlock).
import { decodeDagCbor, DagCborError } from './dag-cbor.mjs';
import { cidFromBytes, cidToBytes } from './cid.mjs';

export const CAR_CONTENT_TYPE = 'application/vnd.ipld.car';
export class CarError extends Error { constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; } }
const bad = (code, detail) => { throw new CarError(code, detail); };

const CARV2_PRAGMA = Uint8Array.from([0x0a, 0xa1, 0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x02]);

function varint(n) {
  const out = []; let v = BigInt(n);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Uint8Array.from(out);
}

function readVarint(bytes, i) {
  let value = 0n;
  for (let n = 0; n < 9; n++) {
    if (i >= bytes.length) bad('car-truncated');
    const b = bytes[i++];
    value |= BigInt(b & 0x7f) << BigInt(7 * n);
    if ((b & 0x80) === 0) {
      if (n > 0 && b === 0) bad('car-varint-not-minimal');
      return [value, i];
    }
  }
  return bad('car-varint-too-long');
}

/** Length of the binary CIDv1 at bytes[i...]: version, codec, multihash code, length, digest. */
function cidLength(bytes, i) {
  const start = i; let v, len;
  [v, i] = readVarint(bytes, i);
  if (v !== 1n) bad('car-cid-not-v1');
  [, i] = readVarint(bytes, i);
  [, i] = readVarint(bytes, i);
  [len, i] = readVarint(bytes, i);
  if (BigInt(bytes.length - i) < len) bad('car-truncated');
  return i - start + Number(len);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Encode the canonical DAG-CBOR header {roots, version: 1} for CIDv1 root strings. */
function encodeHeader(roots) {
  const parts = [Uint8Array.from([0xa2, 0x65, ...new TextEncoder().encode('roots')])];
  if (roots.length > 23) bad('car-too-many-roots');
  parts.push(Uint8Array.from([0x80 | roots.length]));
  for (const r of roots) {
    const cid = cidToBytes(r);
    if (!cid) bad('car-root-not-cidv1', r);
    const payload = concat([Uint8Array.of(0x00), cid]);
    const len = payload.length < 24 ? Uint8Array.of(0x40 | payload.length)
      : payload.length < 256 ? Uint8Array.of(0x58, payload.length) : bad('car-root-too-long');
    parts.push(Uint8Array.of(0xd8, 0x2a), len, payload);
  }
  parts.push(Uint8Array.from([0x67, ...new TextEncoder().encode('version'), 0x01]));
  return concat(parts);
}

/** CARv1 bytes for roots (CID strings) and blocks [{cid, bytes}], in the given order. */
export function encodeCarV1(roots, blocks) {
  const header = encodeHeader(roots);
  const parts = [varint(header.length), header];
  for (const { cid, bytes } of blocks) {
    const c = cidToBytes(cid);
    if (!c) bad('car-block-cid-not-cidv1', cid);
    parts.push(varint(c.length + bytes.length), c, bytes);
  }
  return concat(parts);
}

/**
 * Parse CARv1 or CARv2 bytes. -> { version, roots: [cid], blocks: [{cid, bytes}] }.
 * Duplicate sections with the same CID are kept once. Limits: maxBlocks sections.
 */
export function parseCar(input, { maxBlocks = 4096 } = {}) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let version = 1;
  if (bytes.length >= 51 && CARV2_PRAGMA.every((b, i) => bytes[i] === b)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dataOffset = view.getBigUint64(11 + 16, true), dataSize = view.getBigUint64(11 + 24, true);
    if (dataOffset < 51n || dataOffset + dataSize > BigInt(bytes.length)) bad('carv2-bad-data-range');
    bytes = bytes.subarray(Number(dataOffset), Number(dataOffset + dataSize));
    version = 2;
  }
  let [hlen, i] = readVarint(bytes, 0);
  if (hlen === 0n || BigInt(bytes.length - i) < hlen) bad('car-truncated');
  let header;
  try { header = decodeDagCbor(bytes.subarray(i, i + Number(hlen))).value; }
  catch (e) { if (e instanceof DagCborError) bad('car-header-not-canonical-dag-cbor', e.code); throw e; }
  if (!(header instanceof Map) || header.size !== 2 || header.get('version') !== 1n || !Array.isArray(header.get('roots')))
    bad('car-header-invalid');
  const roots = header.get('roots').map((r) => {
    const cid = r && r.cid ? cidFromBytes(r.cid) : null;
    if (!cid) bad('car-root-not-cidv1');
    return cid;
  });
  if (roots.length === 0) bad('car-no-roots');
  i += Number(hlen);
  const blocks = []; const seen = new Set();
  while (i < bytes.length) {
    let len; [len, i] = readVarint(bytes, i);
    if (len === 0n || BigInt(bytes.length - i) < len) bad('car-truncated');
    const end = i + Number(len);
    const section = bytes.subarray(i, end);
    const cl = cidLength(section, 0);
    if (cl > section.length) bad('car-truncated');
    const cid = cidFromBytes(section.subarray(0, cl));
    if (!cid) bad('car-block-cid-invalid');
    if (!seen.has(cid)) {
      if (blocks.length >= maxBlocks) bad('car-too-many-blocks', String(maxBlocks));
      seen.add(cid); blocks.push({ cid, bytes: section.subarray(cl) });
    }
    i = end;
  }
  return { version, roots, blocks };
}
