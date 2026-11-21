// UnixFS over the accepted DAG-PB subset (dag-pb.mjs): walk a path from a root, read a file,
// and pack a small file tree the way `ipfs add -r --cid-version=1` does.
import { parseCid, cidFor, CODEC_RAW, CODEC_DAG_PB } from './cid.mjs';
import { decodeUnixfs, encodePbNode, encodeUnixfsData, hashOf, UNIXFS_TYPE, DagPbError } from './dag-pb.mjs';

export class UnixfsError extends Error { constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; } }

export const DEFAULT_CHUNK_BYTES = 262144;      // Kubo's default chunker (size-262144)
export const MAX_LINKS_PER_NODE = 174;          // Kubo's default file fan-out

function nodeOf(cid, bytes) {
  const p = parseCid(cid);
  if (!p) throw new UnixfsError('bad-cid', cid);
  if (p.codec === CODEC_RAW) return { type: 'file', inline: bytes, chunks: [], size: bytes.length };
  if (p.codec !== CODEC_DAG_PB) throw new UnixfsError('codec-not-unixfs', cid);
  try { return decodeUnixfs(bytes); } catch (e) {
    if (e instanceof DagPbError) throw new UnixfsError('block-not-unixfs', `${cid} ${e.code}`);
    throw e;
  }
}

async function loadNode(cid, load) {
  const bytes = await load(cid);
  if (!bytes) throw new UnixfsError('block-not-found', cid);
  return nodeOf(cid, bytes);
}

/**
 * Walk `segments` (already decoded path parts) from `root`. `load(cid)` returns verified bytes
 * or null. -> { cid, node } of the last part, or null when a part does not exist.
 */
export async function resolvePath(root, segments, load) {
  let cid = root; let node = await loadNode(cid, load);
  for (const name of segments) {
    if (node.type !== 'directory') return null;
    const entry = node.entries.find((e) => e.name === name);
    if (!entry) return null;
    cid = entry.cid; node = await loadNode(cid, load);
  }
  return { cid, node };
}

/** The bytes of a file node, chunks in order. Every chunk must have its declared size. */
export async function readFile(node, load, { maxBlocks = 128, maxBytes = 32 * 1024 * 1024 } = {}) {
  if (node.type !== 'file') throw new UnixfsError('not-a-file');
  if (node.size > maxBytes) throw new UnixfsError('file-too-large', String(node.size));
  const budget = { blocks: 0 };
  const parts = [];
  const walk = async (n) => {
    if (n.inline.length) parts.push(n.inline);
    for (const c of n.chunks) {
      if (++budget.blocks > maxBlocks) throw new UnixfsError('file-has-too-many-blocks', String(maxBlocks));
      const child = await loadNode(c.cid, load);
      if (child.type !== 'file' || child.size !== c.size) throw new UnixfsError('chunk-size-mismatch', c.cid);
      await walk(child);
    }
  };
  await walk(node);
  return Buffer.concat(parts);
}

function addBlock(blocks, bytes, codec) { const cid = cidFor(bytes, codec); blocks.set(cid, bytes); return cid; }

function packFile(bytes, blocks, chunkBytes) {
  if (bytes.length <= chunkBytes) return { cid: addBlock(blocks, bytes, CODEC_RAW), tsize: bytes.length };
  const links = []; const sizes = [];
  for (let off = 0; off < bytes.length; off += chunkBytes) {
    const chunk = bytes.subarray(off, off + chunkBytes);
    links.push({ hash: hashOf(addBlock(blocks, chunk, CODEC_RAW)), name: '', tsize: chunk.length });
    sizes.push(chunk.length);
  }
  if (links.length > MAX_LINKS_PER_NODE) throw new UnixfsError('file-too-large-for-packer', String(bytes.length));
  const node = encodePbNode({ links, data: encodeUnixfsData({ type: UNIXFS_TYPE.file, filesize: bytes.length, blocksizes: sizes }) });
  return { cid: addBlock(blocks, node, CODEC_DAG_PB), tsize: node.length + bytes.length };
}

function packDir(tree, blocks, chunkBytes) {
  const links = [];
  for (const name of [...tree.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
    const v = tree.get(name);
    const child = v instanceof Map ? packDir(v, blocks, chunkBytes) : packFile(v, blocks, chunkBytes);
    links.push({ hash: hashOf(child.cid), name, tsize: child.tsize });
  }
  const node = encodePbNode({ links, data: encodeUnixfsData({ type: UNIXFS_TYPE.directory }) });
  return { cid: addBlock(blocks, node, CODEC_DAG_PB), tsize: node.length + links.reduce((n, l) => n + l.tsize, 0) };
}

/**
 * Pack files into a UnixFS directory. `files` maps a relative path ("a/b.html") to bytes.
 * -> { root, blocks: Map cid -> bytes }. Files larger than 174 chunks are refused.
 */
export function packFiles(files, { chunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
  const tree = new Map();
  for (const [path, bytes] of files instanceof Map ? files : Object.entries(files)) {
    const parts = path.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\0'))) throw new UnixfsError('bad-path', path);
    let dir = tree;
    for (const p of parts.slice(0, -1)) {
      if (!dir.has(p)) dir.set(p, new Map());
      dir = dir.get(p);
      if (!(dir instanceof Map)) throw new UnixfsError('path-is-both-file-and-directory', path);
    }
    const leaf = parts[parts.length - 1];
    if (dir.has(leaf)) throw new UnixfsError('path-is-both-file-and-directory', path);
    dir.set(leaf, Buffer.from(bytes));
  }
  const blocks = new Map();
  return { root: packDir(tree, blocks, chunkBytes).cid, blocks };
}
