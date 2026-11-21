// Which blocks the bytes plane accepts for writing, shared by the client and the Worker.
// CIDv1 / sha2-256 with codec raw (0x55) or dag-cbor (0x71), the core subset of the Awai
// File Format, plus dag-pb (0x70) when the block is a plain UnixFS file or directory
// (dag-pb.mjs), so a published site keeps the CID an IPFS node gives it.
// A dag-cbor block must be canonical DAG-CBOR; a dag-pb block must be canonical UnixFS.
import { parseCid, verifyBlock, CODEC_RAW, CODEC_DAG_CBOR, CODEC_DAG_PB, SHA2_256 } from './cid.mjs';
import { validateDagCbor } from './dag-cbor.mjs';
import { validateUnixfs } from './dag-pb.mjs';

export const WRITABLE_CODECS = Object.freeze({ raw: CODEC_RAW, 'dag-cbor': CODEC_DAG_CBOR, 'dag-pb': CODEC_DAG_PB });

/** -> null when (cid, bytes) may be written, else an error code. Does not check size. */
export function checkWritableBlock(cid, bytes) {
  const p = parseCid(cid);
  if (!p || p.version !== 1 || p.hashCode !== SHA2_256) return 'put-requires-cidv1-sha2-256';
  if (p.codec !== CODEC_RAW && p.codec !== CODEC_DAG_CBOR && p.codec !== CODEC_DAG_PB) return 'put-codec-not-accepted';
  if (!verifyBlock(cid, bytes)) return 'bytes-do-not-hash-to-cid';
  if (p.codec === CODEC_DAG_CBOR) {
    const bad = validateDagCbor(bytes);
    if (bad) return `not-canonical-dag-cbor:${bad}`;
  }
  if (p.codec === CODEC_DAG_PB) {
    const bad = validateUnixfs(bytes);
    if (bad) return `not-accepted-unixfs:${bad}`;
  }
  return null;
}
