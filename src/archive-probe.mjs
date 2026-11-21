// Read-only probe of the operator's archive bucket through an S3-compatible API
// (docs/retention-design.md §8). It reads an object's length and Object Lock retention from a
// HEAD response and, when asked, the object itself. It never writes, deletes or changes a lock.
//
// Checked against Backblaze B2 on 2026-11-21 (docs/retention-design.md §16, AWAI-3673): HEAD returns
// x-amz-object-lock-mode and x-amz-object-lock-retain-until-date to a key with readFiles and
// readFileRetentions. Two limits found there:
// - Without a versionId the probe sees the newest version of a name. A later unlocked write of the
//   same name, or a hide marker, makes a locked older version invisible that way, so the check fails
//   (never passes wrongly). Pass the versionId returned by the locking write to check that version.
// - Without listBuckets, B2 answers 403 instead of 404 for a missing object; head() then throws
//   instead of reporting the object as absent. (listFiles does not change that: AWAI-3754, AWAI-3769.)
import { signV4, regionFromEndpoint } from './sigv4.mjs';

export class ArchiveProbeError extends Error { constructor(code) { super(code); this.code = code; } }
const bad = (code) => { throw new ArchiveProbeError(code); };
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TIMEOUT_MS = 30_000;

/**
 * makeArchiveProbe({ endpoint, bucket, prefix, keyId, secret, region?, fetchImpl?, now?, maxBytes? })
 * Object key = prefix + CID. -> { head(cid, { versionId }), read(cid, { versionId }) } for runVerifierOnce.
 */
export function makeArchiveProbe({ endpoint, bucket, prefix = '', keyId, secret, region, fetchImpl = fetch, now = () => new Date(), maxBytes = 16 * 1024 * 1024 }) {
  if (!endpoint || !bucket || !keyId || !secret) bad('archive-probe-not-configured');
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) bad('archive-endpoint-not-https');
  const reg = region || regionFromEndpoint(endpoint) || bad('archive-region-unknown');
  const urlFor = (cid, versionId) => {
    if (!/^[a-z2-7]{20,120}$/.test(cid)) bad('bad-cid');
    const u = new URL(`/${bucket}/${prefix}${cid}`, base);
    if (versionId !== undefined) {
      if (typeof versionId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(versionId)) bad('bad-version-id');
      u.searchParams.set('versionId', versionId);
    }
    return u.toString();
  };
  const send = (method, url) => fetchImpl(url, { method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: signV4({ method, url, payloadHash: EMPTY_SHA256, keyId, secret, region: reg, now: now() }) });
  return {
    async head(cid, { versionId } = {}) {
      const res = await send('HEAD', urlFor(cid, versionId));
      if (res.status === 404) return null;
      if (res.status !== 200) bad(`head-http-${res.status}`);
      const len = res.headers.get('content-length');
      const until = res.headers.get('x-amz-object-lock-retain-until-date');
      const t = until ? Date.parse(until) : NaN;
      return { size: /^\d+$/.test(len ?? '') ? Number(len) : -1,
               lockMode: res.headers.get('x-amz-object-lock-mode') ?? '',
               retainUntil: Number.isFinite(t) ? t : null,
               versionId: res.headers.get('x-amz-version-id') ?? '' };
    },
    async read(cid, { versionId } = {}) {
      const res = await send('GET', urlFor(cid, versionId));
      if (res.status !== 200) bad(`get-http-${res.status}`);
      const len = Number(res.headers.get('content-length') ?? -1);
      if (len > maxBytes) bad('object-too-large');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) bad('object-too-large');
      return bytes;
    },
  };
}
