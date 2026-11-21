// Read, write and verify blocks on the yataverse bytes plane.
//   read:   GET <readUrl>/ipfs/<cid>   (the gateway may 301 to <cid>.ipfs.<domain>; followed,
//           but only inside the read host's own parent domain, at most 3 hops)
//   write:  PUT <url><prefix><cid>     (Authorization required; NEVER follows a redirect)
//   car:    POST <url><prefix> (CAR import) and GET <readUrl>/ipfs/<root>?format=car (export);
//           neither follows a redirect
// Every read and every write is checked by re-deriving the CID from the bytes.
//
// Signed storage receipts (docs/storage-receipt-design.md, AWAI-3268 stage 4): every write sends
// a fresh Yataverse-Request-Id. When the response carries a receipt, it is verified against the
// write host's published keys (/.well-known/yataverse-receipt-keys.json, or keys pinned with
// opts.receiptKeys) and the client's own subject, digest, size, request id and requester; a
// receipt that fails is an error even though the bytes were stored. A missing receipt is an error
// when receipts are required: by default for https://yataverse.com, or cfg.requireReceipt.
import crypto from 'node:crypto';
import { cidFor, verifyBlock, isCidShape, cidToBytes, parseCid } from './cid.mjs';
import { verifyReceipt, envelopeFromJson, envelopeToDagCbor, rootsCommitment, blockSetDigest, requesterFor, KIND, STORE_CLASS, ReceiptError } from './receipt.mjs';
import {
  verifyLease, verifyStatus, leaseEnvelopeToDagCbor, leaseEnvelopeFromJson, leaseEnvelopeToJson, statusEnvelopeFromJson, statusEnvelopeToJson,
  statusEnvelopeToDagCbor, receiptCountsFor, RetentionError,
} from './retention.mjs';
import { checkWritableBlock, WRITABLE_CODECS } from './block.mjs';
import { parseCar, CarError, CAR_CONTENT_TYPE } from './car.mjs';
import { blockResource, carResource } from './cacao.mjs';
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

/** Hosts known to issue receipts: a write there without a valid receipt is an error. */
export const RECEIPT_HOSTS = new Set(['yataverse.com']);
const RECEIPT_KEYS_PATH = '/.well-known/yataverse-receipt-keys.json';
export const REQUEST_ID_HEADER = 'yataverse-request-id';
export const LEASE_HEADER = 'yataverse-lease';

export function makeClient(cfg, { fetchImpl = fetch, authorize, allowInsecureForTests = false, receiptKeys: pinnedKeys } = {}) {
  const readOrigin = new URL(cfg.readUrl);
  const okScheme = (u) => u.protocol === 'https:' || (allowInsecureForTests && u.protocol === 'http:');
  const timeout = () => AbortSignal.timeout(30_000);
  const requireReceipt = cfg.requireReceipt ?? RECEIPT_HOSTS.has(new URL(cfg.url).hostname);

  /** The write host's published receipt keys (fetched once, no redirects), or the pinned set. */
  let keysPromise = pinnedKeys ? Promise.resolve(pinnedKeys) : null;
  function receiptKeys() {
    keysPromise ??= (async () => {
      const url = new URL(RECEIPT_KEYS_PATH, new URL(cfg.url));
      if (!okScheme(url)) throw new YataverseError('receipt-keys-url-not-https');
      const res = await fetchImpl(url, { redirect: 'manual', signal: timeout(), headers: { accept: 'application/json' } });
      if (res.status !== 200) throw new YataverseError('receipt-keys-unavailable', `HTTP ${res.status}`);
      try { return JSON.parse((await readCapped(res, 64 * 1024)).toString('utf8')); }
      catch (e) { if (e instanceof YataverseError) throw e; throw new YataverseError('receipt-keys-not-json'); }
    })().catch((e) => { keysPromise = null; throw e; });
    return keysPromise;
  }

  /** Verify a write response's receipt against what this client sent. -> extra result fields. */
  async function checkReceipt(body, expect) {
    if (!body?.receipt) {
      if (requireReceipt) throw new YataverseError('receipt-missing', 'the write host issues receipts; this response has none');
      return {};
    }
    let env;
    try {
      env = envelopeFromJson(body.receipt);
      await verifyReceipt(env, await receiptKeys(), expect);
    } catch (e) { if (e instanceof ReceiptError) throw new YataverseError(`receipt-${e.code}`); throw e; }
    const { cid } = envelopeToDagCbor(env);
    if (body.receiptCid !== undefined && body.receiptCid !== cid) throw new YataverseError('receipt-cid-mismatch');
    return { receipt: body.receipt, receiptCid: cid, receiptVerified: true };
  }

  const newRequestId = (given) => {
    if (given === undefined) return crypto.randomBytes(32);
    const m = /^(?:0x)?([0-9a-f]{64})$/.exec(String(given).toLowerCase());
    if (!m) throw new YataverseError('bad-request-id', 'expected 64 hex characters');
    return Buffer.from(m[1], 'hex');
  };
  const jsonOrNull = async (res) => { try { return await res.json(); } catch { return null; } };
  // What the receipt's `requester` must be: SHA-256 of the writer DID for a CACAO, of the token otherwise.
  const requesterOf = (auth) => (authorize?.requesterDid
    ? new Uint8Array(crypto.createHash('sha256').update(authorize.requesterDid).digest()) : requesterFor(auth));

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

  /** PUT one block. -> { body (parsed JSON or null), requestId, auth }. */
  async function putBlock(cid, bytes, { requestId, leaseHeader } = {}) {
    if (!isCidShape(cid)) throw new YataverseError('bad-cid');
    const bad = checkWritableBlock(cid, bytes);
    if (bad) throw new YataverseError(bad);
    if (!authorize) throw new YataverseError('no-authorization-configured');
    const auth = await authorize({ resource: blockResource(cid) });
    const base = new URL(cfg.url);
    if (!okScheme(base)) throw new YataverseError('write-url-not-https');
    const rid = newRequestId(requestId);
    const res = await fetchImpl(new URL(`${cfg.prefix}${cid}`, base), {
      method: 'PUT', redirect: 'manual', signal: timeout(),
      headers: { authorization: auth, 'content-type': 'application/vnd.ipld.raw', [REQUEST_ID_HEADER]: rid.toString('hex'),
                 ...(leaseHeader ? { [LEASE_HEADER]: leaseHeader } : {}) }, body: bytes,
    });
    if (res.status >= 200 && res.status < 300) return { body: await jsonOrNull(res), requestId: rid, auth };
    if (REDIRECTS.has(res.status)) throw new YataverseError('put-redirected', 'a write is never followed to another host');
    // A leased write is refused for reasons a plain write never meets; pass the host's own code on.
    if (leaseHeader) {
      const j = await jsonOrNull(res);
      const code = typeof j?.error === 'string' && /^[a-z0-9-]{1,80}$/.test(j.error) ? j.error : `http-${res.status}`;
      throw new YataverseError(`leased-put-${code}`, `HTTP ${res.status}`);
    }
    const why = { 401: 'unauthorized', 403: 'forbidden', 405: 'method-not-allowed', 409: 'request-id-conflict', 413: 'too-large', 400: 'rejected-as-not-matching-cid' }[res.status];
    throw new YataverseError(why ? `put-${why}` : 'put-failed', `HTTP ${res.status}`);
  }

  /** Write bytes, verify the receipt, then read them back and verify. -> {cid, verified, bytes, receipt...} */
  async function putBytes(bytes, { codec = 'raw', requestId, lease } = {}) {
    if (!(codec in WRITABLE_CODECS)) throw new YataverseError('put-codec-not-accepted', codec);
    const cid = cidFor(bytes, WRITABLE_CODECS[codec]);
    // With a lease (a full envelope: requester and verifier signatures) the write asks for a
    // retention promise. Check the lease against the host's published keys and against these bytes
    // before sending anything.
    let leaseChecked = null, leaseHeader;
    if (lease) {
      try { leaseChecked = await verifyLease(lease, await receiptKeys()); }
      catch (e) { if (e instanceof RetentionError) throw new YataverseError(`lease-${e.code}`); throw e; }
      const subject = cidToBytes(cid);
      if (leaseChecked.subject.length !== subject.length || !leaseChecked.subject.every((x, i) => x === subject[i])) throw new YataverseError('lease-is-for-another-block');
      if (leaseChecked.size !== bytes.length) throw new YataverseError('lease-size-mismatch');
      leaseHeader = Buffer.from(leaseEnvelopeToDagCbor(lease).bytes).toString('base64url');
    }
    const put = await putBlock(cid, bytes, { requestId, leaseHeader });
    const receipt = await checkReceipt(put.body, { kind: KIND.block, subject: cidToBytes(cid), contentDigest: new Uint8Array(parseCid(cid).digest),
      size: bytes.length, requestId: put.requestId, requester: requesterOf(put.auth) });
    let archive;
    if (leaseChecked) {
      // The answer must be the retention promise that was asked for, not an ordinary gateway receipt.
      if (!receipt.receiptVerified) throw new YataverseError('leased-put-without-receipt');
      const r = envelopeFromJson(put.body.receipt).receipt;
      if (r.storeClass !== STORE_CLASS.operatorArchive) throw new YataverseError('leased-put-answered-without-a-retention-receipt');
      try { receiptCountsFor(r, leaseChecked); } catch (e) { if (e instanceof RetentionError) throw new YataverseError(`leased-put-${e.code}`); throw e; }
      const a = put.body.archive;
      archive = { versionId: typeof a?.versionId === 'string' ? a.versionId : null, lockMode: typeof a?.lockMode === 'string' ? a.lockMode : null,
                  retentionUntil: new Date(r.retentionUntil).toISOString(), leaseId: '0x' + Buffer.from(r.leaseId).toString('hex') };
    }
    const back = await get(cid);
    if (!back) throw new YataverseError('readback-absent');
    return { cid, verified: true, bytes: bytes.length, ...receipt, ...(archive ? { archive } : {}) };
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
  async function putCar(bytes, { requestId } = {}) {
    const local = checkCarLocally(bytes);
    const rid = newRequestId(requestId);
    if (!authorize) throw new YataverseError('no-authorization-configured');
    const auth = await authorize({ resource: carResource(crypto.createHash('sha256').update(bytes).digest('hex')) });
    const base = new URL(cfg.url);
    if (!okScheme(base)) throw new YataverseError('write-url-not-https');
    const res = await fetchImpl(new URL(cfg.prefix, base), {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(120_000),
      headers: { authorization: auth, 'content-type': CAR_CONTENT_TYPE, [REQUEST_ID_HEADER]: rid.toString('hex') }, body: bytes,
    });
    if (REDIRECTS.has(res.status)) throw new YataverseError('car-put-redirected', 'a write is never followed to another host');
    let j = null; try { j = await res.json(); } catch { /* not JSON */ }
    if (res.status !== 201) throw new YataverseError('car-put-failed', `HTTP ${res.status}${j?.error ? ` ${j.error}` : ''}`);
    let size = 0; for (const b of local.blocks.values()) size += b.length;
    const external = Array.isArray(j?.external) ? j.external.map(String) : [];
    const receipt = await checkReceipt(j, { kind: KIND.car, subject: rootsCommitment(local.roots),
      contentDigest: blockSetDigest([...local.blocks.keys(), ...external]), size, requestId: rid, requester: requesterOf(auth) });
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
    return { roots: local.roots, blocks: local.blocks.size, external: j?.external ?? [], verified: true, ...receipt };
  }

  // --- Retention status records (docs/retention-design.md §6) ---

  /** Publish a verifier-signed status for its lease. The host checks it; it does not judge the lease. */
  async function publishStatus(leaseEnv, statusEnv) {
    if (!authorize) throw new YataverseError('no-authorization-configured');
    const base = new URL(cfg.url);
    if (!okScheme(base)) throw new YataverseError('write-url-not-https');
    const leaseId = Buffer.from(leaseEnv.lease.leaseId).toString('hex');
    const res = await fetchImpl(new URL(`/retention/v1/status/${leaseId}`, base), { method: 'PUT', redirect: 'manual', signal: timeout(),
      headers: { authorization: await authorize(), 'content-type': 'application/json' },
      body: JSON.stringify({ lease: leaseEnvelopeToJson(leaseEnv), status: statusEnvelopeToJson(statusEnv) }) });
    const j = await jsonOrNull(res);
    if (res.status !== 200) {
      const code = typeof j?.error === 'string' && /^[a-z0-9-]{1,80}$/.test(j.error) ? j.error : `http-${res.status}`;
      throw new YataverseError(`publish-status-${code}`, `HTTP ${res.status}`);
    }
    const local = statusEnvelopeToDagCbor(statusEnv).cid;
    if (j?.statusCid !== local) throw new YataverseError('publish-status-cid-mismatch');
    return { leaseId: '0x' + leaseId, statusCid: local, stored: true, ...(j.repeated ? { repeated: true } : {}) };
  }

  /**
   * Fetch the published status of a lease ({ leaseId: 64 hex }) or of a block ({ cid }) and verify
   * it here: the lease's signatures, the verifier key, and the status against the lease and `now`.
   * What the host says is not trusted. -> { lease, status, leaseEnv, statusEnv } or null when absent.
   */
  async function fetchStatus({ leaseId, cid, now }) {
    const base = new URL(cfg.readUrl ?? cfg.url);
    if (!okScheme(base)) throw new YataverseError('read-url-not-https');
    let pathname;
    if (leaseId !== undefined) {
      const m = /^(?:0x)?([0-9a-f]{64})$/.exec(String(leaseId).toLowerCase());
      if (!m) throw new YataverseError('bad-lease-id');
      pathname = `/.well-known/yataverse-retention/${m[1]}.json`;
    } else {
      if (!isCidShape(cid)) throw new YataverseError('bad-cid');
      pathname = `/retention/${cid}`;
    }
    const res = await fetchImpl(new URL(pathname, base), { redirect: 'manual', signal: timeout(), headers: { accept: 'application/json' } });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new YataverseError('status-fetch-failed', `HTTP ${res.status}`);
    const j = await jsonOrNull(res);
    let leaseEnv, statusEnv, lease, status;
    try {
      leaseEnv = leaseEnvelopeFromJson(j?.lease); statusEnv = statusEnvelopeFromJson(j?.status);
      lease = await verifyLease(leaseEnv, await receiptKeys());
      status = await verifyStatus(statusEnv, lease, await receiptKeys(), { now });
    } catch (e) { if (e instanceof RetentionError) throw new YataverseError(`status-${e.code}`); throw e; }
    // The record must be the one that was asked for.
    if (leaseId !== undefined && Buffer.from(lease.leaseId).toString('hex') !== String(leaseId).toLowerCase().replace(/^0x/, '')) throw new YataverseError('status-is-for-another-lease');
    if (cid !== undefined) {
      const want = cidToBytes(cid);
      if (lease.subject.length !== want.length || !lease.subject.every((x, i) => x === want[i])) throw new YataverseError('status-is-for-another-block');
    }
    return { lease, status, leaseEnv, statusEnv };
  }

  return { get, putBlock, putBytes, verifyRemote, getCar, putCar, receiptKeys, checkReceipt, publishStatus, fetchStatus };
}
