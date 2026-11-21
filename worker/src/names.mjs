// Name plane: serve a published site at {name}<suffix> (for example tsukuru.itonami.app).
//
//   GET|HEAD https://{name}{suffix}/{path}
//     1. read the TXT record _dnslink.{name}{suffix} over DNS-over-HTTPS
//     2. it must hold exactly one `dnslink=/ipfs/<CIDv1>[/path]`
//     3. walk the UnixFS directory from that CID and return the file
//
// Read-only: no other method is answered on a name host, so the write and receipt routes of
// the bytes plane are not reachable there. Every block is read through the bytes plane's
// verified read path, so the bytes served always hash to the CID the name points at.
//
// Off unless NAME_PLANE_SUFFIXES names at least one suffix (comma-separated, each starting
// with "."). Only a single label under a suffix is a name host.
import { parseCid, SHA2_256, CODEC_DAG_PB } from '../../src/cid.mjs';
import { resolvePath, readFile, UnixfsError } from '../../src/unixfs.mjs';

export const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 5_000;
const DNSLINK_TTL_MS = 60_000;
const DNSLINK_CACHE_MAX = 512;
const MAX_PATH_SEGMENTS = 32;
export const DEFAULT_NAME_MAX_FILE_BLOCKS = 128;
export const DEFAULT_NAME_MAX_FILE_BYTES = 32 * 1024 * 1024;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', wasm: 'application/wasm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  edn: 'application/edn; charset=utf-8', kotoba: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
};
const typeOf = (name) => TYPES[(/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream';

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const fail = (status, error, extra) => json(status, { error }, extra);
const intVar = (v, dflt) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : dflt; };

export function nameSuffixes(env) {
  return String(env.NAME_PLANE_SUFFIXES ?? '').split(',').map((s) => s.trim().toLowerCase())
    .filter((s) => /^\.[a-z0-9.-]+$/.test(s) && !s.includes('..'));
}

/** true when `hostname` is one label under a configured suffix. */
export function isNameHost(hostname, env) {
  const host = String(hostname).toLowerCase();
  return nameSuffixes(env).some((s) => host.endsWith(s) && LABEL.test(host.slice(0, -s.length)));
}

/**
 * true when `hostname` is a configured suffix's own domain or anything under it. Such a host
 * is either a name host or nothing: the bytes-plane API is never served there, so a wildcard
 * route for the suffix cannot expose the API on unexpected hosts (the apex, deeper labels).
 */
export function underNameSuffix(hostname, env) {
  const host = String(hostname).toLowerCase();
  return nameSuffixes(env).some((s) => host.endsWith(s) || host === s.slice(1));
}

const cache = new Map();   // host -> { at, value }
/** For tests: forget cached DNSLink answers. */
export function clearNameCache() { cache.clear(); }

// A TXT answer's data is one or more quoted strings; a long record is split and must be joined.
function txtValue(data) {
  const parts = [...String(data).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : String(data);
}

/** -> { root, base: [segments] } or { error: [status, code] }. */
async function resolveDnslink(host, env, deps) {
  const now = deps.now().getTime();
  const hit = cache.get(host);
  if (hit && now - hit.at < DNSLINK_TTL_MS) return hit.value;
  const doh = new URL(env.NAME_PLANE_DOH_URL || DEFAULT_DOH_URL);
  if (doh.protocol !== 'https:') return { error: [500, 'doh-not-https'] };
  doh.searchParams.set('name', `_dnslink.${host}`);
  doh.searchParams.set('type', 'TXT');
  let res;
  try {
    res = await deps.fetchImpl(doh.toString(), { headers: { accept: 'application/dns-json' }, redirect: 'manual',
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS) });
  } catch { return { error: [504, 'dns-unreachable'] }; }
  if (res.status !== 200) return { error: [502, `dns-failed-${res.status}`] };
  let body;
  try { body = await res.json(); } catch { return { error: [502, 'dns-answer-not-json'] }; }
  // Status 0 is NOERROR, 3 is NXDOMAIN. Anything else (SERVFAIL, ...) is not a "no such name".
  if (body?.Status !== 0 && body?.Status !== 3) return { error: [502, `dns-status-${Number(body?.Status)}`] };
  const links = (Array.isArray(body.Answer) ? body.Answer : []).filter((a) => a?.type === 16)
    .map((a) => txtValue(a.data)).filter((v) => v.startsWith('dnslink='));
  let value;
  if (links.length === 0) value = { error: [404, 'name-not-published'] };
  else if (links.length > 1) value = { error: [502, 'dnslink-ambiguous'] };
  else value = parseDnslink(links[0].slice('dnslink='.length));
  // Cache a clear answer, including "not published"; never a transport or server failure.
  if (cache.size >= DNSLINK_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(host, { at: now, value });
  return value;
}

export function parseDnslink(target) {
  if (target.startsWith('/ipns/')) return { error: [501, 'dnslink-ipns-not-supported'] };
  const m = /^\/ipfs\/([a-z2-7]{20,120})((?:\/[^/]+)*)\/?$/.exec(target);
  if (!m) return { error: [502, 'dnslink-not-ipfs-cidv1'] };
  const p = parseCid(m[1]);
  if (!p || p.version !== 1 || p.hashCode !== SHA2_256) return { error: [502, 'dnslink-not-ipfs-cidv1'] };
  const base = segmentsOf(m[2]);
  if (!base) return { error: [502, 'dnslink-path-not-accepted'] };
  return { root: m[1], base };
}

/** URL path -> decoded segments, or null when a part is empty, ".", "..", or holds "/", "\" or NUL. */
function segmentsOf(pathname) {
  const out = [];
  for (const raw of pathname.split('/').filter((s, i, a) => !(s === '' && (i === 0 || i === a.length - 1)))) {
    let s;
    try { s = decodeURIComponent(raw); } catch { return null; }
    if (!s || s === '.' || s === '..' || /[/\\\0]/.test(s)) return null;
    out.push(s);
  }
  return out.length > MAX_PATH_SEGMENTS ? null : out;
}

/** Walk a file's chunk tree; raw leaves are checked by CID only, intermediate nodes are loaded. */
async function checkChunks(node, load, denied) {
  for (const c of node.chunks ?? []) {
    const d = denied(c.cid);
    if (d) throw new LoadError(...d);
    if (parseCid(c.cid)?.codec !== CODEC_DAG_PB) continue;
    const at = await resolvePath(c.cid, [], load);
    if (at) await checkChunks(at.node, load, denied);
  }
}

class LoadError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

/**
 * Answer a request on a name host. `readBlock(cid)` is the bytes plane's verified read:
 * -> { bytes } | { absent: true } | { error: [status, code] }.
 */
export async function handleName(request, url, env, deps, readBlock, denied = null) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method-not-allowed', { allow: 'GET, HEAD' });
  const head = request.method === 'HEAD';
  const segments = segmentsOf(url.pathname);
  if (!segments) return fail(400, 'bad-path');
  const link = await resolveDnslink(url.hostname.toLowerCase(), env, deps);
  if (link.error) return fail(...link.error);
  const load = async (cid) => {
    const r = await readBlock(cid);
    if (r.error) throw new LoadError(...r.error);
    return r.absent ? null : r.bytes;
  };
  try {
    let at = await resolvePath(link.root, [...link.base, ...segments], load);
    if (!at) return fail(404, 'not-found');
    let name = segments[segments.length - 1] ?? '';
    if (at.node.type === 'directory') {
      if (!url.pathname.endsWith('/')) {
        return new Response(null, { status: 301, headers: { location: `${url.pathname}/${url.search}`, 'cache-control': 'public, max-age=300' } });
      }
      const index = at.node.entries.find((e) => e.name === 'index.html');
      if (!index) return fail(404, 'no-index');
      at = await resolvePath(index.cid, [], load);
      name = 'index.html';
    }
    // With a read deny list (AWAI-3629), check every chunk of the file before any answer, so a
    // denied leaf also makes HEAD and 304 a 451, not only GET. Raw leaves are not fetched:
    // `denied(cid)` -> null or [status, code], without a store read.
    if (denied) await checkChunks(at.node, load, denied);
    const headers = {
      'content-type': typeOf(name), 'content-length': String(at.node.size), etag: `"${at.cid}"`,
      'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff',
      'x-ipfs-path': `/ipfs/${link.root}${[...link.base, ...segments].map((s) => `/${encodeURIComponent(s)}`).join('')}`,
      'x-ipfs-roots': link.root,
    };
    const inm = request.headers.get('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === headers.etag)) {
      const { 'content-type': _t, 'content-length': _l, ...rest } = headers;
      return new Response(null, { status: 304, headers: rest });
    }
    if (head) return new Response(null, { status: 200, headers });
    const bytes = await readFile(at.node, load, {
      maxBlocks: intVar(env.NAME_PLANE_MAX_FILE_BLOCKS, DEFAULT_NAME_MAX_FILE_BLOCKS),
      maxBytes: intVar(env.NAME_PLANE_MAX_FILE_BYTES, DEFAULT_NAME_MAX_FILE_BYTES),
    });
    return new Response(bytes, { status: 200, headers });
  } catch (e) {
    if (e instanceof LoadError) return fail(e.status, e.code);
    if (e instanceof UnixfsError) {
      if (e.code === 'file-too-large' || e.code === 'file-has-too-many-blocks') return fail(413, e.code);
      // The name points at content this store does not hold in full, or that is not UnixFS.
      return fail(502, `site-${e.code}`);
    }
    throw e;
  }
}
