// DAG-PB blocks that hold UnixFS files and directories: the form `ipfs add --cid-version=1`
// writes and every IPFS gateway reads. The bytes plane accepts them so that a published site
// has the same CID here as on an IPFS node.
//
// Only the plain subset is accepted: a Directory with named links, a File with unnamed chunk
// links (or inline data), and the legacy Raw leaf. HAMT shards, symlinks, metadata nodes and
// the optional mode/mtime fields are refused. A block must also be in canonical form (decoding
// and encoding again gives the same bytes), so one node has one spelling.
import { cidFromBytes, cidToBytes, parseCid, CODEC_RAW, CODEC_DAG_PB } from './cid.mjs';

export class DagPbError extends Error { constructor(code) { super(code); this.code = code; } }
const err = (code) => { throw new DagPbError(code); };

const UNIXFS_RAW = 0; const UNIXFS_DIRECTORY = 1; const UNIXFS_FILE = 2;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function varint(buf, off) {
  let v = 0n; let shift = 0n; let i = off;
  for (;;) {
    if (i >= buf.length) err('truncated-varint');
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
    if (shift > 63n) err('varint-too-long');
  }
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) err('varint-too-large');
  return [Number(v), i];
}
function encVarint(n) {
  const out = []; let v = BigInt(n);
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
function lenDelim(buf, off) {
  const [len, i] = varint(buf, off);
  if (i + len > buf.length) err('truncated-field');
  return [buf.subarray(i, i + len), i + len];
}
const field = (tag, body) => Buffer.concat([Buffer.from([tag]), encVarint(body.length), body]);

function decodeLink(buf) {
  const link = { hash: null, name: null, tsize: null };
  let off = 0;
  while (off < buf.length) {
    const [tag, i] = varint(buf, off);
    if (tag === 0x0a && link.hash === null) { [link.hash, off] = lenDelim(buf, i); }
    else if (tag === 0x12 && link.name === null) {
      let raw; [raw, off] = lenDelim(buf, i);
      try { link.name = utf8.decode(raw); } catch { err('link-name-not-utf8'); }
    } else if (tag === 0x18 && link.tsize === null) { [link.tsize, off] = varint(buf, i); }
    else err('link-field-not-accepted');
  }
  if (link.hash === null) err('link-without-hash');
  return link;
}

/** PBNode bytes -> { links: [{hash, name|null, tsize|null}], data: Uint8Array|null }. */
export function decodePbNode(bytes) {
  const buf = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.length);
  const node = { links: [], data: null };
  let off = 0;
  while (off < buf.length) {
    const [tag, i] = varint(buf, off);
    let body;
    if (tag === 0x12) { [body, off] = lenDelim(buf, i); node.links.push(decodeLink(body)); }
    else if (tag === 0x0a && node.data === null) { [node.data, off] = lenDelim(buf, i); }
    else err('node-field-not-accepted');
  }
  return node;
}

/** Canonical PBNode bytes: links in the given order, then Data. */
export function encodePbNode({ links = [], data = null }) {
  const parts = [];
  for (const l of links) {
    const body = [field(0x0a, Buffer.from(l.hash))];
    if (l.name !== null && l.name !== undefined) body.push(field(0x12, Buffer.from(l.name, 'utf8')));
    if (l.tsize !== null && l.tsize !== undefined) body.push(Buffer.from([0x18]), encVarint(l.tsize));
    parts.push(field(0x12, Buffer.concat(body)));
  }
  if (data !== null) parts.push(field(0x0a, Buffer.from(data)));
  return Buffer.concat(parts);
}

function decodeUnixfsData(buf) {
  const d = { type: null, data: null, filesize: null, blocksizes: [] };
  let off = 0;
  while (off < buf.length) {
    const [tag, i] = varint(buf, off);
    if (tag === 0x08 && d.type === null) { [d.type, off] = varint(buf, i); }
    else if (tag === 0x12 && d.data === null) { [d.data, off] = lenDelim(buf, i); }
    else if (tag === 0x18 && d.filesize === null) { [d.filesize, off] = varint(buf, i); }
    else if (tag === 0x20) { let n; [n, off] = varint(buf, i); d.blocksizes.push(n); }
    else err('unixfs-field-not-accepted');
  }
  if (d.type === null) err('unixfs-without-type');
  return d;
}

/** UnixFS Data message bytes, fields in number order. */
export function encodeUnixfsData({ type, data = null, filesize = null, blocksizes = [] }) {
  const parts = [Buffer.from([0x08]), encVarint(type)];
  if (data !== null) parts.push(field(0x12, Buffer.from(data)));
  if (filesize !== null) parts.push(Buffer.from([0x18]), encVarint(filesize));
  for (const n of blocksizes) parts.push(Buffer.from([0x20]), encVarint(n));
  return Buffer.concat(parts);
}

function linkCid(hash) {
  const cid = cidFromBytes(new Uint8Array(hash));
  if (!cid) err('link-not-cidv1-sha2-256');
  const codec = parseCid(cid).codec;
  if (codec !== CODEC_RAW && codec !== CODEC_DAG_PB) err('link-codec-not-accepted');
  return cid;
}

/**
 * Decode and check one UnixFS block. Throws DagPbError.
 * -> { type: 'directory', entries: [{ name, cid, tsize }] }
 *  | { type: 'file', inline: Uint8Array, chunks: [{ cid, size }], size }
 */
export function decodeUnixfs(bytes) {
  const node = decodePbNode(bytes);
  if (node.data === null) err('node-without-unixfs-data');
  const d = decodeUnixfsData(node.data);
  if (!Buffer.from(encodeUnixfsData(d)).equals(Buffer.from(node.data))) err('not-canonical-unixfs');
  if (!encodePbNode(node).equals(Buffer.from(bytes))) err('not-canonical-dag-pb');
  if (d.type === UNIXFS_DIRECTORY) {
    if (d.data !== null || d.filesize !== null || d.blocksizes.length) err('directory-with-file-fields');
    let prev = null;
    const entries = node.links.map((l) => {
      const name = l.name;
      if (!name) err('directory-link-without-name');
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\0')) err('directory-link-name-not-accepted');
      const key = Buffer.from(name, 'utf8');
      if (prev && Buffer.compare(prev, key) >= 0) err('directory-links-not-sorted');
      prev = key;
      return { name, cid: linkCid(l.hash), tsize: l.tsize };
    });
    return { type: 'directory', entries };
  }
  if (d.type === UNIXFS_FILE || d.type === UNIXFS_RAW) {
    if (d.type === UNIXFS_RAW && node.links.length) err('raw-leaf-with-links');
    if (node.links.length !== d.blocksizes.length) err('file-blocksizes-do-not-match-links');
    const inline = d.data ?? Buffer.alloc(0);
    const chunks = node.links.map((l, i) => {
      if (l.name) err('file-link-with-name');
      return { cid: linkCid(l.hash), size: d.blocksizes[i] };
    });
    const size = inline.length + chunks.reduce((n, c) => n + c.size, 0);
    if (d.filesize === null ? chunks.length > 0 : d.filesize !== size) err('file-size-does-not-match-parts');
    return { type: 'file', inline, chunks, size };
  }
  return err('unixfs-type-not-accepted');
}

/** -> null when the bytes are an accepted UnixFS block, else an error code. */
export function validateUnixfs(bytes) {
  try { decodeUnixfs(bytes); return null; } catch (e) { if (e instanceof DagPbError) return e.code; throw e; }
}

/** CID strings linked from an accepted UnixFS block, in link order. */
export function unixfsLinks(bytes) {
  const n = decodeUnixfs(bytes);
  return n.type === 'directory' ? n.entries.map((e) => e.cid) : n.chunks.map((c) => c.cid);
}

export const hashOf = (cid) => Buffer.from(cidToBytes(cid));
export const UNIXFS_TYPE = Object.freeze({ raw: UNIXFS_RAW, directory: UNIXFS_DIRECTORY, file: UNIXFS_FILE });
