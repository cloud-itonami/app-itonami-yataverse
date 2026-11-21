// The retention commands end to end (docs/retention-design.md §11; AWAI-3679): keygen, lease
// proposal, co-signature, a leased write through the Worker, one verifier run, and the status check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';
import { handle } from '../worker/src/index.mjs';
import { KEY_USE } from '../src/receipt.mjs';
import { rawCid } from '../src/cid.mjs';
import { TOKEN, ENV, UNLIMITED, receiptKey } from './worker-fixtures.mjs';
import { lockStore } from './lock-store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-retention-cli-'));
process.env.YATAVERSE_CONFIG_DIR = dir;                    // never read the operator's real config
process.env.YATAVERSE_AUTH = `Bearer ${TOKEN}`;
process.env.YATAVERSE_URL = 'https://yataverse.com'; process.env.YATAVERSE_READ_URL = 'https://yataverse.com';
const T = Date.parse('2026-11-18T00:00:00Z'), DAY = 86_400_000;
const p = (name) => path.join(dir, name);
const readJson = (name) => JSON.parse(fs.readFileSync(p(name), 'utf8'));
const BLOCK = Buffer.from('kept through the command line'); fs.writeFileSync(p('block.bin'), BLOCK);
const CID = rawCid(BLOCK);

function world() {
  const s = lockStore();
  const gateway = receiptKey(), archive = receiptKey({ use: [KEY_USE.operatorArchiveReceipt] });
  const state = { keys: { v: 1, signer: 'did:web:yataverse.com', keys: [gateway.keys.keys[0], archive.keys.keys[0]] }, clock: T, tamper: null, intercept: null };
  const envFor = () => ({ ...ENV, RECEIPT_SIGNING_KEY: JSON.stringify(gateway.jwk), ARCHIVE_RECEIPT_SIGNING_KEY: JSON.stringify(archive.jwk),
    RECEIPT_PUBLIC_KEYS: state.keys, B2_LOCK_KEY_ID: 'lockkid', B2_LOCK_APP_KEY: 'locksecret', WRITE_REQUEST_LIMITER: UNLIMITED, WRITE_MIB_LIMITER: UNLIMITED });
  // The CLI talks to the Worker handler; the archive probe talks to the fake store directly.
  const fetchImpl = async (url, init = {}) => {
    if (new URL(url).host === 's3.us-west-004.backblazeb2.com') return s.fetchImpl(url, init);
    const instead = state.intercept ? state.intercept(init) : null;   // answer without reaching the Worker
    if (instead) return instead;
    const res = await handle(new Request(url, init), envFor(), { fetchImpl: s.fetchImpl, now: () => new Date(state.clock) });
    return state.tamper ? state.tamper(init, res) : res;
  };
  const run = async (argv) => {
    let out = '', err = '';
    const code = await main(argv, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, fetchImpl, now: () => state.clock,
      env: { YATAVERSE_ARCHIVE_KEY_ID: 'lockkid', YATAVERSE_ARCHIVE_APP_KEY: 'x' } });
    return { code, out, err, json: code === 0 && out ? JSON.parse(out) : null };
  };
  return { s, state, run, envFor };
}

test('keygen, lease-new, lease-cosign, put --lease, one verifier run and retention-status fit together', async () => {
  const { s, state, run } = world();
  // Keys. The private halves stay in the files.
  const rq = await run(['retention-keygen', p('requester.jwk')]);
  const vf = await run(['retention-keygen', p('verifier.jwk')]);
  assert.equal(rq.code, 0, rq.err); assert.match(vf.json.keyId, /^0x[0-9a-f]{64}$/);
  assert.equal(fs.statSync(p('verifier.jwk')).mode & 0o077, 0, 'owner-readable only');
  const privateD = readJson('verifier.jwk').d;
  assert.ok(!vf.out.includes(privateD), 'the private key is not printed');
  const again = await run(['retention-keygen', p('verifier.jwk')]);
  assert.equal(again.code, 1, 'an existing key file is never overwritten');
  assert.equal(readJson('verifier.jwk').d, privateD);
  // The operator publishes the verifier key for that use.
  state.keys = { ...state.keys, keys: [...state.keys.keys, { keyId: vf.json.keyId, keyEpoch: 1, alg: 'Ed25519', publicKeyJwk: vf.json.publicKeyJwk,
    notBefore: 0, notAfter: null, revokedAt: null, use: [KEY_USE.retentionVerifier] }] };
  fs.writeFileSync(p('keys.json'), JSON.stringify(state.keys));

  // The requester proposes; the verifier co-signs.
  const prop = await run(['lease-new', '--file', p('block.bin'), '--until', '30d', '--verifier', vf.json.keyId, '--requester-key-file', p('requester.jwk'), '-o', p('proposal.json')]);
  assert.equal(prop.code, 0, prop.err);
  assert.equal(prop.json.cid, CID);
  assert.equal(prop.json.retentionUntil, new Date(T + 30 * DAY).toISOString());
  assert.equal(readJson('proposal.json').sigs.verifier, undefined);
  // A proposal is not a lease: a write with it is refused before anything is sent.
  const early = await run(['put', p('block.bin'), '--lease', p('proposal.json')]);
  assert.equal(early.code, 1); assert.match(early.err, /bad-signature-encoding|not-a-v1-lease/);
  assert.equal(s.blockVersions(CID).length, 0);
  // Only the verifier the proposal names can complete it.
  const wrong = await run(['lease-cosign', '--lease', p('proposal.json'), '--signing-key-file', p('requester.jwk')]);
  assert.equal(wrong.code, 1); assert.match(wrong.err, /lease-verifier-is-not-the-signer/);
  const tampered = readJson('proposal.json'); tampered.lease.retentionUntil += DAY;
  fs.writeFileSync(p('tampered.json'), JSON.stringify(tampered));
  const bad = await run(['lease-cosign', '--lease', p('tampered.json'), '--signing-key-file', p('verifier.jwk')]);
  assert.equal(bad.code, 1); assert.match(bad.err, /lease-id-mismatch/);
  const co = await run(['lease-cosign', '--lease', p('proposal.json'), '--signing-key-file', p('verifier.jwk'), '-o', p('lease.json')]);
  assert.equal(co.code, 0, co.err); assert.equal(co.json.leaseId, prop.json.leaseId);

  // The leased write.
  const put = await run(['put', p('block.bin'), '--lease', p('lease.json')]);
  assert.equal(put.code, 0, put.err);
  assert.equal(put.json.cid, CID); assert.equal(put.json.receiptVerified, true);
  assert.equal(put.json.receipt.receipt.storeClass, 3);
  assert.equal(put.json.archive.leaseId, prop.json.leaseId);
  assert.equal(put.json.archive.lockMode, 'COMPLIANCE');
  assert.equal(put.json.archive.retentionUntil, new Date(T + 30 * DAY).toISOString());
  assert.equal(s.lockedVersions().length, 1);
  fs.writeFileSync(p('write.json'), put.out);

  // The verifier runs once, checking the version the write named, and the status record checks out.
  state.clock = T + DAY;
  const ver = await run(['retention-verify-once', '--lease', p('lease.json'), '--keys', p('keys.json'), '--signing-key-file', p('verifier.jwk'), '--key-epoch', '1',
    '--receipts', p('write.json'), '--archive-endpoint', 'https://s3.us-west-004.backblazeb2.com', '--archive-bucket', 'bucket', '--archive-prefix', 'ipld/', '--sample-read', 'true']);
  assert.equal(ver.code, 0, ver.err);
  assert.equal(ver.json.summary.status, 'policy-satisfied');
  assert.equal(ver.json.summary.checks[0].version, put.json.archive.versionId);
  fs.writeFileSync(p('status.json'), ver.out);
  const st = await run(['retention-status', '--status', p('status.json'), '--lease', p('lease.json'), '--keys', p('keys.json')]);
  assert.equal(st.code, 0, st.err);
  assert.deepEqual([st.json.verified, st.json.status, st.json.satisfied, st.json.grade, st.json.operatorCopies, st.json.countsMeetTheGrade], [true, 'policy-satisfied', true, 'R1', 1, true]);
  assert.equal(st.json.leaseId, prop.json.leaseId);
  assert.equal(st.json.validUntil, new Date(T + 3 * DAY).toISOString());

  // Past validUntil the record is refused: the state is unknown, not "still satisfied".
  state.clock = T + 3 * DAY;
  const stale = await run(['retention-status', '--status', p('status.json'), '--lease', p('lease.json'), '--keys', p('keys.json')]);
  assert.equal(stale.code, 1); assert.match(stale.err, /status-stale/); assert.equal(stale.out, '');
  // A status for another lease does not pass for this one.
  state.clock = T + DAY;
  const prop2 = await run(['lease-new', '--file', p('block.bin'), '--until', '10d', '--verifier', vf.json.keyId, '--requester-key-file', p('requester.jwk'), '-o', p('proposal2.json')]);
  assert.equal(prop2.code, 0, prop2.err);
  assert.equal((await run(['lease-cosign', '--lease', p('proposal2.json'), '--signing-key-file', p('verifier.jwk'), '-o', p('lease2.json')])).code, 0);
  const other = await run(['retention-status', '--status', p('status.json'), '--lease', p('lease2.json'), '--keys', p('keys.json')]);
  assert.equal(other.code, 1); assert.match(other.err, /lease-id-mismatch/);
  // A key file other users can read is refused.
  fs.writeFileSync(p('loose.jwk'), fs.readFileSync(p('requester.jwk'))); fs.chmodSync(p('loose.jwk'), 0o644);
  const loose = await run(['lease-new', '--file', p('block.bin'), '--until', '5d', '--verifier', vf.json.keyId, '--requester-key-file', p('loose.jwk')]);
  assert.equal(loose.code, 1); assert.match(loose.err, /signing-key-file-is-readable-by-others/);
  for (const argv of [['lease-new', '--file', p('block.bin')], ['lease-cosign'], ['retention-status', '--lease', p('lease.json')], ['retention-keygen']]) assert.equal((await run(argv)).code, 2);
  assert.equal((await run(['lease-new', '--file', p('block.bin'), '--until', 'soon', '--verifier', vf.json.keyId, '--requester-key-file', p('requester.jwk')])).code, 2);
});

test('put --lease fails when the answer is not the retention promise that was asked for', async () => {
  const { s, state, run, envFor } = world();
  const vf = await run(['retention-keygen', p('v2.jwk')]); await run(['retention-keygen', p('r2.jwk')]);
  state.keys = { ...state.keys, keys: [...state.keys.keys, { keyId: vf.json.keyId, keyEpoch: 1, alg: 'Ed25519', publicKeyJwk: vf.json.publicKeyJwk,
    notBefore: 0, notAfter: null, revokedAt: null, use: [KEY_USE.retentionVerifier] }] };
  const mk = async (name, until) => {
    assert.equal((await run(['lease-new', '--file', p('block.bin'), '--until', until, '--verifier', vf.json.keyId, '--requester-key-file', p('r2.jwk'), '-o', p(`${name}.prop.json`)])).code, 0);
    assert.equal((await run(['lease-cosign', '--lease', p(`${name}.prop.json`), '--signing-key-file', p('v2.jwk'), '-o', p(`${name}.json`)])).code, 0);
  };
  await mk('a', '20d'); await mk('b', '21d');
  // 1. The host answers a leased write with an ordinary gateway receipt (as an old Worker that
  //    ignores the lease header would).
  const { handle: h } = await import('../worker/src/index.mjs');
  state.tamper = async (init, res) => {
    if (init.method !== 'PUT') return res;
    const plain = new Request('https://yataverse.com/ipfs/' + CID, { method: 'PUT', body: init.body, headers: Object.fromEntries(Object.entries(init.headers).filter(([k]) => k !== 'yataverse-lease')) });
    return h(plain, envFor(), { fetchImpl: s.fetchImpl, now: () => new Date(T) });
  };
  let r = await run(['put', p('block.bin'), '--lease', p('a.json')]);
  assert.equal(r.code, 1, r.out); assert.match(r.err, /leased-put-answered-without-a-retention-receipt/);
  // 2. A retention receipt for another lease is passed off as the answer.
  state.tamper = null;
  const forB = await run(['put', p('block.bin'), '--lease', p('b.json'), '--request-id', 'ee'.repeat(32)]);
  assert.equal(forB.code, 0, forB.err);
  state.intercept = (init) => (init.method === 'PUT' ? new Response(JSON.stringify({ cid: CID, bytes: BLOCK.length, verified: true, receipt: forB.json.receipt,
    receiptCid: forB.json.receiptCid, archive: { versionId: 'v1', lockMode: 'COMPLIANCE' } }), { status: 201, headers: { 'content-type': 'application/json' } }) : null);
  r = await run(['put', p('block.bin'), '--lease', p('a.json'), '--request-id', 'ee'.repeat(32)]);
  assert.equal(r.code, 1, r.out); assert.match(r.err, /leased-put-receipt-is-for-another-lease/);
  state.intercept = null;
  // 3. The host's refusal code reaches the user.
  state.tamper = null; state.clock = T + 40 * DAY;
  r = await run(['put', p('block.bin'), '--lease', p('a.json')]);
  assert.equal(r.code, 1); assert.match(r.err, /leased-put-lease-expired/);
  // 4. A lease for other bytes is refused locally, before any request.
  state.clock = T; const before = s.log.length;
  fs.writeFileSync(p('other.bin'), 'not the leased block');
  r = await run(['put', p('other.bin'), '--lease', p('a.json')]);
  assert.equal(r.code, 1); assert.match(r.err, /lease-is-for-another-block/);
  assert.equal(s.log.length, before, 'nothing was sent to the store');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
