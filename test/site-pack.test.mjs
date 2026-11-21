import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main } from '../src/cli.mjs';
import { packFiles, siteCars } from '../src/unixfs.mjs';
import { parseCar } from '../src/car.mjs';
import { checkClosure } from '../src/dag.mjs';
import { checkWritableBlock } from '../src/block.mjs';

const sink = () => { const s = new PassThrough(); const chunks = []; s.on('data', (c) => chunks.push(c)); return { s, text: () => Buffer.concat(chunks).toString() }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yv-site-'));

test('siteCars: CARs imported in order each have a complete closure, and every block is reachable from a root', async () => {
  const files = {}; for (let i = 0; i < 30; i++) files[`d${i % 3}/f${i}.txt`] = Buffer.from(`file ${i} `.repeat(4));
  files['index.html'] = Buffer.from('home');
  const site = packFiles(files, { chunkBytes: 16 });
  const cars = siteCars(site.blocks, { maxBlocks: 7, maxBytes: 4096 });
  assert.ok(cars.length > 3);
  const stored = new Set();
  for (const c of cars) {
    assert.ok(c.blocks <= 7);
    const car = parseCar(c.car);
    assert.deepEqual(car.roots, c.roots);
    const blocks = new Map(car.blocks.map((b) => [b.cid, b.bytes]));
    for (const [cid, bytes] of blocks) assert.equal(checkWritableBlock(cid, bytes), null);
    // The Worker's import rules: closure in the CAR or already stored; no unreachable block.
    await checkClosure(car.roots, blocks, async (cid) => stored.has(cid));
    for (const cid of blocks.keys()) stored.add(cid);
  }
  assert.equal(stored.size, site.blocks.size);
  assert.ok(cars[cars.length - 1].roots.includes(site.root));
  // Out of order, a CAR is refused: its links are not stored yet.
  const last = parseCar(cars[cars.length - 1].car);
  await assert.rejects(checkClosure(last.roots, new Map(last.blocks.map((b) => [b.cid, b.bytes])), async () => false), (e) => e.code === 'closure-incomplete');
  assert.throws(() => siteCars(site.blocks, { maxBytes: 8 }), (e) => e.code === 'block-larger-than-car-limit');
});

test('site-pack writes ordered CARs and prints the root; it sends nothing', async () => {
  const dir = tmp(); const outDir = path.join(tmp(), 'cars');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(dir, 'docs', 'index.html'), 'docs');
  const o = sink(); const e = sink();
  const code = await main(['site-pack', dir, '-o', outDir], { stdout: o.s, stderr: e.s, fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(code, 0, e.text());
  const r = JSON.parse(o.text());
  assert.equal(r.root, packFiles({ 'index.html': '<h1>home</h1>', 'docs/index.html': 'docs' }).root);
  assert.equal(r.dnslink, `dnslink=/ipfs/${r.root}`);
  assert.deepEqual([r.files, r.blocks, r.cars.length], [2, 4, 1]);
  assert.equal(path.basename(r.cars[0].file), 'site-001.car');
  assert.deepEqual(parseCar(fs.readFileSync(r.cars[0].file)).roots, [r.root]);
});

test('site-pack leaves out dot names unless --hidden true, and says which', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.well-known')); fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'index.html'), 'home');
  fs.writeFileSync(path.join(dir, '.well-known', 'did.json'), '{}');
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  const run = async (extra) => { const o = sink(); const e = sink(); assert.equal(await main(['site-pack', dir, '-o', tmp(), ...extra], { stdout: o.s, stderr: e.s }), 0, e.text()); return JSON.parse(o.text()); };
  const plain = await run([]);
  assert.equal(plain.files, 1);
  assert.deepEqual(plain.skippedHidden.sort(), ['.DS_Store', '.git', '.well-known']);
  assert.equal(plain.root, packFiles({ 'index.html': 'home' }).root);
  const all = await run(['--hidden', 'true']);
  assert.equal(all.files, 4); assert.equal(all.skippedHidden, undefined);
  assert.equal(all.root, packFiles({ 'index.html': 'home', '.well-known/did.json': '{}', '.git/HEAD': 'ref', '.DS_Store': 'x' }).root);
});

test('site-pack refuses symbolic links, an empty directory and missing arguments', async () => {
  const run = async (args) => { const o = sink(); const e = sink(); return { code: await main(args, { stdout: o.s, stderr: e.s }), err: e.text() }; };
  const dir = tmp();
  assert.match((await run(['site-pack', dir, '-o', tmp()])).err, /site-is-empty/);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'link'));
  const linked = await run(['site-pack', dir, '-o', tmp()]);
  assert.equal(linked.code, 1); assert.match(linked.err, /site-has-symbolic-link/);
  assert.match((await run(['site-pack', dir])).err, /usage/);
});
