import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeUnixfs, validateUnixfs, unixfsLinks, encodePbNode, encodeUnixfsData, hashOf, UNIXFS_TYPE } from '../src/dag-pb.mjs';
import { checkWritableBlock } from '../src/block.mjs';
import { linksOf, DagError } from '../src/dag.mjs';
import { cidFor, rawCid, CODEC_DAG_PB, CODEC_DAG_CBOR } from '../src/cid.mjs';

const h = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const leafA = Buffer.from('aaaa'); const leafB = Buffer.from('bb');
const A = rawCid(leafA); const B = rawCid(leafB);
const dirData = encodeUnixfsData({ type: UNIXFS_TYPE.directory });
const link = (cid, name, tsize) => ({ hash: hashOf(cid), name, tsize });
const dir = (links) => encodePbNode({ links, data: dirData });
const file = (links, fields) => encodePbNode({ links, data: encodeUnixfsData({ type: UNIXFS_TYPE.file, ...fields }) });

test('a directory decodes to named entries and passes the write check', () => {
  const bytes = dir([link(A, 'a.txt', 4), link(B, 'b.txt', 2)]);
  assert.deepEqual(decodeUnixfs(bytes), { type: 'directory', entries: [{ name: 'a.txt', cid: A, tsize: 4 }, { name: 'b.txt', cid: B, tsize: 2 }] });
  assert.deepEqual(unixfsLinks(bytes), [A, B]);
  const cid = cidFor(bytes, CODEC_DAG_PB);
  assert.match(cid, /^bafybei/);
  assert.equal(checkWritableBlock(cid, bytes), null);
  assert.deepEqual(linksOf(cid, bytes), [A, B]);
});

test('the empty directory is the well-known UnixFS block', () => {
  const bytes = dir([]);
  assert.deepEqual(bytes, h('0a020801'));
  assert.equal(cidFor(bytes, CODEC_DAG_PB), 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354');
});

test('a chunked file decodes to ordered chunks whose sizes add up', () => {
  const bytes = file([link(A, '', 4), link(B, '', 2)], { filesize: 6, blocksizes: [4, 2] });
  const n = decodeUnixfs(bytes);
  assert.equal(n.type, 'file'); assert.equal(n.size, 6);
  assert.deepEqual(n.chunks, [{ cid: A, size: 4 }, { cid: B, size: 2 }]);
  // Inline data with no links (a small file added without raw leaves) and the legacy Raw leaf.
  assert.equal(decodeUnixfs(file([], { data: Buffer.from('hi'), filesize: 2 })).size, 2);
  assert.equal(decodeUnixfs(encodePbNode({ links: [], data: encodeUnixfsData({ type: UNIXFS_TYPE.raw, data: Buffer.from('hi'), filesize: 2 }) })).size, 2);
});

test('blocks outside the plain UnixFS subset are refused with a reason', () => {
  const cases = [
    [dir([link(B, 'b', 2), link(A, 'a', 4)]), 'directory-links-not-sorted'],
    [dir([link(A, 'a', 4), link(B, 'a', 2)]), 'directory-links-not-sorted'],              // duplicate name
    [dir([link(A, '', 4)]), 'directory-link-without-name'],
    [dir([link(A, null, 4)]), 'directory-link-without-name'],
    [dir([link(A, 'x/y', 4)]), 'directory-link-name-not-accepted'],
    [dir([link(A, '..', 4)]), 'directory-link-name-not-accepted'],
    [encodePbNode({ links: [link(A, 'a', 4)], data: encodeUnixfsData({ type: UNIXFS_TYPE.directory, filesize: 4 }) }), 'directory-with-file-fields'],
    [file([link(A, 'named', 4)], { filesize: 4, blocksizes: [4] }), 'file-link-with-name'],
    [file([link(A, '', 4)], { filesize: 4, blocksizes: [] }), 'file-blocksizes-do-not-match-links'],
    [file([link(A, '', 4)], { filesize: 5, blocksizes: [4] }), 'file-size-does-not-match-parts'],
    [file([link(A, '', 4)], { blocksizes: [4] }), 'file-size-does-not-match-parts'],
    [encodePbNode({ links: [link(A, '', 4)], data: encodeUnixfsData({ type: UNIXFS_TYPE.raw, filesize: 4, blocksizes: [4] }) }), 'raw-leaf-with-links'],
    [encodePbNode({ links: [], data: encodeUnixfsData({ type: 5 }) }), 'unixfs-type-not-accepted'],            // HAMT shard
    [encodePbNode({ links: [], data: encodeUnixfsData({ type: 4, data: Buffer.from('target') }) }), 'unixfs-type-not-accepted'], // symlink
    [encodePbNode({ links: [], data: Buffer.concat([dirData, h('3800')]) }), 'unixfs-field-not-accepted'],     // mode
    [encodePbNode({ links: [link(A, 'a', 4)], data: null }), 'node-without-unixfs-data'],
    [encodePbNode({ links: [], data: h('12026869') }), 'unixfs-without-type'],
    [Buffer.concat([h('0a020801'), encodePbNode({ links: [link(A, 'a', 4)], data: null })]), 'not-canonical-dag-pb'], // Data before Links
    [h('0a03088100'), 'not-canonical-unixfs'],                                                              // non-minimal varint
    [encodePbNode({ links: [{ hash: h('1220' + '00'.repeat(32)), name: 'v0', tsize: 1 }], data: dirData }), 'link-not-cidv1-sha2-256'],
    [dir([link(cidFor(h('a0'), CODEC_DAG_CBOR), 'c', 1)]), 'link-codec-not-accepted'],
    [h('0a0208'), 'truncated-field'],
    [h('1a00'), 'node-field-not-accepted'],
    [h('12060a0412345678'.slice(0, 12)), 'truncated-field'],
  ];
  for (const [bytes, code] of cases) {
    assert.equal(validateUnixfs(bytes), code, code);
    assert.equal(checkWritableBlock(cidFor(bytes, CODEC_DAG_PB), bytes), `not-accepted-unixfs:${code}`);
  }
  const bad = cases[0][0];
  assert.throws(() => linksOf(cidFor(bad, CODEC_DAG_PB), bad), (e) => e instanceof DagError && e.code === 'block-not-unixfs');
});
