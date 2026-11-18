import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/src/index.mjs';
import { makeClient } from '../src/client.mjs';
import { rawCid } from '../src/cid.mjs';
import { ENV, TOKEN, NOW, fakeStore, receiptKey, RECEIPT_KEY } from './worker-fixtures.mjs';

const CFG = { url: 'https://yataverse.com', readUrl: 'https://yataverse.com', prefix: '/ipfs/' };
const authorize = async () => `Bearer ${TOKEN}`;
/** A client whose network is the real Worker handler over an in-memory B2; `tamper` edits responses. */
function setup({ cfg = CFG, tamper, env = ENV, ...opts } = {}) {
  const s = fakeStore(); const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? 'GET', rid: init.headers?.['yataverse-request-id'] });
    const res = await handle(new Request(url, init), env, { fetchImpl: s.fetchImpl, now: NOW });
    return tamper ? tamper(String(url), init, res) : res;
  };
  return { s, seen, client: makeClient(cfg, { fetchImpl, authorize, ...opts }) };
}
const editJson = (fn) => async (url, init, res) => {
  if (init.method !== 'PUT' && init.method !== 'POST') return res;
  const j = await res.json(); fn(j);
  return new Response(JSON.stringify(j), { status: res.status, headers: { 'content-type': 'application/json' } });
};

test('put verifies the receipt against the published keys and its own values', async () => {
  const { client, seen } = setup();
  const bytes = Buffer.from('client receipt');
  const r = await client.putBytes(bytes);
  assert.equal(r.cid, rawCid(bytes)); assert.equal(r.receiptVerified, true);
  const put = seen.find((x) => x.method === 'PUT');
  assert.match(put.rid, /^[0-9a-f]{64}$/, 'a fresh request id is sent');
  assert.equal(r.receipt.receipt.requestId, '0x' + put.rid);
  assert.ok(seen.some((x) => x.url.endsWith('/.well-known/yataverse-receipt-keys.json')));
  // A retry with the same --request-id gets the same receipt back.
  const rid = 'cd'.repeat(32);
  const a = await client.putBytes(bytes, { requestId: rid });
  const b = await client.putBytes(bytes, { requestId: rid });
  assert.deepEqual(b.receipt, a.receipt);
  await assert.rejects(client.putBytes(Buffer.from('other'), { requestId: rid }), (e) => e.code === 'put-request-id-conflict');
  await assert.rejects(client.putBytes(bytes, { requestId: 'nope' }), (e) => e.code === 'bad-request-id');
});

test('a receipt that does not match what was sent, or is not signed by a published key, is an error', async () => {
  const cases = [
    ['size', (j) => { j.receipt.receipt.size += 1; }, 'receipt-bad-signature'],
    ['signature', (j) => { j.receipt.sig.sig = 'A' + j.receipt.sig.sig.slice(1); }, 'receipt-bad-signature'],
    ['receiptCid', (j) => { j.receiptCid = 'bafyreiaaaa'; }, 'receipt-cid-mismatch'],
    ['missing', (j) => { delete j.receipt; }, 'receipt-missing'],
  ];
  for (const [name, fn, code] of cases) {
    const { client } = setup({ tamper: editJson(fn) });
    await assert.rejects(client.putBytes(Buffer.from(`tamper ${name}`)), (e) => e.code === code, name);
  }
  // Keys pinned by the caller that do not include the signer.
  const { client } = setup({ receiptKeys: receiptKey().keys });
  await assert.rejects(client.putBytes(Buffer.from('pinned')), (e) => e.code === 'receipt-unknown-key');
  // Pinned keys that do include it.
  const ok = setup({ receiptKeys: RECEIPT_KEY.keys });
  assert.equal((await ok.client.putBytes(Buffer.from('pinned ok'))).receiptVerified, true);
  assert.ok(!ok.seen.some((x) => x.url.includes('.well-known')), 'pinned keys are not fetched');
});

test('a receipt issued for another request or another requester is refused', async () => {
  // The server answers with a valid receipt from an earlier write of the same bytes.
  const { client } = setup();
  const bytes = Buffer.from('replayed');
  const first = await client.putBytes(bytes);
  const replay = setup({ tamper: editJson((j) => { j.receipt = first.receipt; j.receiptCid = first.receiptCid; }) });
  await assert.rejects(replay.client.putBytes(bytes), (e) => e.code === 'receipt-requestId-mismatch');
  // Another token's receipt for the same request id.
  const other = 'yv_write_someone_else_000';
  const env = { ...ENV, WRITE_TOKEN_SHA256: `${ENV.WRITE_TOKEN_SHA256},${(await import('./worker-fixtures.mjs')).sha(other)}` };
  const s2 = fakeStore();
  const rid = 'ef'.repeat(32);
  const theirs = await (await handle(new Request(`https://yataverse.com/ipfs/${rawCid(bytes)}`, { method: 'PUT', body: bytes,
    headers: { authorization: `Bearer ${other}`, 'content-type': 'application/vnd.ipld.raw', 'yataverse-request-id': rid } }), env, { fetchImpl: s2.fetchImpl, now: NOW })).json();
  const swap = setup({ env, tamper: editJson((j) => { j.receipt = theirs.receipt; j.receiptCid = theirs.receiptCid; }) });
  await assert.rejects(swap.client.putBytes(bytes, { requestId: rid }), (e) => e.code === 'receipt-requester-mismatch');
});

test('hosts that do not issue receipts still work unless receipts are required', async () => {
  const noReceipt = editJson((j) => { delete j.receipt; delete j.receiptCid; });
  const other = { ...CFG, url: 'https://blocks.example', readUrl: 'https://blocks.example' };
  const { client } = setup({ cfg: other, tamper: noReceipt });
  const r = await client.putBytes(Buffer.from('no receipts here'));
  assert.equal(r.verified, true); assert.equal(r.receipt, undefined);
  const strict = setup({ cfg: { ...other, requireReceipt: true }, tamper: noReceipt });
  await assert.rejects(strict.client.putBytes(Buffer.from('strict')), (e) => e.code === 'receipt-missing');
  // A receipt that is present is always checked, even when not required.
  const bad = setup({ cfg: other, tamper: editJson((j) => { j.receipt.receipt.size += 1; }) });
  await assert.rejects(bad.client.putBytes(Buffer.from('present but bad')), (e) => e.code === 'receipt-bad-signature');
});
