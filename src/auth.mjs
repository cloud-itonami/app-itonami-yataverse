// Where a write's Authorization comes from. Order: operator minter command, tenant
// service-account secret (exchanged at Authn for a short-lived Biscuit), static value.
// Nothing here mints a credential: a service-account secret is issued by a tenant admin.
import { execFileSync } from 'node:child_process';

export class AuthError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

export const DEFAULT_AUTHN_HOSTS = Object.freeze(new Set(['auth.kotoba.cloud']));
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_TTL_MS = 14 * 60_000;

const oneLine = (s) => typeof s === 'string' && s.length > 0 && s.length <= 8192 && !/[\r\n\u0000]/.test(s);

export function runAuthCmd(argv, { exec = execFileSync } = {}) {
  // argv, no shell: metacharacters in an argument stay data
  const out = exec(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const v = String(out).trim();
  if (!oneLine(v)) throw new AuthError('auth-cmd-bad-output');
  return v;
}

/**
 * -> async () => "Biscuit ..." | "CACAO ..." | static value. Throws AuthError if none is configured.
 * `allowInsecureForTests` exists for the unit tests' local fake Authn only; the CLI and
 * MCP never set it and it cannot be set from the environment.
 */
export function makeAuthorizer(cfg, { fetchImpl = fetch, now = Date.now, exec = execFileSync,
                                      authnHosts = DEFAULT_AUTHN_HOSTS, allowInsecureForTests = false } = {}) {
  let cache = null;
  return async function authorize() {
    if (cfg.authCmd) return runAuthCmd(cfg.authCmd, { exec });

    if (cfg.saToken && cfg.tenantId) {
      if (cache && now() < cache.until) return cache.value;
      const u = new URL(cfg.authnUrl);
      if (!(u.protocol === 'https:' || (allowInsecureForTests && u.protocol === 'http:')) || !authnHosts.has(u.hostname))
        throw new AuthError('authn-host-not-allowed', u.hostname);
      const body = { tenantId: cfg.tenantId };
      if (cfg.storage) body.storage = cfg.storage;
      if (cfg.permissions?.length) body.permissions = cfg.permissions;
      const res = await fetchImpl(new URL('/v1/biscuit/token', u), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${cfg.saToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status !== 201) throw new AuthError('authn-refused', `HTTP ${res.status}`);
      let j; try { j = await res.json(); } catch { throw new AuthError('authn-bad-response'); }
      const value = j.authorization || (j.token ? `Biscuit ${j.token}` : null);
      if (!oneLine(value)) throw new AuthError('authn-bad-response');
      const ttl = Number.isFinite(j.expiresIn) ? j.expiresIn * 1000 : DEFAULT_TTL_MS;
      cache = { value, until: now() + Math.max(0, ttl - REFRESH_SKEW_MS) };
      return value;
    }

    if (cfg.staticAuth) return cfg.staticAuth;
    throw new AuthError('no-authorization-configured');
  };
}
