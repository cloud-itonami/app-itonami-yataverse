import test from 'node:test';
import assert from 'node:assert/strict';
import { packFiles, resolvePath, readFile, UnixfsError } from '../src/unixfs.mjs';
import { checkWritableBlock } from '../src/block.mjs';
import { checkClosure } from '../src/dag.mjs';
import { verifyBlock, parseCid, CODEC_RAW } from '../src/cid.mjs';

const loader = (blocks) => async (cid) => blocks.get(cid) ?? null;
const site = () => packFiles({
  'index.html': Buffer.from('<h1>home</h1>'), 'app.js': Buffer.from('1'), 'docs/index.html': Buffer.from('docs'),
  'docs/big.bin': Buffer.alloc(20, 7), 'empty.txt': Buffer.alloc(0),
}, { chunkBytes: 8 });

test('packFiles writes only blocks the store accepts, and the closure is complete', async () => {
  const { root, blocks } = site();
  assert.match(root, /^bafybei/);
  for (const [cid, bytes] of blocks) { assert.ok(verifyBlock(cid, bytes)); assert.equal(checkWritableBlock(cid, bytes), null); }
  const { reachable } = await checkClosure([root], blocks, async () => false);
  assert.equal(reachable.size, blocks.size);
  assert.equal(site().root, root);                       // deterministic
});

test('resolvePath walks directories; readFile joins chunks in order', async () => {
  const { root, blocks } = site(); const load = loader(blocks);
  const top = await resolvePath(root, [], load);
  assert.deepEqual(top.node.entries.map((e) => e.name), ['app.js', 'docs', 'empty.txt', 'index.html']);
  const home = await resolvePath(root, ['index.html'], load);
  assert.equal(parseCid((await resolvePath(root, ['app.js'], load)).cid).codec, CODEC_RAW);   // one chunk: a raw leaf
  assert.equal((await readFile(home.node, load)).toString(), '<h1>home</h1>');
  const big = await resolvePath(root, ['docs', 'big.bin'], load);
  assert.equal(big.node.chunks.length, 3); assert.equal(big.node.size, 20);
  assert.deepEqual(await readFile(big.node, load), Buffer.alloc(20, 7));
  assert.equal((await readFile((await resolvePath(root, ['empty.txt'], load)).node, load)).length, 0);
  assert.equal(await resolvePath(root, ['missing'], load), null);
  assert.equal(await resolvePath(root, ['index.html', 'under-a-file'], load), null);
});

test('missing blocks, wrong chunk sizes and limits are errors, never short content', async () => {
  const { root, blocks } = site(); const load = loader(blocks);
  const big = await resolvePath(root, ['docs', 'big.bin'], load);
  const without = new Map(blocks); without.delete(big.node.chunks[1].cid);
  await assert.rejects(readFile(big.node, loader(without)), (e) => e instanceof UnixfsError && e.code === 'block-not-found');
  const lying = { ...big.node, chunks: big.node.chunks.map((c, i) => (i === 0 ? { ...c, size: 7 } : c)) };
  await assert.rejects(readFile(lying, load), (e) => e.code === 'chunk-size-mismatch');
  await assert.rejects(readFile(big.node, load, { maxBlocks: 2 }), (e) => e.code === 'file-has-too-many-blocks');
  await assert.rejects(readFile(big.node, load, { maxBytes: 19 }), (e) => e.code === 'file-too-large');
  await assert.rejects(readFile((await resolvePath(root, ['docs'], load)).node, load), (e) => e.code === 'not-a-file');
  await assert.rejects(resolvePath(root, ['docs'], loader(new Map())), (e) => e.code === 'block-not-found');
});

test('packFiles refuses bad paths, file/directory clashes and files beyond one level of chunks', () => {
  for (const p of ['../x', 'a//b', '/abs', 'a/./b', '']) assert.throws(() => packFiles({ [p]: Buffer.from('x') }), (e) => e.code === 'bad-path', p);
  assert.throws(() => packFiles({ a: Buffer.from('x'), 'a/b': Buffer.from('y') }), (e) => e.code === 'path-is-both-file-and-directory');
  assert.throws(() => packFiles({ big: Buffer.alloc(175) }, { chunkBytes: 1 }), (e) => e.code === 'file-too-large-for-packer');
});
