// Publishing and fetching retention status records, and the verifier sweep
// (docs/retention-design.md §6; AWAI-3680). The gateway stores and hands out what the lease's own
// verifier signed; it never judges a lease, and readers verify what they get.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handle } from '../worker/src/index.mjs';
import { main } from '../src/cli.mjs';
import { makeClient } from '../src/client.mjs';
import { importSigningKey, keyIdFor, KEY_USE, ZERO32 } from '../src/receipt.mjs';
import {
  GRADE, STATUS, leaseFromTerms, signLeaseAsRequester, signLeaseAsVerifier, leaseEnvelopeToJson, leaseEnvelopeToDagCbor,
  signStatus, statusEnvelopeToJson, statusEnvelopeToDagCbor,
} from '../src/retention.mjs';
import { rawCid, cidToBytes } from '../src/cid.mjs';
import { TOKEN, ENV, UNLIMITED } from './worker-fixtures.mjs';
import { lockStore } from './lock-store.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const fill = (n) => new Uint8Array(32).fill(n);
const T = Date.parse('2026-11-18T00:00:00Z'), DAY = 86_400_000;
const BLOCK = Buffer.from('a block with a published status'), CID = rawCid(BLOCK);

function key(use) {
  const j = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const jwk = { kty: j.kty, crv: j.crv, d: j.d, x: j.x };
  return { jwk, entry: { keyId: '0x' + hex(keyIdFor(new Uint8Array(Buffer.from(j.x, 'base64url')))), keyEpoch: 1, alg: 'Ed25519',
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: j.x }, notBefore: 0, notAfter: null, revokedAt: null, ...(use ? { use } : {}) } };
}
const K = { gateway: key(), archive: key([KEY_USE.operatorArchiveReceipt]), verifier: key([KEY_USE.retentionVerifier]),
  verifier2: key([KEY_USE.retentionVerifier]), unpublished: key([KEY_USE.retentionVerifier]), requester: key() };
const KEYS = { v: 1, signer: 'did:web:yataverse.com', keys: [K.gateway.entry, K.archive.entry, K.verifier.entry, K.verifier2.entry] };
const WENV = { ...ENV, RECEIPT_SIGNING_KEY: JSON.stringify(K.gateway.jwk), ARCHIVE_RECEIPT_SIGNING_KEY: JSON.stringify(K.archive.jwk), RECEIPT_PUBLIC_KEYS: KEYS,
  B2_LOCK_KEY_ID: 'lockkid', B2_LOCK_APP_KEY: 'locksecret', WRITE_REQUEST_LIMITER: UNLIMITED, WRITE_MIB_LIMITER: UNLIMITED };
const signers = {};
const signer = async (n) => (signers[n] ??= await importSigningKey(K[n].jwk));

async function leaseEnvFor(over = {}, { verifier = 'verifier', bytes = BLOCK } = {}) {
  const rq = await signer('requester'), vf = await signer(verifier);
  const lease = leaseFromTerms({ subject: cidToBytes(rawCid(bytes)), size: bytes.length, pieceCommitment: ZERO32, grade: GRADE.R1, providerReplicas: 0,
    domainPolicy: fill(3), notBefore: T - DAY, retentionUntil: T + 30 * DAY, challengePeriod: 86_400, requester: rq.keyId, verifier: vf.keyId, policyRevision: fill(4), ...over });
  return { v: 1, lease, sigs: { requester: await signLeaseAsRequester(lease, rq), verifier: await signLeaseAsVerifier(lease, vf) } };
}
async function statusFor(leaseEnv, over = {}, by = 'verifier') {
  const s = await signer(by); const l = leaseEnv.lease;
  return signStatus({ leaseId: l.leaseId, subject: l.subject, grade: l.grade, status: STATUS.policySatisfied, providerReplicas: 0, operatorCopies: 1,
    evidenceRoot: fill(5), observedAt: T, validUntil: T + 2 * DAY, keyId: s.keyId, keyEpoch: 1, ...over }, s);
}
const retentionKeys = (s) => [...s.objects.keys()].filter((k) => k.startsWith('ipld/retention/'));
function setup() {
  const s = lockStore(); const state = { clock: T, tamper: null };
  const fetchImpl = async (url, init = {}) => {
    if (new URL(url).host === 's3.us-west-004.backblazeb2.com') return s.fetchImpl(url, init);
    const res = await handle(new Request(url, init), WENV, { fetchImpl: s.fetchImpl, now: () => new Date(state.clock) });
    return state.tamper ? state.tamper(String(url), init, res) : res;
  };
  const publish = (leaseEnv, statusEnv, { auth = `Bearer ${TOKEN}`, id = hex(leaseEnv.lease.leaseId), body } = {}) =>
    fetchImpl(`https://yataverse.com/retention/v1/status/${id}`, { method: 'PUT', headers: { authorization: auth, 'content-type': 'application/json' },
      body: body ?? JSON.stringify({ lease: leaseEnvelopeToJson(leaseEnv), status: statusEnvelopeToJson(statusEnv) }) });
  const client = makeClient({ url: 'https://yataverse.com', readUrl: 'https://yataverse.com', prefix: '/ipfs/' }, { fetchImpl, authorize: async () => `Bearer ${TOKEN}` });
  return { s, state, fetchImpl, publish, client };
}

test('a status signed by the lease verifier is stored and can be fetched by lease id and by CID', async () => {
  const { s, fetchImpl, publish, client } = setup();
  const leaseEnv = await leaseEnvFor(); const statusEnv = await statusFor(leaseEnv);
  const res = await publish(leaseEnv, statusEnv);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.leaseId, '0x' + hex(leaseEnv.lease.leaseId));
  assert.equal(body.statusCid, statusEnvelopeToDagCbor(statusEnv).cid);
  assert.deepEqual(retentionKeys(s).sort(), [`ipld/retention/by-cid/${CID}`, `ipld/retention/by-lease/${hex(leaseEnv.lease.leaseId)}`].sort());

  const byLease = await (await fetchImpl(`https://yataverse.com/.well-known/yataverse-retention/${hex(leaseEnv.lease.leaseId)}.json`)).json();
  const byCid = await (await fetchImpl(`https://yataverse.com/retention/${CID}`)).json();
  assert.deepEqual(byCid, byLease);
  assert.deepEqual(byLease.status, statusEnvelopeToJson(statusEnv));
  assert.equal((await fetchImpl(`https://yataverse.com/retention/${rawCid(Buffer.from('unknown'))}`)).status, 404);
  assert.equal((await fetchImpl(`https://yataverse.com/.well-known/yataverse-retention/${'0'.repeat(64)}.json`)).status, 404);
  assert.equal((await fetchImpl(`https://yataverse.com/retention/${CID}`, { method: 'POST' })).status, 405);

  // The reader verifies what it was given.
  const got = await client.fetchStatus({ cid: CID, now: T + 1000 });
  assert.equal(got.status.status, STATUS.policySatisfied);
  assert.equal(hex(got.lease.leaseId), hex(leaseEnv.lease.leaseId));
  assert.equal((await client.fetchStatus({ leaseId: '0x' + hex(leaseEnv.lease.leaseId), now: T + 1000 })).status.operatorCopies, 1);
  assert.equal(await client.fetchStatus({ cid: rawCid(Buffer.from('unknown')), now: T }), null);
  // The same record again is accepted as a repeat; nothing changes.
  const again = await (await publish(leaseEnv, statusEnv)).json();
  assert.equal(again.repeated, true);
});

test('a status the gateway should not hand out is refused and nothing is stored', async () => {
  const leaseEnv = await leaseEnvFor();
  const good = await statusFor(leaseEnv);
  const other = await leaseEnvFor({ retentionUntil: T + 10 * DAY });
  const flip = (env) => ({ ...env, status: { ...env.status, operatorCopies: 0 } });
  const cases = [
    ['unauthorized', 401, (p) => p(leaseEnv, good, { auth: 'Bearer wrong-token-0123456789' })],
    // The lease names a verifier whose key is not published.
    ['lease-unknown-key', 400, async (p) => { const l = await leaseEnvFor({}, { verifier: 'unpublished' }); return p(l, await statusFor(l, {}, 'unpublished')); }],
    ['lease-key-is-not-a-retention-verifier', 400, async (p) => { const l = await leaseEnvFor({}, { verifier: 'gateway' }); return p(l, await statusFor(l, {}, 'gateway')); }],
    // Another published verifier may not speak about this lease.
    ['status-status-not-from-the-lease-verifier', 400, async (p) => p(leaseEnv, await statusFor(leaseEnv, {}, 'verifier2'))],
    ['path-is-not-the-lease-id', 400, (p) => p(leaseEnv, good, { id: hex(other.lease.leaseId) })],
    ['status-bad-signature', 400, (p) => p(leaseEnv, flip(good))],
    ['status-lease-id-mismatch', 400, async (p) => p(leaseEnv, await statusFor(other))],
    ['status-status-stale', 400, async (p) => p(leaseEnv, await statusFor(leaseEnv, { observedAt: T - 5 * DAY, validUntil: T - 3 * DAY }))],
    ['status-status-from-the-future', 400, async (p) => p(leaseEnv, await statusFor(leaseEnv, { observedAt: T + DAY, validUntil: T + 2 * DAY }))],
    ['status-status-valid-for-too-long', 400, async (p) => p(leaseEnv, await statusFor(leaseEnv, { validUntil: T + 9 * DAY }))],
    ['status-satisfied-without-the-required-copies', 400, async (p) => p(leaseEnv, await statusFor(leaseEnv, { operatorCopies: 0 }))],
    ['lease-bad-requester-signature', 400, (p) => { const sig = new Uint8Array(leaseEnv.sigs.requester.sig); sig[0] ^= 1; return p({ ...leaseEnv, sigs: { ...leaseEnv.sigs, requester: { ...leaseEnv.sigs.requester, sig } } }, good); }],
    ['body-not-json', 400, (p) => p(leaseEnv, good, { body: 'not json' })],
    ['too-large', 413, (p) => p(leaseEnv, good, { body: JSON.stringify({ pad: 'x'.repeat(40_000) }) })],
  ];
  for (const [code, status, send] of cases) {
    const { s, publish } = setup();
    const res = await send(publish);
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).error, code);
    assert.deepEqual(retentionKeys(s), [], `${code}: nothing stored`);
  }
});

test('a stored status is never replaced by an older observation', async () => {
  const { s, publish, client } = setup();
  const leaseEnv = await leaseEnvFor();
  const at = (t, over = {}) => statusFor(leaseEnv, { observedAt: t, validUntil: t + 2 * DAY, ...over });
  assert.equal((await publish(leaseEnv, await at(T))).status, 200);
  const older = await publish(leaseEnv, await at(T - 3600_000));
  assert.equal(older.status, 409); assert.equal((await older.json()).error, 'status-older-than-the-stored-one');
  const sameTime = await publish(leaseEnv, await at(T, { status: STATUS.degraded, operatorCopies: 0 }));
  assert.equal(sameTime.status, 409); assert.equal((await sameTime.json()).error, 'another-status-with-the-same-observation-time');
  assert.equal((await client.fetchStatus({ cid: CID, now: T + 1 })).status.status, STATUS.policySatisfied, 'the first record is still served');
  // A newer observation replaces it, including a worse one.
  assert.equal((await publish(leaseEnv, await at(T + 60_000, { status: STATUS.degraded, operatorCopies: 0 }))).status, 200);
  assert.equal((await client.fetchStatus({ cid: CID, now: T + 61_000 })).status.status, STATUS.degraded);
  assert.equal(s.objects.get(`ipld/retention/by-lease/${hex(leaseEnv.lease.leaseId)}`).length, 2, 'two versions were written');
});

test('for a block under several leases the CID points at the lease that ends last', async () => {
  const { publish, client } = setup();
  const short = await leaseEnvFor({ retentionUntil: T + 10 * DAY }), long = await leaseEnvFor({ retentionUntil: T + 40 * DAY }), mid = await leaseEnvFor({ retentionUntil: T + 20 * DAY });
  assert.equal((await publish(short, await statusFor(short))).status, 200);
  assert.equal(hex((await client.fetchStatus({ cid: CID, now: T + 1 })).lease.leaseId), hex(short.lease.leaseId));
  assert.equal((await publish(long, await statusFor(long))).status, 200);
  assert.equal(hex((await client.fetchStatus({ cid: CID, now: T + 1 })).lease.leaseId), hex(long.lease.leaseId));
  assert.equal((await publish(mid, await statusFor(mid))).status, 200);
  assert.equal(hex((await client.fetchStatus({ cid: CID, now: T + 1 })).lease.leaseId), hex(long.lease.leaseId), 'a shorter lease does not take the pointer');
  // Each lease is still reachable by its own id.
  assert.equal(hex((await client.fetchStatus({ leaseId: hex(mid.lease.leaseId), now: T + 1 })).lease.leaseId), hex(mid.lease.leaseId));
});

test('the reader refuses a record the host altered, a stale one, and one for something else', async () => {
  const { state, publish, client } = setup();
  const leaseEnv = await leaseEnvFor();
  assert.equal((await publish(leaseEnv, await statusFor(leaseEnv))).status, 200);
  const rejects = (p, code) => assert.rejects(p, (e) => e.code === code, code);
  // Stale: the verifier stopped; the state is unknown.
  await rejects(client.fetchStatus({ cid: CID, now: T + 2 * DAY }), 'status-status-stale');
  // The host changes a count in the stored record.
  const edit = (fn) => async (url, init, res) => {
    if ((init.method ?? 'GET') !== 'GET' || !/retention/.test(url) || res.status !== 200) return res;
    const j = await res.json(); fn(j); return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  state.tamper = edit((j) => { j.status.status.operatorCopies = 3; });
  await rejects(client.fetchStatus({ cid: CID, now: T + 1 }), 'status-bad-signature');
  state.tamper = edit((j) => { j.lease.lease.retentionUntil += DAY; });
  await rejects(client.fetchStatus({ cid: CID, now: T + 1 }), 'status-lease-id-mismatch');
  // The host answers a question about one block with the valid record of another.
  const otherBlock = Buffer.from('another block entirely'); const otherLease = await leaseEnvFor({}, { bytes: otherBlock });
  state.tamper = null;
  assert.equal((await publish(otherLease, await statusFor(otherLease))).status, 200);
  const swapped = await client.fetchStatus({ cid: rawCid(otherBlock), now: T + 1 });
  state.tamper = async (url, init, res) => (/\/retention\//.test(url) && (init.method ?? 'GET') === 'GET' ? new Response(JSON.stringify({ lease: leaseEnvelopeToJson(swapped.leaseEnv), status: statusEnvelopeToJson(swapped.statusEnv) }), { status: 200 }) : res);
  await rejects(client.fetchStatus({ cid: CID, now: T + 1 }), 'status-is-for-another-block');
  state.tamper = async (url, init, res) => (/yataverse-retention/.test(url) ? new Response(JSON.stringify({ lease: leaseEnvelopeToJson(swapped.leaseEnv), status: statusEnvelopeToJson(swapped.statusEnv) }), { status: 200 }) : res);
  await rejects(client.fetchStatus({ leaseId: hex(leaseEnv.lease.leaseId), now: T + 1 }), 'status-is-for-another-lease');
});

// --- The sweep and the commands ---

test('retention-verify-sweep runs every lease, keeps going past a broken one, and publishes what it found', async () => {
  const { s, state, fetchImpl, client } = setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-sweep-'));
  process.env.YATAVERSE_CONFIG_DIR = dir; process.env.YATAVERSE_AUTH = `Bearer ${TOKEN}`;
  process.env.YATAVERSE_URL = 'https://yataverse.com'; process.env.YATAVERSE_READ_URL = 'https://yataverse.com';
  const p = (n) => path.join(dir, n);
  try {
    fs.writeFileSync(p('keys.json'), JSON.stringify(KEYS));
    fs.writeFileSync(p('verifier.jwk'), JSON.stringify(K.verifier.jwk), { mode: 0o600 });
    const reg = p('registry'); fs.mkdirSync(reg);
    // a: a leased write happened. b: a lease with no receipt at all. c: a file that is not a lease.
    const a = await leaseEnvFor({ notBefore: T - 1000 });
    const put = await client.putBytes(BLOCK, { lease: a });
    fs.writeFileSync(path.join(reg, 'a.lease.json'), JSON.stringify(leaseEnvelopeToJson(a)));
    fs.writeFileSync(path.join(reg, 'a.write.json'), JSON.stringify(put));
    const other = Buffer.from('never written under a lease'); const b = await leaseEnvFor({}, { bytes: other });
    fs.writeFileSync(path.join(reg, 'b.lease.json'), JSON.stringify(leaseEnvelopeToJson(b)));
    fs.writeFileSync(path.join(reg, 'c.lease.json'), '{"not":"a lease"}');
    const run = async (argv) => {
      let out = '', err = '';
      const code = await main(argv, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, fetchImpl, now: () => state.clock,
        env: { YATAVERSE_ARCHIVE_KEY_ID: 'lockkid', YATAVERSE_ARCHIVE_APP_KEY: 'x' } });
      return { code, out, err, json: out ? JSON.parse(out) : null };
    };
    state.clock = T + 3600_000;
    const sweep = ['retention-verify-sweep', '--registry', reg, '--keys', p('keys.json'), '--signing-key-file', p('verifier.jwk'), '--key-epoch', '1',
      '--archive-endpoint', 'https://s3.us-west-004.backblazeb2.com', '--archive-bucket', 'bucket', '--archive-prefix', 'ipld/', '--sample-read', 'true'];
    // Without --publish: files only.
    const dry = await run(sweep);
    assert.equal(dry.code, 1, 'one lease could not be processed');
    assert.deepEqual([dry.json.leases, dry.json.policySatisfied, dry.json.degraded, dry.json.failed], [3, 1, 1, 1]);
    assert.deepEqual(dry.json.results.map((r) => [r.name, r.status ?? r.error, r.published ?? null]), [['a', 'policy-satisfied', false], ['b', 'degraded', false], ['c', 'not-a-v1-lease', null]]);
    assert.ok(fs.existsSync(path.join(reg, 'a.status.json')) && fs.existsSync(path.join(reg, 'b.evidence.cbor')) && !fs.existsSync(path.join(reg, 'c.status.json')));
    assert.deepEqual(retentionKeys(s), [], 'nothing was published');

    // With --publish: the records and their evidence become readable from the host.
    state.clock = T + 2 * 3600_000;
    const pub = await run([...sweep, '--publish', 'true']);
    assert.deepEqual(pub.json.results.map((r) => [r.name, r.published ?? null]), [['a', true], ['b', true], ['c', null]]);
    const st = await run(['retention-status', '--cid', CID, '--keys', p('keys.json')]);
    assert.equal(st.code, 0, st.err);
    assert.deepEqual([st.json.source, st.json.status, st.json.satisfied, st.json.operatorCopies], ['published', 'policy-satisfied', true, 1]);
    assert.equal(st.json.observedAt, new Date(T + 2 * 3600_000).toISOString());
    const evidence = await client.get(st.json.evidenceCid);
    assert.ok(evidence && crypto.createHash('sha256').update(evidence).digest('hex') === st.json.evidenceRoot.slice(2), 'the status leads to its evidence record');
    const stB = await run(['retention-status', '--lease-id', '0x' + hex(b.lease.leaseId), '--keys', p('keys.json')]);
    assert.deepEqual([stB.json.status, stB.json.satisfied, stB.json.countsMeetTheGrade], ['degraded', false, false]);
    // A block nobody published a status for: unknown, and the command says so.
    const none = await run(['retention-status', '--cid', rawCid(Buffer.from('no status')), '--keys', p('keys.json')]);
    assert.equal(none.code, 1); assert.match(none.err, /no published status/);
    // When the verifier stops, what was published goes stale and is refused.
    state.clock = T + 3 * DAY;
    const stale = await run(['retention-status', '--cid', CID, '--keys', p('keys.json')]);
    assert.equal(stale.code, 1); assert.match(stale.err, /status-status-stale/);

    // retention-publish on its own, with evidence that does not belong to the status.
    state.clock = T + 3 * 3600_000;
    fs.writeFileSync(p('wrong.cbor'), fs.readFileSync(path.join(reg, 'b.evidence.cbor')));
    const mismatch = await run(['retention-publish', '--status', path.join(reg, 'a.status.json'), '--lease', path.join(reg, 'a.lease.json'), '--evidence', p('wrong.cbor'), '--keys', p('keys.json')]);
    assert.equal(mismatch.code, 1); assert.match(mismatch.err, /evidence-does-not-match-the-status/);
    const repeat = await run(['retention-publish', '--status', path.join(reg, 'a.status.json'), '--lease', path.join(reg, 'a.lease.json'), '--evidence', path.join(reg, 'a.evidence.cbor'), '--keys', p('keys.json')]);
    assert.equal(repeat.code, 0, repeat.err); assert.equal(repeat.json.repeated, true);
    assert.equal((await run(['retention-verify-sweep', '--registry', reg])).code, 2);
    assert.equal((await run(['retention-publish', '--lease', 'x'])).code, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
