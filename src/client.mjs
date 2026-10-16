// Read, write and verify blocks on the yataverse bytes plane.
//   read:   GET <readUrl>/ipfs/<cid>   (the gateway may 301 to <cid>.ipfs.<domain>; followed,
//           but only inside the read host's own parent domain, at most 3 hops)
//   write:  PUT <url><prefix><cid>     (Authorization required; NEVER follows a redirect)
// Every read and every write is checked by re-deriving the CID from the bytes.
import { rawCid, verifyBlock, isCidShape, parseCid, CODEC_RAW } from './cid.mjs';

export class YataverseError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function parentDomain(host) {
  const labels = host.split('.');
  if (/^[0-9.]+$/.test(host) || labels.length < 3) return host;   // IPs and 2-label hosts stay themselves
  return labels.slice(-2).join('.');
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new YataverseError('too-large', String(declared));
  const chunks = []; let total = 0;
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > maxBytes) throw new YataverseError('too-large', `>${maxBytes}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function makeClient(cfg, { fetchImpl = fetch, authorize, allowInsecureForTests = false } = {}) {
  const readOrigin = new URL(cfg.readUrl);
  const okScheme = (u) => u.protocol === 'https:' || (allowInsecureForTests && u.protocol === 'http:');
  const timeout = () => AbortSignal.timeout(30_000);

  /** GET with same-parent-domain redirects. -> Buffer | null (absent). Throws on any doubt. */
  async function get(cid, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (!isCidShape(cid)) throw new YataverseError('bad-cid');
    let url = new URL(`/ipfs/${cid}`, readOrigin);
    for (let hop = 0; hop <= 3; hop++) {
      url.searchParams.set('format', 'raw');
      if (!okScheme(url)) throw new YataverseError('redirect-not-https');
      if (parentDomain(url.hostname) !== parentDomain(readOrigin.hostname))
        throw new YataverseError('redirect-off-domain', url.hostname);
      const res = await fetchImpl(url, {
        redirect: 'manual', signal: timeout(),
        headers: { accept: 'application/vnd.ipld.raw' },
      });
      if (REDIRECTS.has(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new YataverseError('redirect-without-location');
        url = new URL(loc, url); continue;
      }
      if (res.status === 404) return null;
      if (res.status !== 200) throw new YataverseError('read-failed', `HTTP ${res.status}`);
      const bytes = await readCapped(res, maxBytes);
      if (!verifyBlock(cid, bytes)) throw new YataverseError('cid-mismatch');
      return bytes;
    }
    throw new YataverseError('too-many-redirects');
  }

  async function putBlock(cid, bytes) {
    const parsed = parseCid(cid);
    if (!parsed) throw new YataverseError('bad-cid');
    if (parsed.version !== 1 || parsed.codec !== CODEC_RAW)
      throw new YataverseError('put-requires-cidv1-raw');
    if (!verifyBlock(cid, bytes)) throw new YataverseError('bytes-do-not-hash-to-cid');
    if (!authorize) throw new YataverseError('no-authorization-configured');
    const auth = await authorize();
    const base = new URL(cfg.url);
    if (!okScheme(base)) throw new YataverseError('write-url-not-https');
    const res = await fetchImpl(new URL(`${cfg.prefix}${cid}`, base), {
      method: 'PUT', redirect: 'manual', signal: timeout(),
      headers: { authorization: auth, 'content-type': 'application/vnd.ipld.raw' }, body: bytes,
    });
    if (res.status >= 200 && res.status < 300) return true;
    if (REDIRECTS.has(res.status)) throw new YataverseError('put-redirected', 'a write is never followed to another host');
    const why = { 401: 'unauthorized', 403: 'forbidden', 405: 'method-not-allowed', 413: 'too-large', 400: 'rejected-as-not-matching-cid' }[res.status];
    throw new YataverseError(why ? `put-${why}` : 'put-failed', `HTTP ${res.status}`);
  }

  /** Write bytes, then read them back and verify. -> {cid, verified} */
  async function putBytes(bytes) {
    const cid = rawCid(bytes);
    await putBlock(cid, bytes);
    const back = await get(cid);
    if (!back) throw new YataverseError('readback-absent');
    return { cid, verified: true, bytes: bytes.length };
  }

  async function verifyRemote(cid) {
    const bytes = await get(cid);
    return bytes ? { cid, present: true, verified: true, bytes: bytes.length } : { cid, present: false, verified: false };
  }

  return { get, putBlock, putBytes, verifyRemote };
}
