// One log line per accepted write, naming the authorization scheme (JUN-1429). The line must not
// carry a token, a DID or a CID, and a refused write must not produce one.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TOKEN, ENV, NOW, fakeStore } from './worker-fixtures.mjs';
import { handle } from '../worker/src/index.mjs';
import { keyFromSeed, newSeed, mintDirect, blockResource, carResource } from '../src/cacao.mjs';
import { rawCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';

const WRITER = keyFromSeed(newSeed());
const CENV = { ...ENV, CACAO_NONCE_SECRET: 'test-nonce-secret-0123456789abcdef', CACAO_AUD: 'https://yataverse.com',
               CACAO_DOMAIN: 'yataverse.com', CACAO_WRITER_DIDS: WRITER.did };
const put = (cid, body, authorization) => new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'PUT', body,
  headers: { authorization, 'content-type': 'application/vnd.ipld.raw' } });
const post = (body, authorization) => new Request('https://yataverse.com/ipfs/', { method: 'POST', body,
  headers: { authorization, 'content-type': 'application/vnd.ipld.car' } });
const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

function setup() {
  const s = fakeStore(); const lines = [];
  return { s, lines, deps: { fetchImpl: s.fetchImpl, now: NOW, log: (l) => lines.push(l) } };
}
async function cacao(deps, resources) {
  const { nonce } = await (await handle(new Request('https://yataverse.com/auth/nonce'), CENV, deps)).json();
  return `CACAO ${mintDirect(WRITER, { aud: 'https://yataverse.com', domain: 'yataverse.com', nonce, resources, now: NOW().getTime(), ttlSec: 120 }).cacaoB64}`;
}

test('a token write and a CACAO write each log one line with their scheme and requester prefix', async () => {
  const { lines, deps } = setup();
  const a = Buffer.from('by token'); const b = Buffer.from('by cacao');
  assert.equal((await handle(put(rawCid(a), a, `Bearer ${TOKEN}`), CENV, deps)).status, 201);
  assert.equal((await handle(put(rawCid(b), b, await cacao(deps, [blockResource(rawCid(b))])), CENV, deps)).status, 201);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [
    { event: 'yataverse-write', scheme: 'token', kind: 'block', requester: sha12(TOKEN), bytes: a.length },
    { event: 'yataverse-write', scheme: 'cacao', kind: 'block', requester: sha12(WRITER.did), bytes: b.length },
  ]);
});

test('a CAR import logs kind "car"', async () => {
  const { lines, deps } = setup();
  // Two different bodies: the same content written by another requester is a 409 by design.
  const mk = (text) => { const block = Buffer.from(text); const cid = rawCid(block); return { block, car: Buffer.from(encodeCarV1([cid], [{ cid, bytes: block }])) }; };
  const one = mk('car block one'); const two = mk('car block two');
  assert.equal((await handle(post(one.car, `Bearer ${TOKEN}`), CENV, deps)).status, 201);
  const digest = crypto.createHash('sha256').update(two.car).digest('hex');
  assert.equal((await handle(post(two.car, await cacao(deps, [carResource(digest)])), CENV, deps)).status, 201);
  const got = lines.map((l) => JSON.parse(l));
  assert.deepEqual(got.map((x) => [x.scheme, x.kind, x.bytes]), [['token', 'car', one.block.length], ['cacao', 'car', two.block.length]]);
});

test('the line carries no token, DID or CID, and a refused write logs nothing', async () => {
  const { lines, deps } = setup();
  const a = Buffer.from('secret check'); const cid = rawCid(a);
  const c = Buffer.from('secret check by cacao'); const cid2 = rawCid(c);
  assert.equal((await handle(put(cid, a, `Bearer ${TOKEN}`), CENV, deps)).status, 201);
  assert.equal((await handle(put(cid2, c, await cacao(deps, [blockResource(cid2)])), CENV, deps)).status, 201);
  assert.equal(lines.length, 2);
  const all = lines.join('\n');
  for (const secret of [TOKEN, WRITER.did, cid, cid2, 'Bearer', 'CACAO ']) assert.ok(!all.includes(secret), secret);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['bytes', 'event', 'kind', 'requester', 'scheme']);
  const before = lines.length;
  const refused = await handle(put(cid, a, 'Bearer wrong-token-0000000'), CENV, deps);
  assert.equal(refused.status, 401);
  const other = Buffer.from('other'); 
  const mismatch = await handle(put(rawCid(other), other, await cacao(deps, [blockResource(cid)])), CENV, deps);
  assert.equal(mismatch.status, 403);
  assert.equal(lines.length, before);
});
