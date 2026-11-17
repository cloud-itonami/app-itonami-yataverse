// Strict DAG-CBOR well-formedness check (https://ipld.io/specs/codecs/dag-cbor/spec/).
// A block stored under a CIDv1/dag-cbor (0x71) CID must be canonical DAG-CBOR, so that the
// CID names one data model value with one byte spelling. This only validates; it does not
// build a data model value. Returns null when valid, or a short error code.
//
// Rules enforced: one top-level item and no trailing bytes; definite lengths only; every
// integer and length in its shortest form; text is valid UTF-8; map keys are text strings,
// unique, sorted length-first then bytewise; the only tag is 42 (a CID link: a byte string
// of 0x00 followed by a binary CID); floats are 64-bit and finite; the only simple values
// are false, true and null; nesting is bounded.

export const MAX_DEPTH = 256;
const utf8 = new TextDecoder('utf-8', { fatal: true });

class Bad extends Error { constructor(code) { super(code); this.code = code; } }

function readUvarint(bytes, i) {
  let value = 0n;
  for (let n = 0; n < 9; n++) {
    if (i >= bytes.length) throw new Bad('cid-link-truncated');
    const b = bytes[i++];
    value |= BigInt(b & 0x7f) << BigInt(7 * n);
    if ((b & 0x80) === 0) {
      if (n > 0 && b === 0) throw new Bad('cid-link-varint-not-minimal');
      return [value, i];
    }
  }
  throw new Bad('cid-link-varint-too-long');
}

/** A tag-42 payload: 0x00 then a binary CIDv1, or a 34-byte CIDv0 multihash. */
function checkCidLink(b) {
  if (b.length < 2 || b[0] !== 0x00) throw new Bad('cid-link-missing-identity-prefix');
  const cid = b.subarray(1);
  if (cid[0] === 0x12 && cid[1] === 0x20) {
    if (cid.length !== 34) throw new Bad('cid-link-bad-cidv0');
    return;
  }
  let i = 0, version, mhLen;
  [version, i] = readUvarint(cid, i);
  if (version !== 1n) throw new Bad('cid-link-unsupported-version');
  [, i] = readUvarint(cid, i);          // codec: any value is a valid link target
  [, i] = readUvarint(cid, i);          // multihash code
  [mhLen, i] = readUvarint(cid, i);
  if (BigInt(cid.length - i) !== mhLen) throw new Bad('cid-link-bad-multihash-length');
}

function compareKeys(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function validateDagCbor(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const need = (n) => { if (pos + n > bytes.length) throw new Bad('truncated'); };

  /** Read the argument of an initial byte; enforce the shortest encoding. */
  function argument(info) {
    if (info < 24) return BigInt(info);
    if (info === 24) { need(1); const v = bytes[pos]; pos += 1; if (v < 24) throw new Bad('integer-not-minimal'); return BigInt(v); }
    if (info === 25) { need(2); const v = view.getUint16(pos); pos += 2; if (v <= 0xff) throw new Bad('integer-not-minimal'); return BigInt(v); }
    if (info === 26) { need(4); const v = view.getUint32(pos); pos += 4; if (v <= 0xffff) throw new Bad('integer-not-minimal'); return BigInt(v); }
    if (info === 27) { need(8); const v = view.getBigUint64(pos); pos += 8; if (v <= 0xffffffffn) throw new Bad('integer-not-minimal'); return v; }
    if (info === 31) throw new Bad('indefinite-length');
    throw new Bad('reserved-additional-info');
  }

  function length(info) {
    const n = argument(info);
    if (n > BigInt(bytes.length - pos)) throw new Bad('length-exceeds-block');
    return Number(n);
  }

  /** Validate one item; returns its encoded bytes span when the caller needs it (map keys). */
  function item(depth) {
    if (depth > MAX_DEPTH) throw new Bad('too-deep');
    need(1);
    const start = pos;
    const ib = bytes[pos++];
    const major = ib >> 5, info = ib & 0x1f;
    switch (major) {
      case 0: case 1: argument(info); break;
      case 2: { const n = length(info); pos += n; break; }
      case 3: {
        const n = length(info);
        try { utf8.decode(bytes.subarray(pos, pos + n)); } catch { throw new Bad('text-not-utf8'); }
        pos += n; break;
      }
      case 4: { const n = argument(info); for (let i = 0n; i < n; i++) item(depth + 1); break; }
      case 5: {
        const n = argument(info);
        let prev = null;
        for (let i = 0n; i < n; i++) {
          need(1);
          if (bytes[pos] >> 5 !== 3) throw new Bad('map-key-not-text');
          const ks = pos; item(depth + 1); const key = bytes.subarray(ks, pos);
          if (prev) {
            const c = compareKeys(prev, key);
            if (c === 0) throw new Bad('map-key-duplicate');
            if (c > 0) throw new Bad('map-keys-not-sorted');
          }
          prev = key;
          item(depth + 1);
        }
        break;
      }
      case 6: {
        const tag = argument(info);
        if (tag !== 42n) throw new Bad('tag-not-42');
        need(1);
        if (bytes[pos] >> 5 !== 2) throw new Bad('cid-link-not-bytes');
        const bs = pos; item(depth + 1);
        // Re-read the byte string payload just validated.
        const hb = bytes[bs] & 0x1f; const hdr = hb < 24 ? 1 : hb === 24 ? 2 : hb === 25 ? 3 : hb === 26 ? 5 : 9;
        checkCidLink(bytes.subarray(bs + hdr, pos));
        break;
      }
      case 7: {
        if (info === 20 || info === 21 || info === 22) break;
        if (info === 27) {
          need(8); const f = view.getFloat64(pos); pos += 8;
          if (!Number.isFinite(f)) throw new Bad('float-not-finite');
          break;
        }
        if (info === 25 || info === 26) throw new Bad('float-not-64-bit');
        if (info === 31) throw new Bad('unexpected-break');
        throw new Bad('simple-value-not-allowed');
      }
    }
    return start;
  }

  try {
    if (bytes.length === 0) return 'empty';
    item(0);
    if (pos !== bytes.length) return 'trailing-bytes';
    return null;
  } catch (e) {
    if (e instanceof Bad) return e.code;
    throw e;
  }
}
