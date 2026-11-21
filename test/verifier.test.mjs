// The minimal retention verifier (docs/retention-design.md §6, §8; AWAI-3671): evidence checks,
// the archive probe and the one-run command. The archive is a fake; no real bucket is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { KIND, STATE, STORE_CLASS, KEY_USE, importSigningKey, signReceipt, envelopeToJson, ZERO32 } from '../src/receipt.mjs';
import {
  GRADE, STATUS, leaseFromTerms, signLeaseAsRequester, signLeaseAsVerifier, leaseEnvelopeToJson,
  verifyStatus, statusEnvelopeFromJson, inventoryRecord, RetentionError,
} from '../src/retention.mjs';
import { runVerifierOnce, checkArchiveCopy, blocksOf, VerifierError } from '../src/verifier.mjs';
import { makeArchiveProbe, ArchiveProbeError } from '../src/archive-probe.mjs';
import { decodeDagCbor } from '../src/dag-cbor.mjs';
import { rawCid, cidToBytes } from '../src/cid.mjs';
import { main } from '../src/cli.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const fill = (n) => new Uint8Array(32).fill(n);
const T0 = 1_800_000_000_000, DAY = 86_400_000;
const BLOCK = Buffer.from('verifier test block'), CID = rawCid(BLOCK);

function newKeyJwk() {
  const j = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  return { kty: j.kty, crv: j.crv, d: j.d, x: j.x };
}
const keyEntry = (signer, jwk, extra = {}) => ({ keyId: '0x' + hex(signer.keyId), keyEpoch: 1, alg: 'Ed25519',
  publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, notBefore: 0, notAfter: null, revokedAt: null, ...extra });

async function world() {
  const jwks = { requester: newKeyJwk(), verifier: newKeyJwk(), gateway: newKeyJwk(), archive: newKeyJwk(), provider: newKeyJwk(), other: newKeyJwk() };
  const s = {};
  for (const [k, j] of Object.entries(jwks)) s[k] = await importSigningKey(j);
  const keys = { v: 1, signer: 'did:web:yataverse.com', keys: [
    keyEntry(s.verifier, jwks.verifier, { use: [KEY_USE.retentionVerifier] }),
    keyEntry(s.other, jwks.other, { use: [KEY_USE.retentionVerifier] }),
    keyEntry(s.gateway, jwks.gateway),
    keyEntry(s.archive, jwks.archive, { use: [KEY_USE.operatorArchiveReceipt] }),
    keyEntry(s.provider, jwks.provider, { use: [KEY_USE.providerReceipt] }),
  ] };
  return { jwks, s, keys };
}
const terms = (s, over = {}) => ({ subject: cidToBytes(CID), size: BLOCK.length, pieceCommitment: ZERO32, grade: GRADE.R1, providerReplicas: 0,
  domainPolicy: fill(3), notBefore: T0, retentionUntil: T0 + 90 * DAY, challengePeriod: 86_400,
  requester: s.requester.keyId, verifier: s.verifier.keyId, policyRevision: fill(4), ...over });
async function leaseEnvFor(s, t) {
  const lease = leaseFromTerms(t);
  return { v: 1, lease, sigs: { requester: await signLeaseAsRequester(lease, s.requester), verifier: await signLeaseAsVerifier(lease, s.verifier) } };
}
const receiptFields = (signer, lease, over = {}, bytes = BLOCK) => ({
  kind: KIND.block, subject: cidToBytes(rawCid(bytes)), size: bytes.length, contentDigest: sha256(bytes), requestId: fill(1), requester: fill(2),
  reservationId: ZERO32, leaseId: lease.leaseId, pieceCommitment: ZERO32, policyRevision: fill(4), state: STATE.localDurableReadback,
  storeClass: STORE_CLASS.operatorArchive, acceptedAt: T0 + 1000, retentionUntil: lease.retentionUntil, keyId: signer.keyId, keyEpoch: 1, ...over });
const archiveReceipt = (s, lease, over, bytes) => signReceipt(receiptFields(s.archive, lease, over, bytes), s.archive);

/** An in-memory archive: cid -> { bytes, lockMode, retainUntil }. */
function fakeArchive(entries) {
  const m = new Map(entries);
  return { m, head: async (cid) => { const e = m.get(cid); return e ? { size: e.size ?? e.bytes.length, lockMode: e.lockMode ?? '', retainUntil: e.retainUntil ?? null } : null; },
           read: async (cid) => new Uint8Array(m.get(cid).served ?? m.get(cid).bytes) };
}
const locked = (lease, over = {}) => ({ bytes: BLOCK, lockMode: 'COMPLIANCE', retainUntil: lease.retentionUntil, ...over });
const NOW = T0 + DAY;
const evidenceOf = (run) => decodeDagCbor(run.evidence.bytes).value;

test('R1: a counted receipt and a locked archive copy give policy-satisfied, and the status verifies', async () => {
  const { s, keys } = await world();
  const leaseEnv = await leaseEnvFor(s, terms(s));
  const run = await runVerifierOnce({ leaseEnv, receiptEnvs: [await archiveReceipt(s, leaseEnv.lease)], keys,
    probe: fakeArchive([[CID, locked(leaseEnv.lease)]]), signer: s.verifier, keyEpoch: 1, now: NOW, sampleRead: true });
  assert.equal(run.summary.status, 'policy-satisfied');
  assert.deepEqual([run.summary.operatorCopies, run.summary.providerReplicas], [1, 0]);
  assert.equal(run.summary.checks[0].read, true);
  const st = await verifyStatus(run.status, leaseEnv.lease, keys, { now: NOW + 1 });
  assert.equal(st.status, STATUS.policySatisfied);
  assert.equal(st.validUntil, NOW + 2 * DAY, 'valid for two challenge periods');
  // The status commits to the evidence record that was returned.
  assert.equal(hex(st.evidenceRoot), hex(sha256(run.evidence.bytes)));
  const ev = evidenceOf(run);
  assert.equal(ev.get('receipts').length, 1);
  assert.equal(ev.get('checks')[0].get('ok'), true);
  // Past validUntil, a reader no longer accepts it: a stopped verifier means "unknown".
  await assert.rejects(verifyStatus(run.status, leaseEnv.lease, keys, { now: NOW + 2 * DAY }), /status-stale/);
});

test('each failing archive check degrades the lease and names the reason', async () => {
  const { s, keys } = await world();
  const leaseEnv = await leaseEnvFor(s, terms(s));
  const lease = leaseEnv.lease;
  const receiptEnvs = [await archiveReceipt(s, lease)];
  const cases = [
    ['object-missing', fakeArchive([])],
    ['size-mismatch', fakeArchive([[CID, locked(lease, { size: BLOCK.length + 1 })]])],
    ['not-locked', fakeArchive([[CID, { bytes: BLOCK }]])],
    ['lock-is-not-compliance-mode', fakeArchive([[CID, locked(lease, { lockMode: 'GOVERNANCE' })]])],
    ['lock-ends-before-the-lease', fakeArchive([[CID, locked(lease, { retainUntil: lease.retentionUntil - 1 })]])],
    ['lock-ends-before-the-lease', fakeArchive([[CID, locked(lease, { retainUntil: null })]])],
    ['content-mismatch', fakeArchive([[CID, locked(lease, { served: Buffer.from('verifier test blocK') })]])],
    ['probe-failed:head-http-503', { head: async () => { throw new ArchiveProbeError('head-http-503'); }, read: async () => BLOCK }],
    ['no-archive-probe', null],
  ];
  for (const [reason, probe] of cases) {
    const run = await runVerifierOnce({ leaseEnv, receiptEnvs, keys, probe, signer: s.verifier, keyEpoch: 1, now: NOW, sampleRead: true });
    assert.equal(run.summary.status, 'degraded', reason);
    assert.equal(run.summary.operatorCopies, 0, reason);
    assert.equal(run.summary.checks[0].reason, reason);
    assert.equal(evidenceOf(run).get('checks')[0].get('reason'), reason, 'the reason is in the evidence record');
    assert.equal((await verifyStatus(run.status, lease, keys, { now: NOW + 1 })).status, STATUS.degraded);
  }
  // Without the full read, a store that would serve other bytes is not caught: the check says so.
  const unread = await runVerifierOnce({ leaseEnv, receiptEnvs, keys, signer: s.verifier, keyEpoch: 1, now: NOW,
    probe: fakeArchive([[CID, locked(lease, { served: Buffer.from('verifier test blocK') })]]) });
  assert.equal(unread.summary.status, 'policy-satisfied');
  assert.equal(unread.summary.checks[0].read, false);
});

test('receipts that do not count leave the lease degraded', async () => {
  const { s, keys } = await world();
  const leaseEnv = await leaseEnvFor(s, terms(s));
  const lease = leaseEnv.lease;
  const probe = fakeArchive([[CID, locked(lease)]]);
  const run = (receiptEnvs) => runVerifierOnce({ leaseEnv, receiptEnvs, keys, probe, signer: s.verifier, keyEpoch: 1, now: NOW });
  const expectDegraded = async (receiptEnvs, note) => {
    const r = await run(receiptEnvs);
    assert.equal(r.summary.status, 'degraded', note);
    assert.equal(r.summary.checks[0].reason, 'no-operator-archive-receipt', note);
    if (receiptEnvs.length) assert.ok(r.summary.notes.some((n) => n.includes(note)), `${note} in ${JSON.stringify(r.summary.notes)}`);
  };
  await expectDegraded([], 'none');
  const otherLease = leaseFromTerms(terms(s, { retentionUntil: T0 + 30 * DAY }));
  await expectDegraded([await archiveReceipt(s, otherLease)], 'receipt-is-for-another-lease');
  await expectDegraded([await archiveReceipt(s, lease, { retentionUntil: lease.retentionUntil - 1 })], 'receipt-promises-less-than-the-lease');
  // A gateway receipt alone: the bytes were accepted, nothing was promised.
  const gw = await signReceipt(receiptFields(s.gateway, lease, { storeClass: STORE_CLASS.edgeGateway, leaseId: ZERO32, retentionUntil: 0 }), s.gateway);
  await expectDegraded([gw], 'gateway-receipt-is-not-counted');
  // An archive-class receipt signed with the gateway key.
  await expectDegraded([await signReceipt(receiptFields(s.gateway, lease), s.gateway)], 'key-not-allowed-for-store-class');
  // A tampered receipt.
  const good = await archiveReceipt(s, lease);
  await expectDegraded([{ ...good, receipt: { ...good.receipt, size: good.receipt.size + 1 } }], 'bad-signature');
  // A valid receipt for a block the lease does not cover.
  await expectDegraded([await archiveReceipt(s, lease, {}, Buffer.from('another block'))], 'block-not-in-lease');
});

test('the term decides expired and not-started', async () => {
  const { s, keys } = await world();
  const leaseEnv = await leaseEnvFor(s, terms(s));
  const lease = leaseEnv.lease;
  const args = { leaseEnv, receiptEnvs: [await archiveReceipt(s, lease)], keys, probe: fakeArchive([[CID, locked(lease)]]), signer: s.verifier, keyEpoch: 1 };
  const after = await runVerifierOnce({ ...args, now: lease.retentionUntil });
  assert.equal(after.summary.status, 'expired');
  await verifyStatus(after.status, lease, keys, { now: lease.retentionUntil + 1 });
  const before = await runVerifierOnce({ ...args, now: T0 - 1 });
  assert.equal(before.summary.status, 'degraded');
  assert.ok(before.summary.notes.includes('the lease has not started'));
  // Just before the end, "satisfied" is not valid beyond the term.
  const late = await runVerifierOnce({ ...args, now: lease.retentionUntil - 1000 });
  assert.equal(late.summary.status, 'policy-satisfied');
  assert.equal(late.status.status.validUntil, lease.retentionUntil);
});

test('R2 and R3 stay degraded: this verifier cannot count provider replicas', async () => {
  const { s, keys } = await world();
  for (const [grade, providerReplicas] of [[GRADE.R2, 1], [GRADE.R3, 3]]) {
    const leaseEnv = await leaseEnvFor(s, terms(s, { grade, providerReplicas, pieceCommitment: fill(7) }));
    const lease = leaseEnv.lease;
    const provider = await signReceipt(receiptFields(s.provider, lease, { storeClass: STORE_CLASS.providerNode, pieceCommitment: lease.pieceCommitment }), s.provider);
    const run = await runVerifierOnce({ leaseEnv, receiptEnvs: [await archiveReceipt(s, lease), provider], keys,
      probe: fakeArchive([[CID, locked(lease)]]), signer: s.verifier, keyEpoch: 1, now: NOW });
    assert.equal(run.summary.status, 'degraded', `grade ${grade}`);
    assert.deepEqual([run.summary.operatorCopies, run.summary.providerReplicas], [1, 0]);
    assert.ok(run.summary.notes.some((n) => n.includes('provider proofs are not implemented')));
    await verifyStatus(run.status, lease, keys, { now: NOW + 1 });
  }
});

test('no status is issued for a bad lease or by a key that is not its verifier', async () => {
  const { s, keys } = await world();
  const leaseEnv = await leaseEnvFor(s, terms(s));
  const base = { leaseEnv, receiptEnvs: [], keys, probe: null, keyEpoch: 1, now: NOW };
  const rejects = (p, code) => assert.rejects(p, (e) => (e instanceof VerifierError || e instanceof RetentionError) && e.code === code, code);
  // `other` is a published retention verifier, but not the one this lease names.
  await rejects(runVerifierOnce({ ...base, signer: s.other }), 'signer-is-not-the-lease-verifier');
  await rejects(runVerifierOnce({ ...base, signer: s.verifier, leaseEnv: { ...leaseEnv, sigs: { verifier: leaseEnv.sigs.verifier } } }), 'lease-requester-signature-missing');
  await rejects(runVerifierOnce({ ...base, signer: s.verifier, now: undefined }), 'now-required');
  await rejects(runVerifierOnce({ ...base, signer: s.verifier, keyEpoch: undefined }), 'key-epoch-required');
});

test('a lease over several blocks needs its inventory and every block', async () => {
  const { s, keys } = await world();
  const a = Buffer.from('block a'), b = Buffer.from('block bb');
  const cids = [rawCid(a), rawCid(b)];
  const leaseEnv = await leaseEnvFor(s, terms(s, { subject: inventoryRecord(cids).commitment, size: a.length + b.length }));
  const lease = leaseEnv.lease;
  const receiptEnvs = [await archiveReceipt(s, lease, {}, a), await archiveReceipt(s, lease, {}, b)];
  const both = fakeArchive([[cids[0], locked(lease, { bytes: a })], [cids[1], locked(lease, { bytes: b })]]);
  const args = { leaseEnv, receiptEnvs, keys, signer: s.verifier, keyEpoch: 1, now: NOW, sampleRead: true };
  assert.equal((await runVerifierOnce({ ...args, probe: both, inventory: [...cids].reverse() })).summary.status, 'policy-satisfied');
  const one = await runVerifierOnce({ ...args, probe: fakeArchive([[cids[0], locked(lease, { bytes: a })]]), inventory: cids });
  assert.equal(one.summary.status, 'degraded');
  assert.equal(one.summary.checks.filter((c) => !c.ok).length, 1);
  await assert.rejects(runVerifierOnce({ ...args, probe: both }), /inventory-required/);
  await assert.rejects(runVerifierOnce({ ...args, probe: both, inventory: [cids[0]] }), /inventory-does-not-match-lease-subject/);
  assert.deepEqual(blocksOf(lease, cids), [...cids].sort());
});

// --- The S3-compatible probe, against a local fake server ---

function startFakeS3(objects) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '', date: req.headers['x-amz-date'] ?? '' });
    const o = objects.get(req.url);
    if (!/^AWS4-HMAC-SHA256 Credential=test-key-id\//.test(req.headers.authorization ?? '')) { res.writeHead(403); return res.end(); }
    if (req.url.endsWith('/boom')) { res.writeHead(500); return res.end(); }
    if (!o) { res.writeHead(404); return res.end(); }
    if (req.method !== 'HEAD' && req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const h = { 'content-length': String(o.bytes.length) };
    if (o.lockMode) h['x-amz-object-lock-mode'] = o.lockMode;
    if (o.retainUntil) h['x-amz-object-lock-retain-until-date'] = new Date(o.retainUntil).toISOString();
    res.writeHead(200, h);
    res.end(req.method === 'GET' ? o.bytes : undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ log, endpoint: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

test('the archive probe reads length and lock from HEAD, and only reads', async () => {
  const until = T0 + 90 * DAY;
  const srv = await startFakeS3(new Map([[`/archive/keep/${CID}`, { bytes: BLOCK, lockMode: 'COMPLIANCE', retainUntil: until }],
                                         [`/archive/keep/${rawCid(Buffer.from('plain'))}`, { bytes: Buffer.from('plain') }]]));
  try {
    const probe = makeArchiveProbe({ endpoint: srv.endpoint, bucket: 'archive', prefix: 'keep/', keyId: 'test-key-id', secret: 'test-secret', region: 'us-west-004' });
    assert.deepEqual(await probe.head(CID), { size: BLOCK.length, lockMode: 'COMPLIANCE', retainUntil: until, versionId: '' });
    assert.deepEqual(await probe.head(rawCid(Buffer.from('plain'))), { size: 5, lockMode: '', retainUntil: null, versionId: '' });
    assert.equal(await probe.head(rawCid(Buffer.from('absent'))), null);
    assert.equal(Buffer.from(await probe.read(CID)).toString(), BLOCK.toString());
    await assert.rejects(probe.head('boom'), /bad-cid/);
    assert.ok(srv.log.every((r) => r.method === 'HEAD' || r.method === 'GET'), 'no write, delete or lock request is ever sent');
    assert.ok(srv.log.every((r) => /^\d{8}T\d{6}Z$/.test(r.date)));
    // Wrong credentials: the store refuses, and the check reports a failed probe instead of a pass.
    const wrong = makeArchiveProbe({ endpoint: srv.endpoint, bucket: 'archive', prefix: 'keep/', keyId: 'someone-else', secret: 'x', region: 'us-west-004' });
    await assert.rejects(wrong.head(CID), (e) => e instanceof ArchiveProbeError && e.code === 'head-http-403');
    const c = await checkArchiveCopy(wrong, CID, { size: BLOCK.length, contentDigest: sha256(BLOCK) }, { retentionUntil: until });
    assert.deepEqual([c.ok, c.reason], [false, 'probe-failed:head-http-403']);
  } finally { await srv.close(); }
  assert.throws(() => makeArchiveProbe({ endpoint: 'http://example.com', bucket: 'b', keyId: 'k', secret: 's', region: 'r' }), /archive-endpoint-not-https/);
  assert.throws(() => makeArchiveProbe({ endpoint: 'https://example.com', bucket: 'b', keyId: 'k', secret: 's' }), /archive-region-unknown/);
  assert.throws(() => makeArchiveProbe({ endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'b' }), /archive-probe-not-configured/);
});

// --- The one-run command ---

test('retention-verify-once prints a signed status and never the signing key', async () => {
  const { jwks, s, keys } = await world();
  const leaseEnv = await leaseEnvFor(s, terms(s));
  const lease = leaseEnv.lease;
  const srv = await startFakeS3(new Map([[`/archive/keep/${CID}`, { bytes: BLOCK, lockMode: 'COMPLIANCE', retainUntil: lease.retentionUntil }]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-verifier-'));
  const write = (name, data, mode) => { const p = path.join(dir, name); fs.writeFileSync(p, data, mode ? { mode } : undefined); return p; };
  const run = async (argv) => {
    let out = '', err = '';
    const code = await main(argv, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, now: () => NOW,
      env: { YATAVERSE_ARCHIVE_KEY_ID: 'test-key-id', YATAVERSE_ARCHIVE_APP_KEY: 'test-secret' } });
    return { code, out, err, json: code === 0 ? JSON.parse(out) : null };
  };
  try {
    const keyFile = write('verifier.jwk', JSON.stringify(jwks.verifier), 0o600);
    const base = ['retention-verify-once', '--lease', write('lease.json', JSON.stringify(leaseEnvelopeToJson(leaseEnv))),
      '--keys', write('keys.json', JSON.stringify(keys)), '--signing-key-file', keyFile, '--key-epoch', '1',
      '--receipts', write('receipt.json', JSON.stringify({ cid: CID, receipt: envelopeToJson(await archiveReceipt(s, lease)) })),
      '--archive-endpoint', srv.endpoint, '--archive-bucket', 'archive', '--archive-prefix', 'keep/', '--archive-region', 'us-west-004', '--sample-read', 'true'];
    const evidenceFile = path.join(dir, 'evidence.cbor');
    const ok = await run([...base, '--evidence-out', evidenceFile]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.json.summary.status, 'policy-satisfied');
    assert.equal(ok.json.published, false);
    assert.equal(ok.json.evidenceRoot, '0x' + hex(sha256(fs.readFileSync(evidenceFile))));
    await verifyStatus(statusEnvelopeFromJson(ok.json.status), lease, keys, { now: NOW + 1 });
    assert.ok(!ok.out.includes(jwks.verifier.d) && !ok.err.includes(jwks.verifier.d), 'the private key is not printed');
    assert.ok(!ok.out.includes('test-secret'));

    // Without an archive to look at, the same lease is degraded.
    const noArchive = await run(base.slice(0, base.indexOf('--archive-endpoint')));
    assert.equal(noArchive.json.summary.status, 'degraded');
    assert.equal(noArchive.json.summary.checks[0].reason, 'no-archive-probe');

    // A key file other users can read is refused before it is used.
    const loose = write('loose.jwk', JSON.stringify(jwks.verifier), 0o644);
    fs.chmodSync(loose, 0o644);
    const refused = await run(base.map((a) => (a === keyFile ? loose : a)));
    assert.equal(refused.code, 1); assert.match(refused.err, /signing-key-file-is-readable-by-others/);
    // The wrong verifier key issues nothing.
    const otherKey = write('other.jwk', JSON.stringify(jwks.other), 0o600);
    const wrong = await run(base.map((a) => (a === keyFile ? otherKey : a)));
    assert.equal(wrong.code, 1); assert.match(wrong.err, /signer-is-not-the-lease-verifier/); assert.equal(wrong.out, '');
    assert.equal((await run(['retention-verify-once', '--lease', 'x'])).code, 2);
  } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
