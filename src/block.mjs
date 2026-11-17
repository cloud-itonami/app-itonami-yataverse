// Which blocks the bytes plane accepts for writing, shared by the client and the Worker.
// CIDv1 / sha2-256 with codec raw (0x55) or dag-cbor (0x71), the core subset of the Awai
// File Format. A dag-cbor block must also be canonical DAG-CBOR.
import { parseCid, verifyBlock, CODEC_RAW, CODEC_DAG_CBOR, SHA2_256 } from './cid.mjs';
import { validateDagCbor } from './dag-cbor.mjs';

export const WRITABLE_CODECS = Object.freeze({ raw: CODEC_RAW, 'dag-cbor': CODEC_DAG_CBOR });

/** -> null when (cid, bytes) may be written, else an error code. Does not check size. */
export function checkWritableBlock(cid, bytes) {
  const p = parseCid(cid);
  if (!p || p.version !== 1 || p.hashCode !== SHA2_256) return 'put-requires-cidv1-sha2-256';
  if (p.codec !== CODEC_RAW && p.codec !== CODEC_DAG_CBOR) return 'put-codec-not-accepted';
  if (!verifyBlock(cid, bytes)) return 'bytes-do-not-hash-to-cid';
  if (p.codec === CODEC_DAG_CBOR) {
    const bad = validateDagCbor(bytes);
    if (bad) return `not-canonical-dag-cbor:${bad}`;
  }
  return null;
}
