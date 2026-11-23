import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, baseCfg } from './helpers.mjs';
import { makeAuthorizer, runAuthCmd, AuthError } from '../src/auth.mjs';
import { loadConfig, authSource } from '../src/config.mjs';
import { keyFromSeed, newSeed } from '../src/cacao.mjs';

const T = { allowInsecureForTests: true, authnHosts: new Set(['127.0.0.1']) };

test('a service-account secret is exchanged for a Biscuit and cached until near expiry', async () => {
  const s = await startServer('ok');
  try {
    let t = 1_000_000;
    const cfg = { ...baseCfg(s.origin), tenantId: 't_abc', storage: 'blocks', saToken: 'kb_sa_good' };
    const authorize = makeAuthorizer(cfg, { ...T, now: () => t });
    assert.equal(await authorize(), 'Biscuit tok1');
    assert.equal(await authorize(), 'Biscuit tok1');                       // cached
    t += 13 * 60_000; assert.equal(await authorize(), 'Biscuit tok1');     // 13 min: still inside 15 min - 60 s
    t += 90_000; assert.equal(await authorize(), 'Biscuit tok2');          // past the skew: re-minted
    assert.equal(s.log.filter((x) => x.method === 'POST').length, 2);
  } finally { await s.close(); }
});

test('the secret only goes to an allowed Authn host, over https', async () => {
  const cfg = { ...baseCfg('http://127.0.0.1:1'), tenantId: 't_abc', saToken: 'kb_sa_good' };
  await assert.rejects(makeAuthorizer(cfg, { allowInsecureForTests: true })(), (e) => e.code === 'authn-host-not-allowed');   // default allow-list
  await assert.rejects(makeAuthorizer(cfg, { authnHosts: new Set(['127.0.0.1']) })(), (e) => e.code === 'authn-host-not-allowed'); // http without the test flag
});

test('Authn refusing (not a tenant member) is reported, not swallowed', async () => {
  const s = await startServer('ok');
  try {
    const cfg = { ...baseCfg(s.origin), tenantId: 't_abc', saToken: 'kb_sa_wrong' };
    await assert.rejects(makeAuthorizer(cfg, T)(), (e) => e.code === 'authn-refused');
  } finally { await s.close(); }
});

test('the auth command runs as argv without a shell', () => {
  assert.equal(runAuthCmd(['printf', 'Biscuit abc']), 'Biscuit abc');
  assert.equal(runAuthCmd(['printf', 'a;echo pwned']), 'a;echo pwned');
  assert.throws(() => runAuthCmd(['printf', 'two\nlines']), (e) => e.code === 'auth-cmd-bad-output');
  assert.throws(() => runAuthCmd(['printf', '']), (e) => e.code === 'auth-cmd-bad-output');
});

test('with nothing configured a write is refused', async () => {
  await assert.rejects(makeAuthorizer(baseCfg('https://x.example'))(), (e) => e.code === 'no-authorization-configured');
});

test('tokens present only in the environment are ignored by default, honoured with the flag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-env-'));
  try {
    const env = { YATAVERSE_CONFIG_DIR: dir, YATAVERSE_SA_TOKEN: 'kb_sa_good', YATAVERSE_AUTH: 'Bearer x' };
    const ignored = loadConfig(env);
    assert.equal(ignored.saToken, null);
    assert.equal(ignored.staticAuth, null);
    assert.equal(authSource(ignored), null);
    await assert.rejects(makeAuthorizer(ignored)(), (e) => e.code === 'no-authorization-configured');
    const allowed = loadConfig({ ...env, YATAVERSE_ALLOW_BEARER: '1' });
    assert.equal(allowed.saToken, 'kb_sa_good');
    assert.equal(allowed.staticAuth, 'Bearer x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a CACAO writer key selects CACAO by default, with a fresh nonce per call', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    n += 1;
    return { status: 200, json: async () => ({ nonce: `testnonce${n}testnonce${n}testnonce`, expiresAt: new Date().toISOString() }) };
  };
  const key = keyFromSeed(newSeed());
  const cfg = { ...baseCfg('https://yataverse.com') };   // no authMode: the key alone selects CACAO
  const authorize = makeAuthorizer(cfg, { fetchImpl, cacaoKey: key });
  const a = await authorize({ resource: 'yataverse:put:bafkreiaaa' });
  const b = await authorize({ resource: 'yataverse:put:bafkreiaaa' });
  assert.match(a, /^CACAO [A-Za-z0-9+/]{16,}={0,2}$/);
  assert.match(b, /^CACAO [A-Za-z0-9+/]{16,}={0,2}$/);
  assert.notEqual(a, b);                                  // fresh nonce: no CACAO is minted twice
  assert.equal(authorize.requesterDid, key.did);
  assert.equal(n, 2);
});
