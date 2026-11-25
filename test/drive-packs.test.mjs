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

test('CORS: the Wrangler Drive origin binding allows Android and macOS preflights', async () => {
  const config = fs.readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8');
  const binding = config.match(/^\s*"DRIVE_ALLOWED_ORIGINS"\s*:\s*("[^"]*")/m);
  assert.ok(binding, 'Wrangler must set the Drive origin binding');
  const env = { ...ENV, DRIVE_ALLOWED_ORIGINS: JSON.parse(binding[1]) };
  const s = fakeStore();
  const id = sha(fixture('drive-v1.car'));
  for (const origin of [DRIVE_ORIGIN, 'tauri://localhost', 'null', 'https://other.example']) {
    const request = new Request(url(id), { method: 'OPTIONS', headers: {
      origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type',
    } });
    const response = await handle(request, env, deps(s));
    const allowed = origin === DRIVE_ORIGIN || origin === 'tauri://localhost';
    assert.equal(response.headers.get('access-control-allow-origin'), allowed ? origin : null);
  }
});

test('downloads: 404 when absent, 502 when the stored pack does not hash to its id', async () => {
  const s = fakeStore(); const bytes = fixture('drive-v1.car'); const id = sha(bytes);
  assert.equal((await handle(driveGet(id), ENV, deps(s))).status, 404);
  s.objects.set(`ipld/drive-packs/${id}`, Buffer.from('corrupted at rest'));
  assert.equal((await handle(driveGet(id), ENV, deps(s))).status, 502);
  assert.equal((await handle(new Request('https://yataverse.com/awai-drive/v1/packs/NOTHEX'), ENV, deps(s))).status, 404);
  assert.equal((await handle(new Request(url(id), { method: 'DELETE' }), ENV, deps(s))).status, 405);
});

// --- E2EE packs (item 216): tenant Bearer required, separate store namespace, plaintext route
// untouched. Stub only: the in-memory fakeStore, no network.
const E2EE_TOKEN = 'tenant-e2ee-token-0123456789abcdef';
const e2eeUrl = (id) => `https://yataverse.com/awai-drive/v1/e2ee-packs/${id}`;
const e2eeEnv = (extra = {}) => ({ ...ENV, DRIVE_E2EE_TOKEN_SHA256: sha(E2EE_TOKEN), ...extra });
const e2eePut = (bytes, id = sha(bytes), token = E2EE_TOKEN) => new Request(e2eeUrl(id), { method: 'PUT', body: bytes,
  headers: { origin: DRIVE_ORIGIN, 'Content-Type': 'application/vnd.ipld.car',
    ...(token ? { authorization: `Bearer ${token}` } : {}) } });
const e2eeGet = (id, token = E2EE_TOKEN) => new Request(e2eeUrl(id), { headers: { origin: DRIVE_ORIGIN,
  ...(token ? { authorization: `Bearer ${token}` } : {}) } });

test('E2EE packs: PUT/GET without a tenant token are 401, with a wrong token are 401', async () => {
  const s = fakeStore(); const bytes = fixture('drive-v1.car'); const id = sha(bytes);
  for (const req of [e2eePut(bytes, id, null), e2eePut(bytes, id, 'wrong-token-abcdefghijklmnop'),
                     e2eeGet(id, null), e2eeGet(id, 'wrong-token-abcdefghijklmnop')]) {
    const res = await handle(req, e2eeEnv(), deps(s));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal(dataKeys(s).length, 0, 'nothing stored without a token');
});

test('E2EE packs: unconfigured route fails closed with 503, never serves open', async () => {
  const s = fakeStore(); const id = sha(fixture('drive-v1.car'));
  const get = await handle(e2eeGet(id), ENV, deps(s));  // no DRIVE_E2EE_TOKEN_SHA256 in ENV
  assert.equal(get.status, 503); assert.equal((await get.json()).error, 'e2ee-packs-not-configured');
  const put = await handle(e2eePut(fixture('drive-v1.car')), ENV, deps(s));
  assert.equal(put.status, 503);
  assert.equal(dataKeys(s).length, 0);
});

test('E2EE packs: token round trip, stored under e2ee-packs/ and invisible on the plaintext route', async () => {
  const s = fakeStore(); const bytes = fixture('drive-v1.car'); const id = sha(bytes);
  const put = await handle(e2eePut(bytes), e2eeEnv(), deps(s));
  assert.equal(put.status, 200);
  await driveReceipt(put, id, bytes.length);
  assert.ok(s.objects.has(`ipld/e2ee-packs/${id}`), 'E2EE bytes live in the e2ee namespace');
  assert.ok(!s.objects.has(`ipld/drive-packs/${id}`), 'and NOT in the plaintext namespace');
  const get = await handle(e2eeGet(id), e2eeEnv(), deps(s));
  assert.equal(get.status, 200);
  assert.equal(sha(Buffer.from(await get.arrayBuffer())), id);
  // Namespace separation the other way: the plaintext route cannot see the E2EE pack,
  // and the E2EE route cannot see a plaintext pack.
  assert.equal((await handle(driveGet(id), e2eeEnv(), deps(s))).status, 404);
  const s2 = fakeStore();
  assert.equal((await handle(drivePut(bytes), e2eeEnv(), deps(s2))).status, 200);
  assert.equal((await handle(e2eeGet(id), e2eeEnv(), deps(s2))).status, 404);
});

test('E2EE packs: CORS preflight needs no token (browser negotiation), like the plaintext route', async () => {
  const s = fakeStore(); const id = sha(fixture('drive-v1.car'));
  const pre = await handle(new Request(e2eeUrl(id), { method: 'OPTIONS',
    headers: { origin: DRIVE_ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type, authorization' } }), e2eeEnv(), deps(s));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), DRIVE_ORIGIN);
});

test('E2EE packs: unknown id under the e2ee path is 404, not the plaintext handler', async () => {
  const s = fakeStore();
  assert.equal((await handle(new Request('https://yataverse.com/awai-drive/v1/e2ee-packs/NOTHEX'), e2eeEnv(), deps(s))).status, 404);
});
