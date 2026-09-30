import http from 'node:http';
import crypto from 'node:crypto';
import { siweMessage } from '../src/cacao.mjs';

// minimal CBOR reader for the CACAO profile (text, arrays, maps)
function readCbor(buf) {
  let i = 0;
  const arg = (info) => { if (info < 24) return info; if (info === 24) return buf[i++]; if (info === 25) { const n = (buf[i] << 8) | buf[i + 1]; i += 2; return n; } throw new Error('cbor'); };
  const val = () => {
    const b = buf[i++]; const major = b >> 5; const n = arg(b & 31);
    if (major === 3) { const s = buf.subarray(i, i + n).toString('utf8'); i += n; return s; }
    if (major === 4) return Array.from({ length: n }, val);
    if (major === 5) { const o = {}; for (let k = 0; k < n; k++) { const key = val(); o[key] = val(); } return o; }
    throw new Error('cbor major ' + major);
  };
  return val();
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex; return Buffer.from(hex, 'hex');
}
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** Verify a session CACAO the way Authn would: rebuild the SIWE text from the decoded payload. */
export function verifySessionCacao(b64, { audience, domain }) {
  const env = readCbor(Buffer.from(b64, 'base64'));
  const p = env.p, sig = Buffer.from(env.s.s, 'base64');
  if (p.aud !== audience || p.domain !== domain) return { ok: false, why: 'aud/domain' };
  if (Date.parse(p.exp) < Date.now() || Date.parse(p.iat) > Date.now() + 60_000) return { ok: false, why: 'time' };
  const raw = b58decode(p.iss.replace(/^did:key:z/, '')).subarray(2);
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
  const ok = crypto.verify(null, Buffer.from(siweMessage(p), 'utf8'), key, sig);
  return { ok, iss: p.iss };
}

export function startAuthn() {
  const state = { tenants: [], sas: [], nonces: new Set(), log: [] };
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const body = (() => { try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; } })();
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      state.log.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/v1/cacao/session') {
        const v = verifySessionCacao(body.cacao_b64 ?? '', { audience: origin, domain: '127.0.0.1' });
        if (!v.ok) return send(401, { error: 'bad cacao' });
        state.did = v.iss;
        return send(200, { user: { id: 'u_1' } }, { 'set-cookie': 'gftd_session=sess-abc123; Path=/; HttpOnly; Secure' });
      }
      // every other route is a cookie-authenticated, same-origin JSON mutation
      if (!/(^|;\s*)gftd_session=sess-abc123/.test(req.headers.cookie ?? '')) return send(401, { error: 'not signed in' });
      if (req.method !== 'GET' && (req.headers.origin !== origin || !/json/.test(req.headers['content-type'] ?? '')))
        return send(403, { error: 'same-origin json only' });
      const u = req.url;
      if (u === '/v1/tenants' && req.method === 'GET') return send(200, { memberships: state.tenants.map((t) => ({ tenantId: t.id, role: 'owner' })) });
      if (u === '/v1/tenants' && req.method === 'POST') {
        const t = { id: `t_${'abcdef012345'.slice(0, 11)}${++n}`.padEnd(14, '0'), did: `did:key:tenant${n}`, name: body.name };
        state.tenants.push(t); return send(201, { tenant: t, membership: { tenantId: t.id, role: 'owner' } });
      }
      let m;
      if ((m = /^\/v1\/tenants\/(t_[a-z0-9]{12,48})\/service-accounts$/.exec(u))) {
        if (!state.tenants.some((t) => t.id === m[1])) return send(403, { error: 'not authorized' });
        if (req.method === 'GET') return send(200, { serviceAccounts: state.sas.map(({ secret, ...pub }) => pub) });
        const sa = { id: `sa_${'0123456789ab'.slice(0, 11)}${++n}`.padEnd(15, '0'), name: body.name, tenantId: m[1] };
        state.sas.push({ ...sa, secret: `kb_sa_ISSUED_${n}` });
        return send(201, { serviceAccount: sa, token: `kb_sa_ISSUED_${n}` });
      }
      if ((m = /^\/v1\/tenants\/(t_[a-z0-9]{12,48})\/service-accounts\/(sa_[a-z0-9]{12,48})\/rotate$/.exec(u)) && req.method === 'POST') {
        const sa = state.sas.find((x) => x.id === m[2]); if (!sa) return send(404, { error: 'not found' });
        sa.secret = `kb_sa_ROTATED_${++n}`; return send(200, { serviceAccount: { id: sa.id, name: sa.name }, token: sa.secret });
      }
      if ((m = /^\/v1\/tenants\/(t_[a-z0-9]{12,48})\/service-accounts\/(sa_[a-z0-9]{12,48})$/.exec(u)) && req.method === 'DELETE') {
        state.sas = state.sas.filter((x) => x.id !== m[2]); return send(200, { ok: true });
      }
      send(404, { error: 'no route' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port,
    origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}
