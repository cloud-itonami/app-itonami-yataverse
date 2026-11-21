// The gateway's ordinary B2 key (docs/gateway-b2-key.md; AWAI-3754): the Worker only reads and
// writes single objects under its prefix. The shared fake stores check every request the suite
// makes; this file checks the store layer's source and that the check itself bites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertGatewayKeyIsEnough, fakeStore, ENV, NOW, TOKEN } from './worker-fixtures.mjs';
import { handle } from '../worker/src/index.mjs';
import { rawCid } from '../src/cid.mjs';

const SRC = fs.readFileSync(new URL('../worker/src/index.mjs', import.meta.url), 'utf8');

test('the store layer sends only GET, HEAD and PUT, and only its lock credential locks or names a version', () => {
  const store = SRC.slice(SRC.indexOf('function b2(env, deps)'), SRC.indexOf('function serveBlock'));
  assert.ok(store.length > 500, 'store layer found');
  const ordinary = [...store.matchAll(/(?<![A-Za-z])call\('([A-Z]+)'[^\n]*/g)];
  const locking = [...store.matchAll(/lockCall\('([A-Z]+)'[^\n]*/g)];
  assert.ok(ordinary.length >= 8 && locking.length === 3, `${ordinary.length} ordinary, ${locking.length} locking`);
  for (const m of [...ordinary, ...locking]) assert.ok(['GET', 'HEAD', 'PUT'].includes(m[1]), m[0]);
  for (const m of ordinary) assert.doesNotMatch(m[0], /versionId|object-lock/, m[0]);
  // No other code path signs a store request: signV4 is used once, inside the store layer.
  assert.equal(SRC.split('signV4(').length - 1, 1);
  assert.ok(store.includes('signV4('));
});

test('a block write, read, head and miss stay within what the key allows', async () => {
  const s = fakeStore(); const body = Buffer.from('within the key'); const cid = rawCid(body);
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const put = await handle(new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'PUT', body,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } }), ENV, deps);
  assert.equal(put.status, 201);
  assert.equal((await handle(new Request(`https://yataverse.com/ipfs/${cid}`), ENV, deps)).status, 200);
  assert.equal((await handle(new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'HEAD' }), ENV, deps)).status, 200);
  const b2 = s.log.filter((r) => r.host === 's3.us-west-004.backblazeb2.com');
  assert.ok(b2.length >= 4);
  assert.deepEqual([...new Set(b2.map((r) => r.method))].sort(), ['GET', 'HEAD', 'PUT'].filter((m) => b2.some((r) => r.method === m)));
  assert.ok(b2.every((r) => r.path.startsWith('/bucket/ipld/')));
});

test('the check refuses what the key does not allow', () => {
  const u = (p) => new URL(`https://s3.us-west-004.backblazeb2.com${p}`);
  assertGatewayKeyIsEnough(u('/bucket/ipld/bafk'), 'PUT', { 'content-type': 'x' });
  assert.throws(() => assertGatewayKeyIsEnough(u('/bucket/ipld/bafk'), 'DELETE'), /does not allow DELETE/);
  assert.throws(() => assertGatewayKeyIsEnough(u('/bucket/ipld/bafk'), 'POST'), /does not allow POST/);
  assert.throws(() => assertGatewayKeyIsEnough(u('/bucket/other/bafk'), 'GET'), /outside the key's prefix/);
  assert.throws(() => assertGatewayKeyIsEnough(u('/bucket/ipld/'), 'GET'), /outside the key's prefix/);
  assert.throws(() => assertGatewayKeyIsEnough(u('/other-bucket/ipld/bafk'), 'GET'), /outside the key's prefix/);
  assert.throws(() => assertGatewayKeyIsEnough(u('/bucket/ipld/?list-type=2'), 'GET'), /outside|by name only/);
  assert.throws(() => assertGatewayKeyIsEnough(u('/bucket/ipld/bafk?versionId=v1'), 'GET'), /by name only/);
  assert.throws(() => assertGatewayKeyIsEnough(u('/bucket/ipld/bafk'), 'PUT', { 'x-amz-object-lock-mode': 'COMPLIANCE' }), /does not allow x-amz-object-lock-mode/);
  assert.throws(() => assertGatewayKeyIsEnough(u('/bucket/ipld/bafk'), 'PUT', { 'x-amz-copy-source': '/a/b' }), /does not allow/);
});
