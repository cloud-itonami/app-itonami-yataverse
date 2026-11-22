#!/usr/bin/env node
// Copy blocks that only READ_FALLBACK_URL (xavier, https://ipfs.yataverse.com) holds into B2
// through the public write path, so READ_FALLBACK_URL can later be removed (AWAI-3833).
// Run it on (or next to) the IPFS node once it is back. See docs/fallback-migration.md.
//
//   node scripts/migrate-fallback.mjs [--dry-run] [--pins] [--cids FILE] [--state FILE] ...
//
// For each root (every recursive pin with --pins, and the CIDs in --cids):
//   1. `ipfs dag export <root>` -> a CAR (CIDv0 sections are accepted here).
//   2. Every block is hashed against its CID. A CIDv0 is renamed to the CIDv1 dag-pb CID with the
//      same multihash (the Worker reads a CIDv0 from that key, worker/src/index.mjs storeKeys).
//   3. Each block is checked with the write rule (src/block.mjs). A root with a block that the rule
//      refuses, a block over the size limit, or a block on the read deny list is NOT copied; it is
//      recorded with the reason (state file, `unacceptable` / `denied`).
//   4. The blocks are packed children-first into CARs within the Worker's limits (32 MiB, 256
//      blocks, 23 roots per CAR). Each later CAR links to blocks an earlier one already stored.
//   5. Each CAR goes through `yataverse car-put`, which verifies the signed storage receipt and
//      exports the roots back. Then every block is read again with GET /ipfs/<cid> and must come
//      back byte-identical with `Yataverse-Read-Source: store` (B2, not the fallback).
//
// The state file (JSON lines) makes a run resumable: a root marked `done`, `unacceptable` or
// `denied` is skipped next time; `failed` is retried. --verify re-reads every `done` root's blocks
// and reports any that are not served from B2.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCid, base32, verifyBlock } from '../src/cid.mjs';
import { decodeDagCbor } from '../src/dag-cbor.mjs';
import { checkWritableBlock } from '../src/block.mjs';
import { linksOf } from '../src/dag.mjs';
import { encodeCarV1 } from '../src/car.mjs';

export const LIMITS = Object.freeze({ maxCarBytes: 32 * 1024 * 1024, maxCarBlocks: 256, maxRoots: 23, maxBlockBytes: 16 * 1024 * 1024 });
// The Worker's write budget is per client and per Cloudflare location (worker/src/write-limits.mjs).
// Defaults stay under it: 10 writes per 10 s, 60 MiB per 60 s.
export const RATE = Object.freeze({ requests: 10, perMs: 10_000, mib: 60, mibPerMs: 60_000 });
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** CIDv1 base32 of a CID string; a CIDv0 becomes CIDv1 dag-pb with the same multihash. */
export function toV1(cid) {
  const p = parseCid(cid);
  if (!p) return null;
  if (p.version === 1) return cid;
  return 'b' + base32(Buffer.concat([Buffer.from([0x01, 0x70, 0x12, 0x20]), Buffer.from(p.digest)]));
}

/** Multihash digest hex of a CID (CIDv0 and CIDv1 of one digest match). */
export const digestHex = (cid) => { const p = parseCid(cid); return p ? Buffer.from(p.digest).toString('hex') : null; };

function readVarint(b, i) {
  let v = 0n;
  for (let n = 0; n < 9; n++) {
    if (i >= b.length) throw new Error('car-truncated');
    const x = b[i++]; v |= BigInt(x & 0x7f) << BigInt(7 * n);
    if (!(x & 0x80)) return [Number(v), i];
  }
  throw new Error('car-varint-too-long');
}

/** Binary CID at b[i..] (CIDv0 multihash or CIDv1) -> [cid string, next]. */
function readCid(b, i) {
  if (b[i] === 0x12 && b[i + 1] === 0x20) {
    const mh = b.subarray(i, i + 34);
    return [base58(mh), i + 34];
  }
  const start = i; let len;
  [, i] = readVarint(b, i); [, i] = readVarint(b, i); [, i] = readVarint(b, i); [len, i] = readVarint(b, i);
  return ['b' + base32(b.subarray(start, i + len)), i + len];
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')); let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const x of bytes) { if (x === 0) out = '1' + out; else break; }
  return out;
}

/**
 * Parse a CARv1 as `ipfs dag export` writes it, CIDv0 sections included.
 * -> { roots: [cid], blocks: [{cid (as written), v1, bytes}] }. Throws on a block that does not
 * hash to its CID.
 */
export function parseExport(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let [hlen, i] = readVarint(b, 0);
  const header = decodeDagCbor(b.subarray(i, i + hlen)).value;
  i += hlen;
  const roots = (header.get('roots') ?? []).map((r) => {
    const c = r.cid; return c[0] === 0x12 ? base58(c) : 'b' + base32(c);
  });
  const blocks = []; const seen = new Set();
  while (i < b.length) {
    let len; [len, i] = readVarint(b, i);
    const end = i + len; let cid;
    [cid, i] = readCid(b, i);
    const data = b.subarray(i, end); i = end;
    if (!verifyBlock(cid, data)) throw new Error(`block-does-not-hash-to-cid: ${cid}`);
    const v1 = toV1(cid);
    if (!v1 || seen.has(v1)) continue;
    seen.add(v1);
    blocks.push({ cid, v1, bytes: Buffer.from(data) });
  }
  return { roots, blocks };
}

/**
 * Decide what to do with one exported DAG. -> { status: 'ok', blocks } or
 * { status: 'denied' | 'unacceptable', reasons: [{cid, reason}] }.
 */
export function classify({ blocks }, { deny = new Set(), limits = LIMITS } = {}) {
  const denied = blocks.filter((x) => deny.has(digestHex(x.v1)));
  if (denied.length) return { status: 'denied', reasons: denied.map((x) => ({ cid: x.cid, reason: 'read-deny-list' })) };
  const reasons = [];
  for (const x of blocks) {
    if (x.bytes.length > limits.maxBlockBytes) { reasons.push({ cid: x.cid, reason: 'block-too-large' }); continue; }
    const bad = checkWritableBlock(x.v1, x.bytes);
    if (bad) reasons.push({ cid: x.cid, reason: bad });
  }
  if (reasons.length) return { status: 'unacceptable', reasons };
  return { status: 'ok', blocks };
}

/** Children before parents (post-order from `root`), each block once. */
export function childrenFirst(root, blocks) {
  const byCid = new Map(blocks.map((x) => [x.v1, x]));
  const out = []; const done = new Set();
  const stack = [[toV1(root), false]];
  while (stack.length) {
    const [cid, expanded] = stack.pop();
    if (done.has(cid)) continue;
    const x = byCid.get(cid);
    if (!x) throw new Error(`closure-incomplete: ${cid}`);
    if (expanded) { done.add(cid); out.push(x); continue; }
    stack.push([cid, true]);
    const links = linksOf(cid, x.bytes);
    for (let k = links.length - 1; k >= 0; k--) if (!done.has(links[k])) stack.push([links[k], false]);
  }
  return out;
}

/**
 * Pack ordered blocks into CAR batches. A batch's roots are its blocks that no other block in the
 * batch links to; everything a batch links to outside itself is in an earlier batch.
 * -> [{ roots: [v1], blocks: [{v1, bytes}], bytes }]
 */
export function batches(ordered, limits = LIMITS) {
  const out = []; let cur = null;
  const fresh = () => ({ roots: new Set(), blocks: [], bytes: 0 });
  const overhead = (x) => x.bytes.length + 64;
  for (const x of ordered) {
    const links = linksOf(x.v1, x.bytes);
    const tryAdd = (b) => {
      const roots = new Set(b.roots);
      for (const l of links) roots.delete(l);
      roots.add(x.v1);
      if (b.blocks.length + 1 > limits.maxCarBlocks || b.bytes + overhead(x) > limits.maxCarBytes - 1024 || roots.size > limits.maxRoots) return false;
      b.roots = roots; b.blocks.push(x); b.bytes += overhead(x); return true;
    };
    if (!cur) cur = fresh();
    if (!tryAdd(cur)) { out.push(cur); cur = fresh(); if (!tryAdd(cur)) throw new Error(`block-does-not-fit-a-car: ${x.v1}`); }
  }
  if (cur && cur.blocks.length) out.push(cur);
  return out.map((b) => ({ roots: [...b.roots], blocks: b.blocks, bytes: b.bytes }));
}

/** CIDs from a file: one per line, or the first tab-separated column. Comments (#) are skipped. */
export function readCidList(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.split('\t')[0].trim()).filter((c) => c && !c.startsWith('#') && parseCid(c));
}

/** READ_DENY_CIDS from worker/wrangler.jsonc, as multihash digests. */
export function denyFromWrangler(file = path.join(HERE, '../worker/wrangler.jsonc')) {
  const m = /"READ_DENY_CIDS"\s*:\s*"([^"]*)"/.exec(fs.readFileSync(file, 'utf8'));
  return new Set((m ? m[1] : '').split(',').map((s) => s.trim()).filter(Boolean).map(digestHex).filter(Boolean));
}

/** A sliding-window limiter for write requests and MiB. */
export function makeRate(rate = RATE, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const reqs = []; const mibs = [];
  return async function admit(mib) {
    for (;;) {
      const t = now();
      while (reqs.length && t - reqs[0] >= rate.perMs) reqs.shift();
      while (mibs.length && t - mibs[0][0] >= rate.mibPerMs) mibs.shift();
      const used = mibs.reduce((n, [, m]) => n + m, 0);
      if (reqs.length < rate.requests && used + mib <= rate.mib) { reqs.push(t); mibs.push([t, mib]); return; }
      const waitReq = reqs.length >= rate.requests ? rate.perMs - (t - reqs[0]) : 0;
      const waitMib = used + mib > rate.mib && mibs.length ? rate.mibPerMs - (t - mibs[0][0]) : 0;
      await sleep(Math.max(50, waitReq, waitMib));
    }
  };
}

// ---- I/O --------------------------------------------------------------------------------

function args(argv) {
  const o = { dryRun: false, pins: false, verify: false, cids: [], state: '.agent-output/migrate-fallback/state.jsonl',
              work: null, ipfs: 'ipfs', yataverse: `${process.execPath} ${path.join(HERE, '../bin/yataverse.mjs')}`,
              readUrl: 'https://yataverse.com', limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => argv[++i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--pins') o.pins = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--cids') o.cids.push(v());
    else if (a === '--state') o.state = v();
    else if (a === '--work') o.work = v();
    else if (a === '--ipfs') o.ipfs = v();
    else if (a === '--yataverse') o.yataverse = v();
    else if (a === '--read-url') o.readUrl = v();
    else if (a === '--limit') o.limit = Number(v());
    else if (a === '-h' || a === '--help') { o.help = true; }
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const HELP = `usage: node scripts/migrate-fallback.mjs [options]
  --pins                 roots from \`ipfs pin ls --type=recursive --quiet\`
  --cids FILE            more roots (one CID per line or first TSV column), e.g. docs/fallback-only-cids-2026-11-22.txt
  --dry-run              export, check and plan the CARs; write nothing to yataverse.com
  --verify               re-read the blocks of every done root; each must come from B2
  --state FILE           resumable state (default .agent-output/migrate-fallback/state.jsonl)
  --work DIR             where CAR files are written (default: a temp dir)
  --ipfs CMD             IPFS CLI, split on spaces (default "ipfs"; e.g. "ssh xavier ipfs")
  --yataverse CMD        yataverse CLI (default: this repo's bin/yataverse.mjs; uses its configured write auth)
  --read-url URL         read host for the readback (default https://yataverse.com)
  --limit N              stop after N roots`;

function run(cmd, argv, { input, maxBuffer = 1 << 30 } = {}) {
  const [bin, ...pre] = cmd.split(' ').filter(Boolean);
  const r = spawnSync(bin, [...pre, ...argv], { input, maxBuffer });
  if (r.status !== 0) throw new Error(`${bin} ${argv[0]} failed: ${String(r.stderr ?? r.error).slice(0, 400)}`);
  return r.stdout;
}

function loadState(file) {
  const m = new Map();
  if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l.trim()) { const j = JSON.parse(l); m.set(j.root, j); }
  return m;
}

async function readback(readUrl, blocks) {
  const bad = [];
  for (const x of blocks) {
    const r = await fetch(new URL(`/ipfs/${x.v1}?format=raw`, readUrl), { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    const got = r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null;
    const source = r.headers.get('yataverse-read-source');
    if (!got || !got.equals(x.bytes)) bad.push({ cid: x.v1, reason: `readback-${r.status}` });
    else if (source !== 'store') bad.push({ cid: x.v1, reason: `readback-source-${source ?? 'unknown'}` });
  }
  return bad;
}

export async function main(argv = process.argv.slice(2)) {
  const o = args(argv);
  if (o.help) { console.log(HELP); return 0; }
  fs.mkdirSync(path.dirname(o.state), { recursive: true });
  const state = loadState(o.state);
  const record = (j) => { state.set(j.root, j); fs.appendFileSync(o.state, JSON.stringify({ ...j, at: new Date().toISOString() }) + '\n'); };
  if (o.verify) {
    let failures = 0;
    for (const j of state.values()) {
      if (j.status !== 'done') continue;
      const blocks = j.blocks.map((v1) => ({ v1, bytes: null }));
      for (const x of blocks) {
        const r = await fetch(new URL(`/ipfs/${x.v1}`, o.readUrl), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (r.status !== 200 || r.headers.get('yataverse-read-source') !== 'store') { failures++; console.log(`${j.root}\t${x.v1}\t${r.status}\t${r.headers.get('yataverse-read-source')}`); }
      }
    }
    console.log(JSON.stringify({ verified: [...state.values()].filter((j) => j.status === 'done').length, notFromStore: failures }));
    return failures ? 1 : 0;
  }
  const roots = [];
  if (o.pins) roots.push(...String(run(o.ipfs, ['pin', 'ls', '--type=recursive', '--quiet'])).split('\n').map((s) => s.trim()).filter(Boolean));
  for (const f of o.cids) roots.push(...readCidList(f));
  const unique = [...new Set(roots.map((r) => r.trim()))];
  const deny = denyFromWrangler();
  const work = o.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-fallback-'));
  fs.mkdirSync(work, { recursive: true });
  const admit = makeRate();
  const summary = { roots: unique.length, done: 0, skipped: 0, denied: 0, unacceptable: 0, failed: 0, planned: 0, cars: 0 };
  let n = 0;
  for (const root of unique) {
    if (n >= o.limit) break;
    const prior = state.get(root);
    if (prior && ['done', 'denied', 'unacceptable'].includes(prior.status)) { summary.skipped++; continue; }
    n++;
    try {
      if (!parseCid(root)) { record({ root, status: 'unacceptable', reasons: [{ cid: root, reason: 'root-not-a-sha2-256-cid' }] }); summary.unacceptable++; continue; }
      if (deny.has(digestHex(root))) { record({ root, status: 'denied', reasons: [{ cid: root, reason: 'read-deny-list' }] }); summary.denied++; continue; }
      const car = parseExport(run(o.ipfs, ['dag', 'export', root]));
      const c = classify(car, { deny });
      if (c.status !== 'ok') { record({ root, status: c.status, reasons: c.reasons }); summary[c.status]++; continue; }
      const plan = batches(childrenFirst(root, c.blocks));
      if (o.dryRun) {
        record({ root, status: 'planned', blocks: c.blocks.map((x) => x.v1), cars: plan.map((b) => ({ roots: b.roots, blocks: b.blocks.length, bytes: b.bytes })) });
        summary.planned++; summary.cars += plan.length; continue;
      }
      const receipts = [];
      for (const [k, b] of plan.entries()) {
        const bytes = encodeCarV1(b.roots, b.blocks.map((x) => ({ cid: x.v1, bytes: x.bytes })));
        const file = path.join(work, `${toV1(root)}-${String(k).padStart(4, '0')}.car`);
        fs.writeFileSync(file, bytes);
        await admit(Math.max(1, Math.ceil(bytes.length / (1024 * 1024))));
        const res = JSON.parse(String(run(o.yataverse, ['car-put', file])));
        if (res.verified !== true) throw new Error(`car-put-not-verified: ${file}`);
        receipts.push({ car: crypto.createHash('sha256').update(bytes).digest('hex'), roots: b.roots, receiptCid: res.receiptCid ?? null });
        summary.cars++;
      }
      const bad = await readback(o.readUrl, c.blocks);
      // A CIDv0 root must also be readable by its own name (the Worker maps it to the CIDv1 key).
      if (root !== toV1(root)) bad.push(...(await readback(o.readUrl, [{ v1: root, bytes: c.blocks.find((x) => x.v1 === toV1(root)).bytes }])));
      if (bad.length) { record({ root, status: 'failed', reasons: bad, receipts }); summary.failed++; continue; }
      record({ root, v1: toV1(root), status: 'done', blocks: c.blocks.map((x) => x.v1), receipts });
      summary.done++;
    } catch (e) {
      record({ root, status: 'failed', reasons: [{ cid: root, reason: String(e.message).slice(0, 300) }] });
      summary.failed++;
    }
  }
  console.log(JSON.stringify(summary));
  return summary.failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(2); });
}
