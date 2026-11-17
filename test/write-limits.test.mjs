import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handle } from '../worker/src/index.mjs';
import { rawCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';
import { ENV, TOKEN, NOW, fakeStore, fakeLimiter, dataKeys } from './worker-fixtures.mjs';

const deps = (s) => ({ fetchImpl: s.fetchImpl, now: NOW });
const ip = (n) => `203.0.113.${n}`;
const putBlock = (bytes, from) => new Request(`https://yataverse.com/ipfs/${rawCid(bytes)}`, { method: 'PUT', body: bytes,
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw', 'cf-connecting-ip': from } });
const pack = fs.readFileSync(new URL('./fixtures/drive-v1.car', import.meta.url));
const packId = crypto.createHash('sha256').update(pack).digest('hex');
const putPack = (from) => new Request(`https://yataverse.com/awai-drive/v1/packs/${packId}`, { method: 'PUT', body: pack,
  headers: { 'content-type': 'application/vnd.ipld.car', origin: 'http://tauri.localhost', 'cf-connecting-ip': from } });

test('writes beyond the per-client request budget are 429 and store nothing; other clients are unaffected', async () => {
  const s = fakeStore(); const env = { ...ENV, WRITE_REQUEST_LIMITER: fakeLimiter(2) };
  for (const i of [1, 2]) assert.equal((await handle(putBlock(Buffer.from(`block ${i}`), ip(1)), env, deps(s))).status, 201);
  const r = await handle(putBlock(Buffer.from('block 3'), ip(1)), env, deps(s));
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60');
  assert.equal((await r.json()).error, 'write-rate-limited');
  assert.equal(dataKeys(s).length, 2);
  assert.equal((await handle(putBlock(Buffer.from('block 3'), ip(2)), env, deps(s))).status, 201);
});

test('the byte budget counts started MiB per client and is checked before storing', async () => {
  const s = fakeStore(); const mib = fakeLimiter(3);
  const env = { ...ENV, WRITE_MIB_LIMITER: mib, MAX_BLOCK_BYTES: String(4 * 1024 * 1024) };
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);                    // 3 started MiB
  assert.equal((await handle(putBlock(big, ip(3)), env, deps(s))).status, 201);
  assert.equal(mib.used.get(ip(3)), 3);
  const r = await handle(putBlock(Buffer.from('tiny'), ip(3)), env, deps(s));
  assert.equal(r.status, 429); assert.equal((await r.json()).error, 'write-bytes-limited');
  assert.equal(dataKeys(s).length, 1);
});

test('CAR imports and Drive pack uploads are limited the same way; Drive keeps its CORS header on 429', async () => {
  const s = fakeStore(); const env = { ...ENV, WRITE_REQUEST_LIMITER: fakeLimiter(1) };
  const leaf = Buffer.from('car leaf'); const car = encodeCarV1([rawCid(leaf)], [{ cid: rawCid(leaf), bytes: leaf }]);
  const post = () => new Request('https://yataverse.com/ipfs/', { method: 'POST', body: car,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.car', 'cf-connecting-ip': ip(4) } });
  assert.equal((await handle(post(), env, deps(s))).status, 201);
  assert.equal((await handle(post(), env, deps(s))).status, 429);
  const env2 = { ...ENV, WRITE_REQUEST_LIMITER: fakeLimiter(1) };
  assert.equal((await handle(putPack(ip(5)), env2, deps(s))).status, 200);
  const r = await handle(putPack(ip(5)), env2, deps(s));
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
  assert.equal(r.headers.get('retry-after'), '60');
});

test('writes fail closed without the limiter bindings; reads are not limited', async () => {
  const s = fakeStore(); const env = { ...ENV }; delete env.WRITE_MIB_LIMITER;
  const r = await handle(putBlock(Buffer.from('x'), ip(6)), env, deps(s));
  assert.equal(r.status, 503); assert.equal((await r.json()).error, 'write-limits-not-configured');
  assert.equal((await handle(putPack(ip(6)), env, deps(s))).status, 503);
  assert.equal(dataKeys(s).length, 0);
  const none = { ...ENV, WRITE_REQUEST_LIMITER: fakeLimiter(0) };
  assert.equal((await handle(new Request(`https://yataverse.com/ipfs/${rawCid(Buffer.from('x'))}`), none, deps(s))).status, 404);
});
