import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAuthn } from './fake-authn.mjs';
import { baseCfg } from './helpers.mjs';
import { keygen, adminStatus, makeAdmin, loadKey } from '../src/admin.mjs';
import { keyFromSeed, mintDirect, base58btc } from '../src/cacao.mjs';
import { loadConfig } from '../src/config.mjs';
import { callTool } from '../src/mcp.mjs';
import { main } from '../src/cli.mjs';

const T = { allowInsecureForTests: true, authnHosts: new Set(['127.0.0.1']) };
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-adm-')); return { dir: d, env: { ...process.env, YATAVERSE_CONFIG_DIR: d } }; };
const mode = (f) => fs.statSync(f).mode & 0o777;

test('keygen makes a 0600 key, prints only the did, and refuses to overwrite', () => {
  const { dir, env } = tmp();
  const { did } = keygen(env);
  assert.match(did, /^did:key:z6Mk/);
  assert.equal(mode(path.join(dir, 'admin.key')), 0o600);
  assert.equal(loadKey(env).did, did);
  assert.throws(() => keygen(env), (e) => e.code === 'admin-key-exists');
  assert.ok(!JSON.stringify(adminStatus(env)).match(/[0-9a-f]{64}/));
});

test('did:key derivation and base58 are standard', () => {
  assert.equal(base58btc(Buffer.from('hello world')), 'StV1DL6CwTryKyV');
  assert.equal(base58btc(Buffer.from([0, 0, 1])), '112');
  assert.match(keyFromSeed(Buffer.alloc(32, 1)).did, /^did:key:z6Mk/);
});

test('login signs a CACAO Authn verifies, stores the session 0600', async () => {
  const a = await startAuthn(); const { dir, env } = tmp();
  try {
    const { did } = keygen(env);
    const admin = makeAdmin({ ...baseCfg(a.origin), authnUrl: a.origin }, { env, ...T });
    assert.deepEqual(await admin.login(), { did, signedIn: true });
    assert.equal(a.state.did, did);                                     // the fake verified the ed25519 signature
    assert.equal(mode(path.join(dir, 'session')), 0o600);
    assert.equal(adminStatus(env).session.fresh, true);
  } finally { await a.close(); }
});

test('the full admin flow: tenant, service account (secret stored not returned), rotate, revoke', async () => {
  const a = await startAuthn(); const { dir, env } = tmp();
  try {
    keygen(env);
    const admin = makeAdmin({ ...baseCfg(a.origin), authnUrl: a.origin }, { env, ...T });
    await admin.login();
    const { tenant } = await admin.tenantCreate('Murakumo Web');
    assert.match(tenant.id, /^t_[a-z0-9]{12,48}$/);
    assert.equal((await admin.tenantList()).length, 1);

    const made = await admin.saCreate(tenant.id, { name: 'web-node-benjamin', storage: 'blocks' });
    assert.equal(made.stored, true);
    assert.ok(!JSON.stringify(made).includes('kb_sa_'), 'the secret must not be returned');
    assert.equal(mode(path.join(dir, 'sa-token')), 0o600);
    const cfg = loadConfig(env);
    assert.equal(cfg.saToken, 'kb_sa_ISSUED_2');
    assert.equal(cfg.tenantId, tenant.id); assert.equal(cfg.storage, 'blocks');

    const listed = await admin.saList(tenant.id);
    assert.equal(listed.length, 1); assert.ok(!JSON.stringify(listed).includes('kb_sa_'));

    const rotated = await admin.saRotate(tenant.id, made.serviceAccount.id);
    assert.ok(!JSON.stringify(rotated).includes('kb_sa_'));
    assert.match(loadConfig(env).saToken, /^kb_sa_ROTATED_/);

    assert.deepEqual(await admin.saRevoke(tenant.id, made.serviceAccount.id), { revoked: made.serviceAccount.id });
    assert.equal((await admin.saList(tenant.id)).length, 0);
  } finally { await a.close(); }
});

test('only --print reveals the secret', async () => {
  const a = await startAuthn(); const { env } = tmp();
  try {
    keygen(env);
    const admin = makeAdmin({ ...baseCfg(a.origin), authnUrl: a.origin }, { env, ...T });
    await admin.login();
    const { tenant } = await admin.tenantCreate('t');
    const r = await admin.saCreate(tenant.id, { name: 'n', reveal: true });
    assert.match(r.token, /^kb_sa_ISSUED_/);
  } finally { await a.close(); }
});

test('refusals: not signed in, no key, bad ids, wrong host, foreign tenant', async () => {
  const a = await startAuthn(); const { env } = tmp();
  try {
    const cfg = { ...baseCfg(a.origin), authnUrl: a.origin };
    const admin = makeAdmin(cfg, { env, ...T });
    await assert.rejects(admin.login(), (e) => e.code === 'no-admin-key');
    await assert.rejects(admin.tenantList(), (e) => e.code === 'not-signed-in');
    keygen(env); await admin.login();
    await assert.rejects(admin.tenantCreate('bad/name'), (e) => e.code === 'bad-name');
    await assert.rejects(admin.saList('../x'), (e) => e.code === 'bad-tenant-id');
    await assert.rejects(admin.saRevoke('t_abcdefabcdef1', '../x'), (e) => e.code === 'bad-service-account-id');
    await assert.rejects(admin.saList('t_zzzzzzzzzzzz9'), (e) => e.code === 'forbidden');
    await assert.rejects(makeAdmin({ ...cfg, authnUrl: 'https://evil.example' }, { env }).login(), (e) => e.code === 'authn-host-not-allowed');
    await assert.rejects(makeAdmin(cfg, { env }).login(), (e) => e.code === 'authn-host-not-allowed');   // http, default allow-list
  } finally { await a.close(); }
});

test('a session file readable by others is refused', async () => {
  const { dir, env } = tmp();
  fs.writeFileSync(path.join(dir, 'session'), 'x\n', { mode: 0o644 });
  const admin = makeAdmin({ ...baseCfg('https://auth.kotoba.cloud'), authnUrl: 'https://auth.kotoba.cloud' }, { env });
  await assert.rejects(admin.tenantList(), (e) => e.code === 'secret-file-permissions');
});

test('the direct-profile CACAO has the {t,s} signature map and no header', () => {
  const k = keyFromSeed(Buffer.alloc(32, 9));
  const c = mintDirect(k, { aud: 'did:web:kotobase.net', domain: 'kotobase.net', resources: ['kotoba://can/kotobase:pin'] });
  const raw = Buffer.from(c.cacaoB64, 'base64');
  assert.ok(raw.includes(Buffer.from('EdDSA')));
  assert.ok(!raw.includes(Buffer.from('caip122')));
});

test('MCP admin tools: confirm required, secret stored not returned, credential-like args refused', async () => {
  const a = await startAuthn(); const { env } = tmp();
  try {
    keygen(env);
    const cfg = { ...baseCfg(a.origin), authnUrl: a.origin };
    const deps = { cfg, env, admin: T };
    assert.match((await callTool('yataverse_admin_login', { confirm: false }, deps)).text, /confirm-required/);
    assert.equal((await callTool('yataverse_admin_login', { confirm: true }, deps)).isError, false);
    const t = JSON.parse((await callTool('yataverse_tenant_create', { name: 'via mcp', confirm: true }, deps)).text);
    const sa = await callTool('yataverse_sa_create', { tenant: t.tenant.id, name: 'agent-made', confirm: true }, deps);
    assert.equal(sa.isError, false);
    assert.ok(!sa.text.includes('kb_sa_'));
    assert.match(loadConfig(env).saToken, /^kb_sa_ISSUED_/);
    assert.match((await callTool('yataverse_sa_create', { tenant: t.tenant.id, name: 'x', token: 'kb_sa_x', confirm: true }, deps)).text, /credentials never travel/);
    assert.match((await callTool('yataverse_sa_revoke', { tenant: t.tenant.id, id: 'sa_0123456789ab0', confirm: false }, deps)).text, /confirm-required/);
    assert.doesNotMatch((await callTool('yataverse_admin_status', {}, deps)).text, /[0-9a-f]{64}/);
  } finally { await a.close(); }
});

test('CLI: admin keygen / whoami never print the seed', async () => {
  const { env } = tmp();
  const prev = process.env.YATAVERSE_CONFIG_DIR; process.env.YATAVERSE_CONFIG_DIR = env.YATAVERSE_CONFIG_DIR;
  try {
    let out = ''; const io = { stdout: { write: (x) => { out += x; } }, stderr: { write: () => {} } };
    assert.equal(await main(['admin', 'keygen'], io), 0);
    assert.equal(await main(['admin', 'whoami'], io), 0);
    assert.ok(!/[0-9a-f]{64}/.test(out));
    assert.match(out, /did:key:z6Mk/);
  } finally { if (prev === undefined) delete process.env.YATAVERSE_CONFIG_DIR; else process.env.YATAVERSE_CONFIG_DIR = prev; }
});
