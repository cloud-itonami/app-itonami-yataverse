import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, baseCfg } from './helpers.mjs';
import { rawCid } from '../src/cid.mjs';
import { makeClient, parentDomain, YataverseError } from '../src/client.mjs';
import { makeAuthorizer } from '../src/auth.mjs';

const T = { allowInsecureForTests: true };
const withServer = async (mode, fn) => { const s = await startServer(mode); try { await fn(s); } finally { await s.close(); } };

test('parentDomain', () => {
  assert.equal(parentDomain('abc.ipfs.yataverse.com'), 'yataverse.com');
  assert.equal(parentDomain('ipfs.yataverse.com'), 'yataverse.com');
  assert.equal(parentDomain('yataverse.com'), 'yataverse.com');
  assert.equal(parentDomain('127.0.0.1'), '127.0.0.1');
});

test('put then read back verifies (static authorisation)', () => withServer('ok', async (s) => {
  const cfg = { ...baseCfg(s.origin), staticAuth: 'Bearer good' };
  const client = makeClient(cfg, { authorize: makeAuthorizer(cfg, T), ...T });
  const r = await client.putBytes(Buffer.from('hello block'));
  assert.deepEqual(r, { cid: rawCid(Buffer.from('hello block')), verified: true, bytes: 11 });
  const put = s.log.find((x) => x.method === 'PUT');
  assert.equal(put.ct, 'application/vnd.ipld.raw');
  assert.equal(put.auth, 'Bearer good');
}));

test('a same-host redirect on read is followed and verified', () => withServer('redirect', async (s) => {
  const cfg = { ...baseCfg(s.origin), staticAuth: 'Bearer good' };
  const client = makeClient(cfg, { authorize: makeAuthorizer(cfg, T), ...T });
  await client.putBytes(Buffer.from('via redirect'));
  const got = await client.get(rawCid(Buffer.from('via redirect')));
  assert.equal(got.toString(), 'via redirect');
}));

test('an off-domain redirect on read is refused', () => withServer('redirect-off', async (s) => {
  const client = makeClient(baseCfg(s.origin), T);
  await assert.rejects(client.get(rawCid(Buffer.from('x'))), (e) => e.code === 'redirect-off-domain');
}));

test('redirect loops stop', () => withServer('loop', async (s) => {
  await assert.rejects(makeClient(baseCfg(s.origin), T).get(rawCid(Buffer.from('x'))), (e) => e.code === 'too-many-redirects');
}));

test('served bytes that do not hash to the CID are refused', () => withServer('corrupt', async (s) => {
  const cfg = { ...baseCfg(s.origin), staticAuth: 'Bearer good' };
  s.blobs.set(rawCid(Buffer.from('real')), Buffer.from('real'));
  await assert.rejects(makeClient(cfg, T).get(rawCid(Buffer.from('real'))), (e) => e.code === 'cid-mismatch');
}));

test('absent is null, not empty bytes', () => withServer('ok', async (s) => {
  assert.equal(await makeClient(baseCfg(s.origin), T).get(rawCid(Buffer.from('nothing here'))), null);
}));

test('size cap on read', () => withServer('big', async (s) => {
  const cid = rawCid(Buffer.alloc(2048, 1));
  s.blobs.set(cid, Buffer.alloc(2048, 1));
  await assert.rejects(makeClient(baseCfg(s.origin), T).get(cid, { maxBytes: 1024 }), (e) => e.code === 'too-large');
}));

test('a write is never followed to another host', () => withServer('put-redirect', async (s) => {
  const cfg = { ...baseCfg(s.origin), staticAuth: 'Bearer good' };
  const client = makeClient(cfg, { authorize: makeAuthorizer(cfg, T), ...T });
  await assert.rejects(client.putBytes(Buffer.from('x')), (e) => e.code === 'put-redirected');
  assert.equal(s.log.filter((x) => x.method === 'PUT').length, 1);
}));

test('bad credentials, bad CIDs and mismatched bytes are refused before or at the wire', () => withServer('ok', async (s) => {
  const cfg = { ...baseCfg(s.origin), staticAuth: 'Bearer wrong' };
  const client = makeClient(cfg, { authorize: makeAuthorizer(cfg, T), ...T });
  await assert.rejects(client.putBytes(Buffer.from('x')), (e) => e.code === 'put-unauthorized');
  await assert.rejects(client.putBlock('../evil', Buffer.from('x')), (e) => e.code === 'bad-cid');
  await assert.rejects(client.putBlock(rawCid(Buffer.from('a')), Buffer.from('b')), (e) => e.code === 'bytes-do-not-hash-to-cid');
  await assert.rejects(makeClient(baseCfg(s.origin), T).putBytes(Buffer.from('x')), (e) => e.code === 'no-authorization-configured');
}));
