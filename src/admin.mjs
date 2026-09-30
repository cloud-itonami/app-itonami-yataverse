// Authn administration: sign in with the operator's OWN ed25519 key, create tenants, issue and
// rotate tenant service-account secrets (kb_sa_...). Endpoints from the Authn worker
// (net-kotobase/control-plane authn/src/authn/worker.cljk):
//   POST /v1/cacao/session            sign in (a first sign-in CREATES the account)
//   GET|POST /v1/tenants              list / create
//   GET|POST /v1/tenants/:t/members   list / add
//   GET|POST /v1/tenants/:t/service-accounts, POST .../:sa/rotate, DELETE .../:sa
// The service-account secret is returned by Authn exactly once; callers store it (0600) and never
// print or return it. Nothing here bypasses Authn's own authorisation: a caller who is not an admin
// of the tenant is refused by Authn, not by this file.
import fs from 'node:fs';
import path from 'node:path';
import { keyFromSeed, newSeed, mintSession } from './cacao.mjs';
import { configDir } from './config.mjs';
import { DEFAULT_AUTHN_HOSTS } from './auth.mjs';

export class AdminError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

const TENANT_ID = /^t_[a-z0-9]{12,48}$/;
const SA_ID = /^sa_[a-z0-9]{12,48}$/;
const SA_SECRET = /^kb_sa_[A-Za-z0-9._-]+$/;
const NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;
const SESSION_COOKIE = 'gftd_session';
const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const files = (env = process.env) => {
  const d = configDir(env);
  return { dir: d, key: path.join(d, 'admin.key'), session: path.join(d, 'session'), saToken: path.join(d, 'sa-token'), json: path.join(d, 'config.json') };
};

function writeSecret(file, content, dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }); fs.chmodSync(dirPath, 0o700);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 }); fs.renameSync(tmp, file);
}

function readSecret(file) {
  if (!fs.existsSync(file)) return null;
  const st = fs.lstatSync(file);
  if (!st.isFile() || (st.mode & 0o077)) throw new AdminError('secret-file-permissions', `${path.basename(file)} must be a regular file, mode 0600`);
  return fs.readFileSync(file, 'utf8').trim();
}

/** Generate the admin key once (refuses to overwrite). Returns the did:key only, never the seed. */
export function keygen(env = process.env) {
  const f = files(env);
  if (fs.existsSync(f.key)) throw new AdminError('admin-key-exists', 'refusing to overwrite');
  const seed = newSeed();
  writeSecret(f.key, seed.toString('hex') + '\n', f.dir);
  return { did: keyFromSeed(seed).did };
}

export function loadKey(env = process.env) {
  const s = readSecret(files(env).key);
  if (!s) return null;
  if (!/^[0-9a-f]{64}$/.test(s)) throw new AdminError('admin-key-malformed');
  return keyFromSeed(s);
}

export function adminStatus(env = process.env) {
  const f = files(env); let key = null, session = null;
  try { key = loadKey(env); } catch (e) { return { keyPresent: true, error: e.code }; }
  if (fs.existsSync(f.session)) {
    const age = Date.now() - fs.statSync(f.session).mtimeMs;
    session = { present: true, fresh: age < SESSION_MAX_AGE_MS };
  }
  return { keyPresent: Boolean(key), did: key?.did ?? null, session: session ?? { present: false, fresh: false } };
}

export function makeAdmin(cfg, { fetchImpl = fetch, env = process.env, authnHosts = DEFAULT_AUTHN_HOSTS,
                                 allowInsecureForTests = false } = {}) {
  const f = files(env);
  const origin = new URL(cfg.authnUrl);
  const guard = () => {
    if (!(origin.protocol === 'https:' || (allowInsecureForTests && origin.protocol === 'http:')) || !authnHosts.has(origin.hostname))
      throw new AdminError('authn-host-not-allowed', origin.hostname);
  };
  const timeout = () => AbortSignal.timeout(30_000);

  async function login() {
    guard();
    const key = loadKey(env);
    if (!key) throw new AdminError('no-admin-key', 'run: yataverse admin keygen');
    const c = mintSession(key, { aud: origin.origin, domain: origin.hostname, resources: [], ttlSec: 300 });
    const res = await fetchImpl(new URL('/v1/cacao/session', origin), {
      method: 'POST', redirect: 'manual', signal: timeout(),
      headers: { 'content-type': 'application/json', origin: origin.origin },
      body: JSON.stringify({ cacao_b64: c.cacaoB64 }),
    });
    if (res.status < 200 || res.status >= 300) throw new AdminError('login-refused', `HTTP ${res.status}`);
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie().join(', ') : (res.headers.get('set-cookie') ?? '');
    const m = new RegExp(`(?:^|[,;\\s])${SESSION_COOKIE}=([^;,\\s]+)`).exec(setCookie);
    if (!m) throw new AdminError('login-no-session-cookie');
    writeSecret(f.session, m[1] + '\n', f.dir);
    let viewer = null; try { viewer = await res.json(); } catch { /* cookie is what matters */ }
    // Authn's viewer JSON names the account; a node's owner needs it to add the node to a tenant.
    const userId = viewer?.user?.id ?? viewer?.id ?? null;
    return { did: key.did, signedIn: true, ...(userId ? { userId } : {}) };
  }

  async function call(method, urlPath, body) {
    guard();
    const cookie = readSecret(f.session);
    if (!cookie) throw new AdminError('not-signed-in', 'run: yataverse admin login');
    const res = await fetchImpl(new URL(urlPath, origin), {
      method, redirect: 'manual', signal: timeout(),
      // Authn accepts cookie-authenticated MUTATIONS only as same-origin JSON: every non-GET carries
      // an Origin and a JSON body, DELETE included (an empty object).
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, origin: origin.origin, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
      body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* empty body */ }
    if (res.status === 401) throw new AdminError('not-signed-in', 'session rejected; run: yataverse admin login');
    if (res.status === 403) throw new AdminError('forbidden', json?.error ?? '');
    if (res.status < 200 || res.status >= 300) throw new AdminError('authn-refused', `HTTP ${res.status}${json?.error ? ' ' + json.error : ''}`);
    return json ?? {};
  }

  const tenant = (t) => { if (!TENANT_ID.test(t ?? '')) throw new AdminError('bad-tenant-id'); return t; };
  const name = (n) => { if (!NAME.test(n ?? '')) throw new AdminError('bad-name'); return n; };

  /** Store the one-time secret 0600 and (optionally) make this tenant the default. Returns nothing secret. */
  function storeSecret(secret, tenantId, storage) {
    if (!SA_SECRET.test(secret ?? '')) throw new AdminError('authn-returned-no-usable-secret');
    writeSecret(f.saToken, secret + '\n', f.dir);
    const cur = fs.existsSync(f.json) ? JSON.parse(fs.readFileSync(f.json, 'utf8')) : {};
    const next = { ...cur, tenantId, ...(storage ? { storage } : {}) };
    writeSecret(f.json, JSON.stringify(next, null, 2) + '\n', f.dir);
  }

  /**
   * One idempotent pass: admin key -> sign in -> tenant -> service account -> secret stored 0600.
   * SIGN-IN CREATES AN ACCOUNT on first use, so `yes` must be passed deliberately (the CLI's --yes, the
   * MCP tool's confirm=true). Re-running reuses the tenant and service account it made; it never issues a
   * second service account it could not store the secret of. Returns names and ids, never a secret.
   */
  async function bootstrap({ yes = false, tenantName = 'yataverse', saName = 'yataverse-node', storage, role } = {}) {
    if (yes !== true) throw new AdminError('confirmation-required', 'sign-in creates an account: pass --yes');
    const steps = [];
    if (!loadKey(env)) { steps.push({ step: 'keygen', did: keygen(env).did }); } else steps.push({ step: 'keygen', skipped: 'key exists' });
    const who = await login(); steps.push({ step: 'login', did: who.did, ...(who.userId ? { userId: who.userId } : {}) });

    const cfgFile = fs.existsSync(f.json) ? JSON.parse(fs.readFileSync(f.json, 'utf8')) : {};
    const memberships = await (async () => (await call('GET', '/v1/tenants')).memberships ?? [])();
    const known = cfgFile.tenantId && memberships.some((m) => (m.tenantId ?? m.tenant_id) === cfgFile.tenantId);
    let tenantId = known ? cfgFile.tenantId : null;
    if (tenantId) steps.push({ step: 'tenant', tenantId, skipped: 'already a member' });
    else { const t = await (async () => { const j = await call('POST', '/v1/tenants', { name: name(tenantName) }); return j.tenant; })();
           tenantId = t.id; steps.push({ step: 'tenant', tenantId, created: true }); }

    const haveSecret = Boolean(readSecret(f.saToken));
    const existing = (await call('GET', `/v1/tenants/${tenant(tenantId)}/service-accounts`)).serviceAccounts ?? [];
    let saId = existing.find((x) => x.name === saName)?.id ?? null;
    if (saId && haveSecret) steps.push({ step: 'service-account', id: saId, skipped: 'exists and its secret is stored here' });
    else {
      const made = await (async () => {
        const j = await call('POST', `/v1/tenants/${tenantId}/service-accounts`, { name: name(saName), ...(role ? { role } : {}) });
        storeSecret(j.token, tenantId, storage); return j.serviceAccount;
      })();
      saId = made.id; steps.push({ step: 'service-account', id: saId, created: true, secretStored: true });
    }
    if (storage) tenantUseInternal(tenantId, storage);
    return { did: who.did, ...(who.userId ? { userId: who.userId } : {}), tenantId, serviceAccountId: saId, secretStored: true, steps };
  }

  function tenantUseInternal(t, storage) {
    const cur = fs.existsSync(f.json) ? JSON.parse(fs.readFileSync(f.json, 'utf8')) : {};
    writeSecret(f.json, JSON.stringify({ ...cur, tenantId: t, ...(storage ? { storage } : {}) }, null, 2) + '\n', f.dir);
  }

  return {
    login, bootstrap,
    tenantList: async () => (await call('GET', '/v1/tenants')).memberships ?? [],
    tenantCreate: async (n) => { const j = await call('POST', '/v1/tenants', { name: name(n) }); return { tenant: j.tenant, membership: j.membership }; },
    memberList: async (t) => (await call('GET', `/v1/tenants/${tenant(t)}/members`)).members ?? [],
    memberAdd: async (t, { userId, role, permissions }) => {
      if (!/^[A-Za-z0-9_-]{3,80}$/.test(userId ?? '')) throw new AdminError('bad-user-id');
      return (await call('POST', `/v1/tenants/${tenant(t)}/members`, { user_id: userId, ...(role ? { role } : {}), ...(permissions ? { permissions } : {}) })).membership;
    },
    saList: async (t) => (await call('GET', `/v1/tenants/${tenant(t)}/service-accounts`)).serviceAccounts ?? [],
    /** Create a service account. The secret is stored (0600), never returned; pass {reveal:true} (CLI --print only) to get it. */
    saCreate: async (t, { name: n, role, permissions, storage, reveal = false }) => {
      const j = await call('POST', `/v1/tenants/${tenant(t)}/service-accounts`, { name: name(n), ...(role ? { role } : {}), ...(permissions ? { permissions } : {}) });
      storeSecret(j.token, t, storage);
      return { serviceAccount: j.serviceAccount, stored: true, ...(reveal ? { token: j.token } : {}) };
    },
    saRotate: async (t, id, { storage, reveal = false } = {}) => {
      if (!SA_ID.test(id ?? '')) throw new AdminError('bad-service-account-id');
      const j = await call('POST', `/v1/tenants/${tenant(t)}/service-accounts/${id}/rotate`, {});
      storeSecret(j.token, t, storage);
      return { serviceAccount: j.serviceAccount, stored: true, ...(reveal ? { token: j.token } : {}) };
    },
    saRevoke: async (t, id) => {
      if (!SA_ID.test(id ?? '')) throw new AdminError('bad-service-account-id');
      await call('DELETE', `/v1/tenants/${tenant(t)}/service-accounts/${id}`); return { revoked: id };
    },
    /** Point this machine's default tenant/storage at an existing tenant. */
    tenantUse: (t, storage) => {
      const cur = fs.existsSync(f.json) ? JSON.parse(fs.readFileSync(f.json, 'utf8')) : {};
      writeSecret(f.json, JSON.stringify({ ...cur, tenantId: tenant(t), ...(storage ? { storage } : {}) }, null, 2) + '\n', f.dir);
      return { tenantId: t, storage: storage ?? cur.storage ?? null };
    },
  };
}
