import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';
import { handle } from '../worker/src/index.mjs';
import { rawCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';
import { ENV, TOKEN, NOW, fakeStore, RECEIPT_KEY, receiptKey } from './worker-fixtures.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-receipt-'));
process.env.YATAVERSE_CONFIG_DIR = dir;                     // never read the operator's real config
const s = fakeStore();
const fetchImpl = (url, init = {}) => handle(new Request(url, init), ENV, { fetchImpl: s.fetchImpl, now: NOW });
const write = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };
async function run(argv) {
  let out = '', err = '';
  const code = await main(argv, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, fetchImpl });
  return { code, out, err, json: code === 0 ? JSON.parse(out) : null };
}
const keysFile = write('keys.json', JSON.stringify(RECEIPT_KEY.keys));

test('verify-receipt checks a saved block, CAR and Drive pack response', async () => {
  const block = Buffer.from('saved receipt block');
  const res = await (await fetchImpl(`https://yataverse.com/ipfs/${rawCid(block)}`, { method: 'PUT', body: block,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } })).text();
  const r = await run(['verify-receipt', write('block.json', res), '--keys', keysFile, '--file', write('block.bin', block), '--kind', 'block']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.verified, true); assert.equal(r.json.kind, 'block'); assert.equal(r.json.storeClass, 'edge-gateway');
  assert.deepEqual(r.json.checked, ['signature', 'key', 'state', 'storeClass', 'kind', 'subject', 'contentDigest', 'size', 'receiptCid']);
  // Without --keys the write host's published keys are fetched; a bare envelope also works.
  const bare = await run(['verify-receipt', write('env.json', JSON.stringify(JSON.parse(res).receipt))]);
  assert.equal(bare.code, 0, bare.err); assert.equal(bare.json.receiptCid, r.json.receiptCid);

  const leaf = Buffer.from('saved car leaf'); const car = encodeCarV1([rawCid(leaf)], [{ cid: rawCid(leaf), bytes: leaf }]);
  const carRes = await (await fetchImpl('https://yataverse.com/ipfs/', { method: 'POST', body: car,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.car' } })).text();
  const c = await run(['verify-receipt', write('car.json', carRes), '--keys', keysFile, '--file', write('x.car', car), '--kind', 'car']);
  assert.equal(c.code, 0, c.err); assert.equal(c.json.kind, 'car');

  const pack = fs.readFileSync(new URL('./fixtures/drive-v1.car', import.meta.url));
  const id = (await import('node:crypto')).createHash('sha256').update(pack).digest('hex');
  const packRes = await (await fetchImpl(`https://yataverse.com/awai-drive/v1/packs/${id}`, { method: 'PUT', body: pack,
    headers: { 'content-type': 'application/vnd.ipld.car' } })).text();
  const d = await run(['verify-receipt', write('pack.json', packRes), '--keys', keysFile, '--file', write('p.car', pack), '--kind', 'drive-pack']);
  assert.equal(d.code, 0, d.err); assert.equal(d.json.requester, '0x' + '00'.repeat(32));
});

test('verify-receipt fails on the wrong file, a tampered receipt, other keys or a bad kind', async () => {
  const block = Buffer.from('another saved block');
  const res = JSON.parse(await (await fetchImpl(`https://yataverse.com/ipfs/${rawCid(block)}`, { method: 'PUT', body: block,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/vnd.ipld.raw' } })).text());
  const resFile = write('r.json', JSON.stringify(res));
  const fails = async (argv, code) => { const r = await run(argv); assert.equal(r.code, 1, argv.join(' ')); assert.match(r.err, new RegExp(code)); };
  await fails(['verify-receipt', resFile, '--keys', keysFile, '--file', write('wrong.bin', 'not it'), '--kind', 'block'], 'receipt-subject-mismatch');
  await fails(['verify-receipt', resFile, '--keys', keysFile, '--file', write('b2.bin', block), '--kind', 'drive-pack'], 'receipt-subject-mismatch');
  await fails(['verify-receipt', resFile, '--keys', keysFile, '--file', write('b3.bin', block), '--kind', 'tarball'], 'bad-kind');
  await fails(['verify-receipt', resFile, '--keys', keysFile, '--file', write('b4.bin', block)], 'kind-required-with-file');
  const tampered = structuredClone(res); tampered.receipt.receipt.acceptedAt += 1;
  await fails(['verify-receipt', write('t.json', JSON.stringify(tampered)), '--keys', keysFile], 'receipt-bad-signature');
  const cidSwap = { ...res, receiptCid: 'bafyreiaaaa' };
  await fails(['verify-receipt', write('c.json', JSON.stringify(cidSwap)), '--keys', keysFile], 'receipt-cid-mismatch');
  await fails(['verify-receipt', resFile, '--keys', write('other.json', JSON.stringify(receiptKey().keys))], 'receipt-unknown-key');
  const revoked = { ...RECEIPT_KEY.keys, keys: [{ ...RECEIPT_KEY.keys.keys[0], revokedAt: 1 }] };
  await fails(['verify-receipt', resFile, '--keys', write('rev.json', JSON.stringify(revoked))], 'receipt-key-revoked');
  await fails(['verify-receipt', write('none.json', '{"cid":"x"}'), '--keys', keysFile], 'no-receipt-in-input');
});
