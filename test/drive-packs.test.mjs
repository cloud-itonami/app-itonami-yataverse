import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handle } from '../worker/src/index.mjs';
import { parseCar } from '../src/car.mjs';
import { ENV, NOW, fakeStore, dataKeys } from './worker-fixtures.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DRIVE_ORIGIN = 'http://tauri.localhost';
const deps = (s) => ({ fetchImpl: s.fetchImpl, now: NOW });
const url = (id) => `https://yataverse.com/awai-drive/v1/packs/${id}`;

// The request exactly as Drive's sync.js sends it: PUT/GET, no query, no credentials,
// Content-Type application/vnd.ipld.car on upload, from the Drive WebView origin.
const drivePut = (bytes, id = sha(bytes)) => new Request(url(id), { method: 'PUT', body: bytes,
  headers: { origin: DRIVE_ORIGIN, 'Content-Type': 'application/vnd.ipld.car' } });
const driveGet = (id) => new Request(url(id), { headers: { origin: DRIVE_ORIGIN } });

/** Drive's own receipt check (sync.js): bounded JSON, sha256 and length must match. */
async function driveReceipt(res, id, length) {
  const body = new Uint8Array(await res.arrayBuffer());
  assert.ok(body.length <= 2048);
  const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  assert.equal(receipt.sha256, id); assert.equal(receipt.bytes, length);
}

test('packs written by Drive\'s vendored CAR codec parse (CARv1 and CARv2)', () => {
  for (const f of ['drive-v1.car', 'drive-v2.car']) {
    const car = parseCar(fixture(f));
    assert.deepEqual(car.roots, ['bafyreify3m6c5oc56iolzf2t5ammu6ua5xtzrrdzvn37grezerj5xxsnzy'], f);
    assert.equal(car.blocks.length, 6, f);
  }
});

test('Drive upload -> receipt -> download round trip, for CARv1 and CARv2 packs', async () => {
  for (const f of ['drive-v1.car', 'drive-v2.car']) {
    const s = fakeStore(); const bytes = fixture(f); const id = sha(bytes);
    const put = await handle(drivePut(bytes), ENV, deps(s));
    assert.equal(put.status, 200, f);
    assert.equal(put.headers.get('access-control-allow-origin'), DRIVE_ORIGIN);
    await driveReceipt(put, id, bytes.length);
    assert.ok(s.objects.has(`ipld/drive-packs/${id}`));
    const again = await handle(drivePut(bytes), ENV, deps(s));            // idempotent re-upload
    assert.equal(again.status, 200); await driveReceipt(again, id, bytes.length);
    const get = await handle(driveGet(id), ENV, deps(s));
    assert.equal(get.status, 200);
    const back = Buffer.from(await get.arrayBuffer());
    assert.equal(back.length, bytes.length); assert.equal(sha(back), id);
  }
});

test('uploads are refused unless the body is the named, bounded, well-formed pack', async () => {
  const s = fakeStore(); const bytes = fixture('drive-v1.car');
  const wrongId = await handle(drivePut(bytes, sha(Buffer.from('other'))), ENV, deps(s));
  assert.equal(wrongId.status, 400); assert.equal((await wrongId.json()).error, 'pack-does-not-hash-to-id');
  const notCar = Buffer.from('not a car at all');
  assert.equal((await (await handle(drivePut(notCar), ENV, deps(s))).json()).error, 'car-truncated');
  const tampered = Buffer.from(bytes); tampered[tampered.length - 1] ^= 1;   // a block no longer matches its CID
  const t = await handle(drivePut(tampered), ENV, deps(s));
  assert.equal(t.status, 400); assert.equal((await t.json()).error, 'pack-block-does-not-hash-to-cid');
  assert.equal((await handle(drivePut(bytes), { ...ENV, DRIVE_MAX_PACK_BYTES: '100' }, deps(s))).status, 413);
  const wrongType = new Request(url(sha(bytes)), { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal((await handle(wrongType, ENV, deps(s))).status, 415);
  assert.equal((await handle(new Request(url(sha(bytes)) + '?x=1', { method: 'PUT', body: bytes, headers: { 'content-type': 'application/vnd.ipld.car' } }), ENV, deps(s))).status, 400);
  assert.equal(dataKeys(s).length, 0);
});

test('CORS: the exact Drive WebView origins are allowed', async () => {
  const s = fakeStore(); const id = sha(fixture('drive-v1.car'));
  const pre = (origin) => handle(new Request(url(id), { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' } }), ENV, deps(s));
  for (const origin of [DRIVE_ORIGIN, 'tauri://localhost']) {
    const ok = await pre(origin);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), origin);
    assert.match(ok.headers.get('access-control-allow-methods'), /GET/);
    assert.match(ok.headers.get('access-control-allow-methods'), /PUT/);
    assert.equal(ok.headers.get('access-control-allow-headers'), 'content-type');
  }
  for (const origin of ['https://other.example', 'tauri://other', 'null']) {
    const other = await pre(origin);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  }
  const custom = await handle(new Request(url(id), { method: 'OPTIONS', headers: { origin: 'https://drive.example' } }), { ...ENV, DRIVE_ALLOWED_ORIGINS: 'https://drive.example' }, deps(s));
  assert.equal(custom.headers.get('access-control-allow-origin'), 'https://drive.example');
});

test('downloads: 404 when absent, 502 when the stored pack does not hash to its id', async () => {
  const s = fakeStore(); const bytes = fixture('drive-v1.car'); const id = sha(bytes);
  assert.equal((await handle(driveGet(id), ENV, deps(s))).status, 404);
  s.objects.set(`ipld/drive-packs/${id}`, Buffer.from('corrupted at rest'));
  assert.equal((await handle(driveGet(id), ENV, deps(s))).status, 502);
  assert.equal((await handle(new Request('https://yataverse.com/awai-drive/v1/packs/NOTHEX'), ENV, deps(s))).status, 404);
  assert.equal((await handle(new Request(url(id), { method: 'DELETE' }), ENV, deps(s))).status, 405);
});
