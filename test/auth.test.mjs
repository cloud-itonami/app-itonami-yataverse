import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, baseCfg } from './helpers.mjs';
import { makeAuthorizer, runAuthCmd, AuthError } from '../src/auth.mjs';

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
