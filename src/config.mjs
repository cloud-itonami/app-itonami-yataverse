// Configuration: ~/.config/yataverse (or $YATAVERSE_CONFIG_DIR). Secrets live in their
// own 0600 files and are NEVER echoed: status() names sources, never values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_URL = 'https://kotobase.net';
export const DEFAULT_READ_URL = 'https://ipfs.yataverse.com';
export const DEFAULT_PREFIX = '/ipfs/';
export const DEFAULT_AUTHN = 'https://auth.kotoba.cloud';

export const configDir = (env = process.env) =>
  env.YATAVERSE_CONFIG_DIR || path.join(os.homedir(), '.config', 'yataverse');

const SA_PATTERN = /^kb_sa_[A-Za-z0-9._-]+$/;
const TENANT_PATTERN = /^t_[A-Za-z0-9_-]+$/;

export class ConfigError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

const isHttpsOrigin = (u) => /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(u);
const isPrefix = (p) => /^\/[A-Za-z0-9._/-]*\/$/.test(p) && !p.includes('..');

/** Refuse a secret file that group/other can read (or that is not a plain file). */
function readSecretFile(file) {
  if (!fs.existsSync(file)) return null;
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new ConfigError('secret-file-not-a-regular-file', path.basename(file));
  if (st.mode & 0o077) throw new ConfigError('secret-file-permissions', `${path.basename(file)} must be mode 0600`);
  return fs.readFileSync(file, 'utf8').trim();
}

/** Load and validate. Returns a plain object; secrets are present but never logged. */
export function loadConfig(env = process.env) {
  const dir = configDir(env);
  const jsonFile = path.join(dir, 'config.json');
  const file = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')) : {};
  const cfg = {
    url: env.YATAVERSE_URL || file.url || DEFAULT_URL,
    readUrl: env.YATAVERSE_READ_URL || file.readUrl || DEFAULT_READ_URL,
    prefix: env.YATAVERSE_PREFIX || file.prefix || DEFAULT_PREFIX,
    authnUrl: file.authnUrl || DEFAULT_AUTHN,
    tenantId: env.YATAVERSE_TENANT_ID || file.tenantId || null,
    storage: env.YATAVERSE_STORAGE || file.storage || null,
    permissions: file.permissions || null,
    authCmd: null, saToken: null, staticAuth: null,
  };
  if (env.YATAVERSE_AUTH_CMD) {
    try { cfg.authCmd = JSON.parse(env.YATAVERSE_AUTH_CMD); } catch { throw new ConfigError('auth-cmd-not-json'); }
  } else if (file.authCmd) cfg.authCmd = file.authCmd;
  cfg.saToken = env.YATAVERSE_SA_TOKEN || readSecretFile(path.join(dir, 'sa-token'));
  cfg.staticAuth = env.YATAVERSE_AUTH || readSecretFile(path.join(dir, 'auth'));
  validate(cfg);
  return cfg;
}

export function validate(cfg) {
  if (!isHttpsOrigin(cfg.url)) throw new ConfigError('url-not-https-origin');
  if (!isHttpsOrigin(cfg.readUrl)) throw new ConfigError('read-url-not-https-origin');
  if (!isHttpsOrigin(cfg.authnUrl)) throw new ConfigError('authn-url-not-https-origin');
  if (!isPrefix(cfg.prefix)) throw new ConfigError('prefix-invalid');
  if (cfg.tenantId && !TENANT_PATTERN.test(cfg.tenantId)) throw new ConfigError('tenant-id-invalid');
  if (cfg.saToken && !SA_PATTERN.test(cfg.saToken)) throw new ConfigError('sa-token-bad-shape');
  if (cfg.authCmd && !(Array.isArray(cfg.authCmd) && cfg.authCmd.length && cfg.authCmd.every((x) => typeof x === 'string')))
    throw new ConfigError('auth-cmd-not-an-argv-array');
  return cfg;
}

/** Which way a write would be authorised — names only. */
export function authSource(cfg) {
  if (cfg.authCmd) return 'auth-cmd';
  if (cfg.saToken && cfg.tenantId) return 'service-account';
  if (cfg.staticAuth) return 'static';
  return null;
}

export function status(cfg) {
  return { url: cfg.url, readUrl: cfg.readUrl, prefix: cfg.prefix, authnUrl: cfg.authnUrl,
           tenantId: cfg.tenantId, storage: cfg.storage, authSource: authSource(cfg),
           writeConfigured: authSource(cfg) !== null,
           saTokenPresent: Boolean(cfg.saToken) };
}

/** Write config (non-secret) and, if given, the service-account secret (0600, dir 0700). */
export function saveConfig({ url, readUrl, prefix, tenantId, storage, saToken }, env = process.env) {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const jsonFile = path.join(dir, 'config.json');
  const cur = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')) : {};
  const next = { ...cur };
  for (const [k, v] of Object.entries({ url, readUrl, prefix, tenantId, storage })) if (v !== undefined) next[k] = v;
  validate({ ...loadShape(next), saToken: saToken ?? null });
  writeAtomic(jsonFile, JSON.stringify(next, null, 2) + '\n', 0o600);
  if (saToken !== undefined) {
    if (!SA_PATTERN.test(saToken)) throw new ConfigError('sa-token-bad-shape');
    writeAtomic(path.join(dir, 'sa-token'), saToken + '\n', 0o600);
  }
  return dir;
}

const loadShape = (f) => ({
  url: f.url || DEFAULT_URL, readUrl: f.readUrl || DEFAULT_READ_URL, prefix: f.prefix || DEFAULT_PREFIX,
  authnUrl: f.authnUrl || DEFAULT_AUTHN, tenantId: f.tenantId || null, storage: f.storage || null,
  authCmd: f.authCmd || null,
});

function writeAtomic(file, content, mode) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}
