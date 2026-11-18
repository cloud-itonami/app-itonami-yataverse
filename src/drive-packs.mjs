import { PACK_LIMIT, readResponse } from './bounded-response.mjs';

const packPath = '/awai-drive/v1/packs/';
const packIdPattern = /^[a-f0-9]{64}$/;

// The app supplies its canonical operation broker and hash implementation.
// The client only handles the bounded Drive ciphertext pack profile.
export function createDrivePackClient({ origin, capability, broker, sha256 }) {
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw Error('invalid-sync-origin');
  }

  async function request(operation, id, init) {
    if (!origin) throw Error('sync-not-configured');
    if (typeof id !== 'string' || !packIdPattern.test(id)) throw Error('invalid-root');
    const response = await broker.invoke(
      { capability, service: 'awai.fs', operation },
      { input: origin + packPath + id, init }
    );
    if (!response.ok) throw Error('sync-unavailable');
    return response;
  }

  async function download(id) {
    const bytes = await readResponse(await request('download', id, { method: 'GET' }));
    if (await sha256(bytes) !== id) throw Error('receipt-mismatch');
    return bytes;
  }

  return Object.freeze({
    download,
    async publish(bytes, verifyReceipt) {
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > PACK_LIMIT) {
        throw Error('invalid-pack-size');
      }
      const id = await sha256(bytes);
      const response = await request('upload', id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/vnd.ipld.car' },
        body: bytes
      });
      const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true })
        .decode(await readResponse(response, 2048)));
      if (receipt?.sha256 !== id || receipt.bytes !== bytes.length) throw Error('receipt-mismatch');
      if (verifyReceipt) await verifyReceipt(receipt, { id, size: bytes.length });
      const verified = await download(id);
      if (verified.length !== bytes.length) throw Error('receipt-mismatch');
      return id;
    }
  });
}
