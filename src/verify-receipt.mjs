// `yataverse verify-receipt`: check a saved storage receipt (docs/storage-receipt-design.md §6).
// Input: a write response ({..., receipt, receiptCid}) or a bare receipt envelope ({v, receipt, sig}).
// With the written file, the subject, content digest and size are recomputed locally instead of
// being taken from the receipt.
import crypto from 'node:crypto';
import { cidFor, cidToBytes, CODEC_RAW } from './cid.mjs';
import { WRITABLE_CODECS } from './block.mjs';
import { parseCar, CarError } from './car.mjs';
import { verifyReceipt, envelopeFromJson, envelopeToDagCbor, rootsCommitment, blockSetDigest, KIND, ReceiptError } from './receipt.mjs';

export class VerifyReceiptError extends Error { constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; } }
const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const KIND_NAMES = { block: KIND.block, car: KIND.car, 'drive-pack': KIND.drivePack };
const nameOf = (k) => Object.entries(KIND_NAMES).find(([, v]) => v === k)?.[0] ?? `unknown-${k}`;

/** The values a receipt must carry for `file`, written as `kind`. */
export function expectedFor(file, kind, { codec = 'raw', external = [] } = {}) {
  if (kind === 'block') {
    if (!(codec in WRITABLE_CODECS)) throw new VerifyReceiptError('bad-codec', codec);
    const cid = cidFor(file, WRITABLE_CODECS[codec] ?? CODEC_RAW);
    return { kind: KIND.block, subject: cidToBytes(cid), contentDigest: sha256(file), size: file.length };
  }
  if (kind === 'drive-pack') return { kind: KIND.drivePack, subject: sha256(file), contentDigest: sha256(file), size: file.length };
  if (kind === 'car') {
    let car;
    try { car = parseCar(file); } catch (e) { if (e instanceof CarError) throw new VerifyReceiptError(e.code); throw e; }
    const blocks = new Map(car.blocks.map((b) => [b.cid, b.bytes]));
    let size = 0; for (const b of blocks.values()) size += b.length;
    return { kind: KIND.car, subject: rootsCommitment(car.roots), contentDigest: blockSetDigest([...blocks.keys(), ...external]), size };
  }
  throw new VerifyReceiptError('bad-kind', `${kind} (expected block, car or drive-pack)`);
}

/**
 * input: parsed JSON. keys: the published key set. Optional file/kind/codec pin the content.
 * -> a summary of what was checked. Throws VerifyReceiptError.
 */
export async function verifyReceiptInput(input, keys, { file, kind, codec } = {}) {
  const isEnvelope = input && input.v === 1 && input.sig && input.receipt;
  const envJson = isEnvelope ? input : input?.receipt;
  if (!envJson) throw new VerifyReceiptError('no-receipt-in-input');
  let env;
  try { env = envelopeFromJson(envJson); } catch (e) { if (e instanceof ReceiptError) throw new VerifyReceiptError(`receipt-${e.code}`); throw e; }
  const checked = ['signature', 'key', 'state', 'storeClass'];
  let expect = {};
  if (file) {
    if (!kind) throw new VerifyReceiptError('kind-required-with-file');
    const external = !isEnvelope && Array.isArray(input.external) ? input.external.map(String) : [];
    expect = expectedFor(file, kind, { codec, external });
    checked.push('kind', 'subject', 'contentDigest', 'size');
  }
  let r;
  try { r = await verifyReceipt(env, keys, expect); } catch (e) { if (e instanceof ReceiptError) throw new VerifyReceiptError(`receipt-${e.code}`); throw e; }
  const { cid } = envelopeToDagCbor(env);
  if (!isEnvelope && input.receiptCid !== undefined) {
    if (input.receiptCid !== cid) throw new VerifyReceiptError('receipt-cid-mismatch');
    checked.push('receiptCid');
  }
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  return {
    verified: true, checked, receiptCid: cid, kind: nameOf(r.kind), size: r.size,
    contentDigest: hex(r.contentDigest), requestId: hex(r.requestId), requester: hex(r.requester),
    acceptedAt: new Date(r.acceptedAt).toISOString(), state: 'local-durable-readback', storeClass: r.storeClass === 1 ? 'edge-gateway' : 'provider-node',
    policyRevision: hex(r.policyRevision), keyId: hex(r.keyId), keyEpoch: r.keyEpoch, signer: keys?.signer ?? null,
    claims: 'this gateway stored and read back these bytes at acceptedAt; not retention or independent replicas',
  };
}
