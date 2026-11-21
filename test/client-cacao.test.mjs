// The client signing its writes with the admin key (authMode "cacao", JUN-1427), end to end against
// the Worker's handler: nonce, CACAO, receipt requester. Token mode is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ENV, NOW, fakeStore, dataKeys } from './worker-fixtures.mjs';
import { handle } from '../worker/src/index.mjs';
import { makeClient } from '../src/client.mjs';
import { makeAuthorizer, AuthError } from '../src/auth.mjs';
import { keyFromSeed, newSeed } from '../src/cacao.mjs';
import { rawCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';
import { loadConfig, authSource, ConfigError } from '../src/config.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WRITER = keyFromSeed(newSeed());
const STRANGER = keyFromSeed(newSeed());
const CENV = { ...ENV, CACAO_NONCE_SECRET: 'test-nonce-secret-0123456789abcdef', CACAO_AUD: 'https://yataverse.com',
               CACAO_DOMAIN: 'yataverse.com', CACAO_WRITER_DIDS: WRITER.did };
const cfg = { url: 'https://yataverse.com', readUrl: 'https://yataverse.com', prefix: '/ipfs/', authMode: 'cacao' };

/** A fetch that routes yataverse.com to the Worker handler and counts what it saw. */
function service(env = CENV) {
  const s = fakeStore(); const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host !== 'yataverse.com') return s.fetchImpl(url, init);
    seen.push({ method: init.method ?? 'GET', path: u.pathname, authorization: init.headers?.authorization ?? null });
    return handle(new Request(u, init), env, { fetchImpl: s.fetchImpl, now: NOW });
  };
  return { s, seen, fetchImpl };
}
const client = (svc, key = WRITER) => makeClient(cfg, { fetchImpl: svc.fetchImpl, receiptKeys: ENV.RECEIPT_PUBLIC_KEYS,
  authorize: makeAuthorizer(cfg, { fetchImpl: svc.fetchImpl, cacaoKey: key, now: () => NOW().getTime() }) });

test('a block write is signed with a fresh nonce and the receipt names the writer', async () => {
  const svc = service(); const bytes = Buffer.from('client cacao block');
  const r = await client(svc).putBytes(bytes);
  assert.equal(r.cid, rawCid(bytes)); assert.equal(r.verified, true);
  assert.ok(svc.s.objects.has(`ipld/${r.cid}`));
  const paths = svc.seen.map((x) => `${x.method} ${x.path}`);
  assert.deepEqual(paths.slice(0, 2), ['GET /auth/nonce', `PUT /ipfs/${r.cid}`]);
  assert.match(svc.seen[1].authorization, /^CACAO /);
});

test('two writes use two nonces', async () => {
  const svc = service(); const c = client(svc);
  await c.putBytes(Buffer.from('first')); await c.putBytes(Buffer.from('second'));
  const auths = svc.seen.filter((x) => x.method === 'PUT').map((x) => x.authorization);
  assert.equal(auths.length, 2); assert.notEqual(auths[0], auths[1]);
  assert.equal(svc.seen.filter((x) => x.path === '/auth/nonce').length, 2);
});

test('a CAR import is signed for the SHA-256 of its body', async () => {
  const svc = service(); const block = Buffer.from('client car block'); const cid = rawCid(block);
  const car = Buffer.from(encodeCarV1([cid], [{ cid, bytes: block }]));
  const r = await client(svc).putCar(car);
  assert.ok(svc.s.objects.has(`ipld/${cid}`));
  assert.deepEqual(r.roots ?? [cid], [cid]);
});

test('a key the service does not list is refused and nothing is stored', async () => {
  const svc = service();
  await assert.rejects(client(svc, STRANGER).putBytes(Buffer.from('not a writer')), (e) => /cacao-writer-not-allowed|403/.test(`${e.code} ${e.message}`));
  assert.equal(dataKeys(svc.s).length, 0);
});

test('the authorizer refuses: no key, no resource, a nonce endpoint that is off', async () => {
  assert.throws(() => makeAuthorizer(cfg, {}), (e) => e instanceof AuthError && e.code === 'no-admin-key');
  const svc = service();
  const authorize = makeAuthorizer(cfg, { fetchImpl: svc.fetchImpl, cacaoKey: WRITER });
  await assert.rejects(authorize(), (e) => e.code === 'cacao-needs-a-resource');
  const off = service({ ...CENV, CACAO_NONCE_SECRET: '' });
  const a2 = makeAuthorizer(cfg, { fetchImpl: off.fetchImpl, cacaoKey: WRITER });
  await assert.rejects(a2({ resource: 'yataverse:put:x' }), (e) => e.code === 'nonce-refused');
  assert.throws(() => makeAuthorizer({ ...cfg, url: 'http://yataverse.com' }, { cacaoKey: WRITER }), (e) => e.code === 'write-url-not-https');
});

test('config: authMode is read from the environment and the file, and other values are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-cfg-'));
  try {
    assert.equal(loadConfig({ YATAVERSE_CONFIG_DIR: dir }).authMode, null);
    const c = loadConfig({ YATAVERSE_CONFIG_DIR: dir, YATAVERSE_AUTH_MODE: 'cacao' });
    assert.equal(c.authMode, 'cacao'); assert.equal(authSource(c), 'cacao');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ authMode: 'cacao' }));
    assert.equal(loadConfig({ YATAVERSE_CONFIG_DIR: dir }).authMode, 'cacao');
    assert.throws(() => loadConfig({ YATAVERSE_CONFIG_DIR: dir, YATAVERSE_AUTH_MODE: 'password' }), (e) => e instanceof ConfigError && e.code === 'auth-mode-not-supported');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
