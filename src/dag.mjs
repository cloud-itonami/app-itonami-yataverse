// DAG traversal over the codecs the bytes plane accepts: raw blocks are leaves, dag-cbor
// blocks link through tag 42, dag-pb (UnixFS) blocks through their PBLinks. Anything else is refused instead of being skipped, so a
// "complete" closure is never claimed over links it could not see.
import { parseCid, cidFromBytes, CODEC_RAW, CODEC_DAG_CBOR, CODEC_DAG_PB } from './cid.mjs';
import { unixfsLinks, DagPbError } from './dag-pb.mjs';
import { decodeDagCbor, linksIn } from './dag-cbor.mjs';

export class DagError extends Error { constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; } }

/** CID strings linked from a verified block, in encounter order. */
export function linksOf(cid, bytes) {
  const p = parseCid(cid);
  if (!p) throw new DagError('bad-cid', cid);
  if (p.codec === CODEC_RAW) return [];
  if (p.codec === CODEC_DAG_PB) {
    try { return unixfsLinks(bytes); }
    catch (e) { if (e instanceof DagPbError) throw new DagError('block-not-unixfs', `${cid} ${e.code}`); throw e; }
  }
  if (p.codec !== CODEC_DAG_CBOR) throw new DagError('codec-not-traversable', cid);
  return linksIn(decodeDagCbor(bytes).value).map((b) => {
    const c = cidFromBytes(b);
    if (!c) throw new DagError('link-not-cidv1', cid);
    const lp = parseCid(c);
    if (lp.codec !== CODEC_RAW && lp.codec !== CODEC_DAG_CBOR && lp.codec !== CODEC_DAG_PB) throw new DagError('link-codec-not-traversable', c);
    return c;
  });
}

/**
 * Check that every block reachable from `roots` is in `blocks` (Map cid -> bytes) or reported
 * present by `isStored(cid)` (async). Returns { reachable: Set, external: [cid] } and throws
 * DagError('closure-incomplete', cid) on the first missing block. Blocks in `blocks` that are
 * not reachable from a root are refused ('block-not-reachable').
 */
export async function checkClosure(roots, blocks, isStored) {
  const reachable = new Set(); const external = []; const stack = [...roots].reverse();
  while (stack.length) {
    const cid = stack.pop();
    if (reachable.has(cid)) continue;
    reachable.add(cid);
    const bytes = blocks.get(cid);
    if (!bytes) {
      if (!(await isStored(cid))) throw new DagError('closure-incomplete', cid);
      external.push(cid);
      continue;
    }
    const links = linksOf(cid, bytes);
    for (let i = links.length - 1; i >= 0; i--) stack.push(links[i]);
  }
  for (const cid of blocks.keys()) if (!reachable.has(cid)) throw new DagError('block-not-reachable', cid);
  return { reachable, external };
}

/**
 * Depth-first, duplicate-free traversal from `root` (dag-scope=all), or the root alone
 * (dag-scope=block). `load(cid)` returns verified bytes or null. -> [{cid, bytes}] in DFS order.
 */
export async function collectDag(root, scope, load, { maxBlocks = 4096, maxBytes = 32 * 1024 * 1024 } = {}) {
  const out = []; const seen = new Set(); const stack = [root]; let total = 0;
  while (stack.length) {
    const cid = stack.pop();
    if (seen.has(cid)) continue;
    seen.add(cid);
    const bytes = await load(cid);
    if (!bytes) throw new DagError(cid === root ? 'root-not-found' : 'closure-incomplete', cid);
    total += bytes.length;
    if (out.length + 1 > maxBlocks) throw new DagError('too-many-blocks', String(maxBlocks));
    if (total > maxBytes) throw new DagError('too-many-bytes', String(maxBytes));
    out.push({ cid, bytes });
    if (scope === 'block') break;
    const links = linksOf(cid, bytes);
    for (let i = links.length - 1; i >= 0; i--) stack.push(links[i]);
  }
  return out;
}
