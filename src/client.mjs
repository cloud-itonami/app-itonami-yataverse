// Read, write and verify blocks on the yataverse bytes plane.
//   read:   GET <readUrl>/ipfs/<cid>   (the gateway may 301 to <cid>.ipfs.<domain>; followed,
//           but only inside the read host's own parent domain, at most 3 hops)
//   write:  PUT <url><prefix><cid>     (Authorization required; NEVER follows a redirect)
//   car:    POST <url><prefix> (CAR import) and GET <readUrl>/ipfs/<root>?format=car (export);
//           neither follows a redirect
// Every read and every write is checked by re-deriving the CID from the bytes.
import { cidFor, verifyBlock, isCidShape } from './cid.mjs';
import { checkWritableBlock, WRITABLE_CODECS } from './block.mjs';
import { parseCar, CarError, CAR_CONTENT_TYPE } from './car.mjs';
import { checkClosure, DagError } from './dag.mjs';

export const DEFAULT_MAX_CAR_BYTES = 32 * 1024 * 1024;

/** Parse and check a CAR the way the server will; -> { roots, blocks: Map }. Throws YataverseError. */
export function checkCarLocally(bytes) {
  let car;
  try { car = parseCar(bytes); } catch (e) { if (e instanceof CarError) throw new YataverseError(e.code); throw e; }
  const blocks = new Map();
  for (const { cid, bytes: b } of car.blocks) {
    const bad = checkWritableBlock(cid, b);
    if (bad) throw new YataverseError(bad, cid);
    blocks.set(cid, b);
  }
  for (const r of car.roots) if (!blocks.has(r)) throw new YataverseError('car-root-missing', r);
  return { roots: car.roots, blocks };
}

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
    if (!isCidShape(cid)) throw new YataverseError('bad-cid');
    const bad = checkWritableBlock(cid, bytes);
    if (bad) throw new YataverseError(bad);
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
  async function putBytes(bytes, { codec = 'raw' } = {}) {
    if (!(codec in WRITABLE_CODECS)) throw new YataverseError('put-codec-not-accepted', codec);
    const cid = cidFor(bytes, WRITABLE_CODECS[codec]);
    await putBlock(cid, bytes);
    const back = await get(cid);
    if (!back) throw new YataverseError('readback-absent');
    return { cid, verified: true, bytes: bytes.length };
  }

  async function verifyRemote(cid) {
    const bytes = await get(cid);
    return bytes ? { cid, present: true, verified: true, bytes: bytes.length } : { cid, present: false, verified: false };
  }

  /** Export a root as CAR and verify it completely. -> { bytes, blocks: Map } */
  async function getCar(root, { scope = 'all', maxBytes = DEFAULT_MAX_CAR_BYTES } = {}) {
    if (!isCidShape(root)) throw new YataverseError('bad-cid');
    if (scope !== 'all' && scope !== 'block') throw new YataverseError('dag-scope-not-supported', scope);
    const url = new URL(`/ipfs/${root}`, readOrigin);
    url.searchParams.set('format', 'car'); url.searchParams.set('dag-scope', scope);
    if (!okScheme(url)) throw new YataverseError('read-url-not-https');
    const res = await fetchImpl(url, { redirect: 'manual', signal: timeout(), headers: { accept: CAR_CONTENT_TYPE } });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new YataverseError('car-read-failed', `HTTP ${res.status}`);
    const bytes = await readCapped(res, maxBytes);
    let car;
    try { car = parseCar(bytes); } catch (e) { if (e instanceof CarError) throw new YataverseError(e.code); throw e; }
    if (car.roots.length !== 1 || car.roots[0] !== root) throw new YataverseError('car-root-mismatch');
    const blocks = new Map();
    for (const b of car.blocks) {
      if (!verifyBlock(b.cid, b.bytes)) throw new YataverseError('cid-mismatch', b.cid);
      blocks.set(b.cid, b.bytes);
    }
    if (scope === 'block') {
      if (blocks.size !== 1 || !blocks.has(root)) throw new YataverseError('car-scope-block-mismatch');
    } else {
      try { await checkClosure([root], blocks, async () => false); }
      catch (e) { if (e instanceof DagError) throw new YataverseError(`car-${e.code}`, String(e.message).split(': ')[1]); throw e; }
    }
    return { bytes, blocks };
  }

  /** Import a CAR, then export every root and check each uploaded block came back identical. */
  async function putCar(bytes) {
    const local = checkCarLocally(bytes);
    if (!authorize) throw new YataverseError('no-authorization-configured');
    const auth = await authorize();
    const base = new URL(cfg.url);
    if (!okScheme(base)) throw new YataverseError('write-url-not-https');
    const res = await fetchImpl(new URL(cfg.prefix, base), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(120_000),
      headers: { authorization: auth, 'content-type': CAR_CONTENT_TYPE }, body: bytes,
    });
    if (REDIRECTS.has(res.status)) throw new YataverseError('car-put-redirected', 'a write is never followed to another host');
    let j = null; try { j = await res.json(); } catch { /* not JSON */ }
    if (res.status !== 201) throw new YataverseError('car-put-failed', `HTTP ${res.status}${j?.error ? ` ${j.error}` : ''}`);
    const seen = new Map();
    for (const r of local.roots) {
      const back = await getCar(r, { scope: 'all' });
      if (!back) throw new YataverseError('car-readback-absent', r);
      for (const [c, b] of back.blocks) seen.set(c, b);
    }
    for (const [c, b] of local.blocks) {
      const got = seen.get(c);
      if (!got || Buffer.compare(Buffer.from(got), Buffer.from(b)) !== 0) throw new YataverseError('car-readback-mismatch', c);
    }
    return { roots: local.roots, blocks: local.blocks.size, external: j?.external ?? [], verified: true };
  }

  return { get, putBlock, putBytes, verifyRemote, getCar, putCar };
}
