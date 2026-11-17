// Strict DAG-CBOR (https://ipld.io/specs/codecs/dag-cbor/spec/): a decoder that refuses every
// non-canonical spelling, so that a dag-cbor CID names one data model value with one byte
// form. Used to validate stored blocks, to read CAR headers and to find CID links.
//
// Rules enforced: one top-level item and no trailing bytes; definite lengths only; every
// integer and length in its shortest form; text is valid UTF-8; map keys are text strings,
// unique, sorted length-first then bytewise; the only tag is 42 (a CID link: a byte string
// of 0x00 followed by a binary CID); floats are 64-bit and finite; the only simple values
// are false, true and null; nesting is bounded.
//
// Decoded values: integers are BigInt, byte strings Uint8Array, maps Map (text keys),
// arrays Array, links { cid: Uint8Array } (the binary CID without the 0x00 prefix).

export const MAX_DEPTH = 256;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export class DagCborError extends Error { constructor(code) { super(code); this.code = code; } }
const bad = (code) => { throw new DagCborError(code); };

function readUvarint(bytes, i) {
  let value = 0n;
  for (let n = 0; n < 9; n++) {
    if (i >= bytes.length) bad('cid-link-truncated');
    const b = bytes[i++];
    value |= BigInt(b & 0x7f) << BigInt(7 * n);
    if ((b & 0x80) === 0) {
      if (n > 0 && b === 0) bad('cid-link-varint-not-minimal');
      return [value, i];
    }
  }
  return bad('cid-link-varint-too-long');
}

/** A tag-42 payload: 0x00 then a binary CIDv1, or a 34-byte CIDv0 multihash. Returns the CID bytes. */
function checkCidLink(b) {
  if (b.length < 2 || b[0] !== 0x00) bad('cid-link-missing-identity-prefix');
  const cid = b.subarray(1);
  if (cid[0] === 0x12 && cid[1] === 0x20) {
    if (cid.length !== 34) bad('cid-link-bad-cidv0');
    return cid;
  }
  let i = 0, version, mhLen;
  [version, i] = readUvarint(cid, i);
  if (version !== 1n) bad('cid-link-unsupported-version');
  [, i] = readUvarint(cid, i);          // codec: any value is a valid link target
  [, i] = readUvarint(cid, i);          // multihash code
  [mhLen, i] = readUvarint(cid, i);
  if (BigInt(cid.length - i) !== mhLen) bad('cid-link-bad-multihash-length');
  return cid;
}

function compareKeys(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Decode one strict DAG-CBOR item starting at `offset`. With `whole` (the default) the item
 * must end exactly at the end of `bytes`. Returns { value, end }. Throws DagCborError.
 */
export function decodeDagCbor(input, { offset = 0, whole = true } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = offset;
  const need = (n) => { if (pos + n > bytes.length) bad('truncated'); };

  function argument(info) {
    if (info < 24) return BigInt(info);
    if (info === 24) { need(1); const v = bytes[pos]; pos += 1; if (v < 24) bad('integer-not-minimal'); return BigInt(v); }
    if (info === 25) { need(2); const v = view.getUint16(pos); pos += 2; if (v <= 0xff) bad('integer-not-minimal'); return BigInt(v); }
    if (info === 26) { need(4); const v = view.getUint32(pos); pos += 4; if (v <= 0xffff) bad('integer-not-minimal'); return BigInt(v); }
    if (info === 27) { need(8); const v = view.getBigUint64(pos); pos += 8; if (v <= 0xffffffffn) bad('integer-not-minimal'); return v; }
    if (info === 31) bad('indefinite-length');
    return bad('reserved-additional-info');
  }

  function length(info) {
    const n = argument(info);
    if (n > BigInt(bytes.length - pos)) bad('length-exceeds-block');
    return Number(n);
  }

  function item(depth) {
    if (depth > MAX_DEPTH) bad('too-deep');
    need(1);
    const ib = bytes[pos++];
    const major = ib >> 5, info = ib & 0x1f;
    switch (major) {
      case 0: return argument(info);
      case 1: return -1n - argument(info);
      case 2: { const n = length(info); const v = bytes.subarray(pos, pos + n); pos += n; return v; }
      case 3: {
        const n = length(info);
        let s; try { s = utf8.decode(bytes.subarray(pos, pos + n)); } catch { bad('text-not-utf8'); }
        pos += n; return s;
      }
      case 4: {
        const n = argument(info);
        if (n > BigInt(bytes.length - pos)) bad('length-exceeds-block');   // each element is >= 1 byte
        const out = []; for (let i = 0n; i < n; i++) out.push(item(depth + 1)); return out;
      }
      case 5: {
        const n = argument(info);
        if (n * 2n > BigInt(bytes.length - pos)) bad('length-exceeds-block');
        const out = new Map(); let prev = null;
        for (let i = 0n; i < n; i++) {
          need(1);
          if (bytes[pos] >> 5 !== 3) bad('map-key-not-text');
          const ks = pos; const key = item(depth + 1); const raw = bytes.subarray(ks, pos);
          if (prev) {
            const c = compareKeys(prev, raw);
            if (c === 0) bad('map-key-duplicate');
            if (c > 0) bad('map-keys-not-sorted');
          }
          prev = raw;
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 6: {
        const tag = argument(info);
        if (tag !== 42n) bad('tag-not-42');
        need(1);
        if (bytes[pos] >> 5 !== 2) bad('cid-link-not-bytes');
        return { cid: checkCidLink(item(depth + 1)) };
      }
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 27) {
          need(8); const f = view.getFloat64(pos); pos += 8;
          if (!Number.isFinite(f)) bad('float-not-finite');
          return f;
        }
        if (info === 25 || info === 26) bad('float-not-64-bit');
        if (info === 31) bad('unexpected-break');
        return bad('simple-value-not-allowed');
      }
    }
  }

  if (pos >= bytes.length) bad('empty');
  const value = item(0);
  if (whole && pos !== bytes.length) bad('trailing-bytes');
  return { value, end: pos };
}

/** -> null when `bytes` is one canonical DAG-CBOR item, else an error code. */
export function validateDagCbor(bytes) {
  try { decodeDagCbor(bytes); return null; } catch (e) { if (e instanceof DagCborError) return e.code; throw e; }
}

/** Every CID link (binary CID bytes) in a decoded value, in encounter order. */
export function linksIn(value, out = []) {
  if (value instanceof Map) { for (const v of value.values()) linksIn(v, out); }
  else if (Array.isArray(value)) { for (const v of value) linksIn(v, out); }
  else if (value && typeof value === 'object' && value.cid instanceof Uint8Array) out.push(value.cid);
  return out;
}
