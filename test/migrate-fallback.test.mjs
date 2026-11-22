// scripts/migrate-fallback.mjs (AWAI-3833): kubo-style CAR exports with CIDv0, the write rule,
// packing within the Worker's CAR limits, the rate limiter and a dry run with a stand-in `ipfs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { toV1, parseExport, classify, childrenFirst, batches, makeRate, digestHex, main } from '../scripts/migrate-fallback.mjs';
import { rawCid, cidFor, CODEC_DAG_PB } from '../src/cid.mjs';
import { encodePbNode, encodeUnixfsData, UNIXFS_TYPE } from '../src/dag-pb.mjs';
import { encodeCarV1, parseCar } from '../src/car.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest();
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')); let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return out;
}
const v0Of = (bytes) => base58(Buffer.concat([Buffer.from([0x12, 0x20]), sha(bytes)]));
const varint = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };

/** A CARv1 the way `ipfs dag export` writes a CIDv0 DAG: CIDv0 root in the header and sections. */
function kuboCar(rootV0, blocks) {
  const mh = Buffer.concat([Buffer.from([0x12, 0x20]), sha(blocks[0][1])]);
  const payload = Buffer.concat([Buffer.from([0x00]), mh]);
  const header = Buffer.concat([Buffer.from([0xa2, 0x65]), Buffer.from('roots'), Buffer.from([0x81, 0xd8, 0x2a, 0x58, payload.length]), payload,
    Buffer.from([0x67]), Buffer.from('version'), Buffer.from([0x01])]);
  const parts = [varint(header.length), header];
  for (const [, bytes, v0] of blocks) {
    const c = v0 ? Buffer.concat([Buffer.from([0x12, 0x20]), sha(bytes)]) : Buffer.from(`01${bytes.cidHex}`, 'hex');
    parts.push(varint(c.length + bytes.length), c, bytes);
  }
  return Buffer.concat(parts);
}

const leaf = encodePbNode({ links: [], data: encodeUnixfsData({ type: UNIXFS_TYPE.file, data: Buffer.from('hello v0'), filesize: 8 }) });

test('a single-block CIDv0 file is accepted as its CIDv1 dag-pb twin', () => {
  const v0 = v0Of(leaf);
  assert.equal(toV1(v0), cidFor(leaf, CODEC_DAG_PB));
  assert.equal(digestHex(v0), digestHex(toV1(v0)));
  const car = parseExport(kuboCar(v0, [[v0, leaf, true]]));
  assert.deepEqual(car.roots, [v0]);
  assert.equal(car.blocks[0].v1, toV1(v0));
  assert.equal(classify(car).status, 'ok');
});

test('a CIDv0 DAG whose links are CIDv0 is refused by the write rule and listed with the reason', () => {
  // A parent with one CIDv0 link (the PBLink hash is a bare multihash), as old `ipfs add` writes.
  const linkHash = Buffer.concat([Buffer.from([0x12, 0x20]), sha(leaf)]);
  const parent = encodePbNode({ links: [{ hash: linkHash, name: null, tsize: leaf.length }],
    data: encodeUnixfsData({ type: UNIXFS_TYPE.file, filesize: 8, blocksizes: [8] }) });
  const root = v0Of(parent);
  const car = parseExport(kuboCar(root, [[root, parent, true], [v0Of(leaf), leaf, true]]));
  const c = classify(car);
  assert.equal(c.status, 'unacceptable');
  assert.deepEqual(c.reasons, [{ cid: root, reason: 'not-accepted-unixfs:link-not-cidv1-sha2-256' }]);
});

test('a block on the read deny list stops the whole root', () => {
  const v0 = v0Of(leaf);
  const car = parseExport(kuboCar(v0, [[v0, leaf, true]]));
  const c = classify(car, { deny: new Set([digestHex(v0)]) });
  assert.equal(c.status, 'denied');
});

test('a block that does not hash to its CID fails the export', () => {
  const v0 = v0Of(leaf);
  const car = kuboCar(v0, [[v0, leaf, true]]);
  car[car.length - 1] ^= 1;
  assert.throws(() => parseExport(car), /block-does-not-hash-to-cid/);
});

/** A UnixFS file of n raw chunks (CIDv1), as `ipfs add --cid-version=1` writes. */
function wideFile(n, size = 12) {
  const chunks = Array.from({ length: n }, (_, i) => Buffer.from(`chunk-${i}`.padEnd(size, '.')));
  const links = chunks.map((b) => ({ hash: Buffer.from(rawCid(b).slice(1) ? decodeB32(rawCid(b)) : []), name: null, tsize: b.length }));
  const root = encodePbNode({ links, data: encodeUnixfsData({ type: UNIXFS_TYPE.file, filesize: n * size, blocksizes: chunks.map((b) => b.length) }) });
  const rootCid = cidFor(root, CODEC_DAG_PB);
  return { rootCid, blocks: [{ cid: rootCid, v1: rootCid, bytes: root }, ...chunks.map((b) => ({ cid: rawCid(b), v1: rawCid(b), bytes: b }))] };
}
function decodeB32(cid) {
  const A = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, v = 0; const out = [];
  for (const ch of cid.slice(1)) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return out;
}

test('blocks are packed children first within the block, byte and root limits; every CAR parses', () => {
  const f = wideFile(300);
  assert.equal(classify({ blocks: f.blocks }).status, 'ok');
  const order = childrenFirst(f.rootCid, f.blocks);
  assert.equal(order.length, 301); assert.equal(order.at(-1).v1, f.rootCid);
  const plan = batches(order);
  const stored = new Set();
  for (const b of plan) {
    assert.ok(b.blocks.length <= 256 && b.roots.length <= 23 && b.bytes <= 32 * 1024 * 1024);
    const car = parseCar(encodeCarV1(b.roots, b.blocks.map((x) => ({ cid: x.v1, bytes: x.bytes }))), { maxBlocks: 256 });
    assert.equal(car.blocks.length, b.blocks.length);
    for (const x of b.blocks) stored.add(x.v1);
  }
  assert.equal(stored.size, 301);
  assert.deepEqual(plan.at(-1).roots, [f.rootCid]);
  // A tighter byte limit splits further.
  const small = batches(order, { maxCarBytes: 20000, maxCarBlocks: 256, maxRoots: 23, maxBlockBytes: 1 << 20 });
  assert.ok(small.length >= plan.length && small.every((b) => b.bytes <= 20000));
});

test('the rate limiter keeps to N writes per window and the MiB budget', async () => {
  let t = 0; const waits = [];
  const admit = makeRate({ requests: 2, perMs: 1000, mib: 3, mibPerMs: 5000 }, { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  await admit(1); await admit(1);
  assert.equal(t, 0);
  await admit(1);                       // third request waits for the 1 s window
  assert.ok(t >= 1000);
  await admit(1);                       // 4 MiB would exceed 3 MiB in 5 s
  assert.ok(t >= 5000);
});

test('a dry run plans the CARs, records the state and resumes without exporting twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  const v0 = v0Of(leaf);
  fs.writeFileSync(path.join(dir, `${v0}.car`), kuboCar(v0, [[v0, leaf, true]]));
  const log = path.join(dir, 'calls.log');
  const fake = path.join(dir, 'fake-ipfs.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs';
const [cmd, sub, ...rest] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, [cmd, sub, ...rest].join(' ') + '\\n');
if (cmd === 'pin') process.stdout.write(${JSON.stringify(v0)} + '\\n');
else if (cmd === 'dag' && sub === 'export') process.stdout.write(fs.readFileSync(${JSON.stringify(dir)} + '/' + rest[0] + '.car'));
else process.exit(3);
`);
  const state = path.join(dir, 'state.jsonl');
  const argv = ['--pins', '--dry-run', '--state', state, '--ipfs', `${process.execPath} ${fake}`, '--work', path.join(dir, 'cars')];
  const lines = []; const orig = console.log; console.log = (l) => lines.push(l);
  try {
    assert.equal(await main(argv), 0);
    const j = JSON.parse(fs.readFileSync(state, 'utf8').trim());
    assert.equal(j.status, 'planned'); assert.deepEqual(j.blocks, [toV1(v0)]); assert.equal(j.cars.length, 1);
    fs.appendFileSync(state, JSON.stringify({ root: v0, status: 'done', blocks: [toV1(v0)] }) + '\n');
    assert.equal(await main(argv), 0);
    assert.deepEqual(JSON.parse(lines.at(-1)), { roots: 1, done: 0, skipped: 1, denied: 0, unacceptable: 0, failed: 0, planned: 0, cars: 0 });
    assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('dag export')).length, 1);
  } finally { console.log = orig; }
});
