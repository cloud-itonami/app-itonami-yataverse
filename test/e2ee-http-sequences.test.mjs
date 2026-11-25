// Seeded HTTP operation sequences: every HTTP op keeps the registry
// consistent, rejected ops change nothing, and successes are counted per op
// kind (a run with zero successes fails). One shared clock drives both the
// registry and the handler; statement epochs are read current each time.
//
// Test-plan coverage (what is / is not covered here):
// - Covered: register (seed + existing), cancel, revoke, batch-revoke,
//   release, pack PUT/GET, head publish/read — all through HTTP handlers
//   with real signatures, a shared clock, and settle-equal comparisons.
// - Not covered here (covered elsewhere): cancel budget exhaustion and
//   capacity reservations (e2ee-hardening, e2ee-packs tests), statement
//   windows/epochs (hardening), owner allowlist (hardening), HTTP pack
//   GET status/header shapes (e2ee-packs), head dry-run edge cases.
// - Gaps that remain: multi-owner HTTP sequences (registry-level only),
//   Durable Object / wrangler binding paths, real sigv4/B2.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handle } from '../worker/src/index.mjs';
import { MemoryRegistry } from '../worker/src/e2ee-registry.mjs';
import { deriveFromSeed } from '../src/recovery-derivation.mjs';
import { signStatement } from '../src/e2ee-statement.mjs';
import { keyFromSeed, mintDirect, e2eeGetResource, e2eePutResource, e2eeHeadResource, e2eeHeadReadResource } from '../src/cacao.mjs';
import { ENV, NOW, fakeStore } from './worker-fixtures.mjs';

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const packBytes = () => fs.readFileSync(new URL('./fixtures/drive-v1.car', import.meta.url));
const T0 = NOW().getTime();
const WRITER = keyFromSeed(crypto.createHash('sha256').update('writer').digest());
const EENV = { ...ENV, CACAO_NONCE_SECRET: 'test-nonce-secret-0123456789abcdef', CACAO_AUD: 'https://yataverse.com',
               CACAO_DOMAIN: 'yataverse.com', CACAO_WRITER_DIDS: WRITER.did };
const DERIVED = deriveFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
const OWNER = DERIVED.owner;
const envFor = () => ({ ...EENV, E2EE_OWNER_ALLOWLIST: OWNER });

function core(r) {
  return JSON.stringify({
    owners: [...r.owners.keys()].sort(),
    packs: [...r.owners.values()].map((rec) => rec.packs.size),
    used: [...r.usedStatements.keys()].sort(),
    counts: [...r.owners.values()].map((rec) => [rec.appTimes.seed.length, rec.appTimes.existing.length,
      rec.batchTimes.length, rec.headTimes.length]),
  });
}

async function run(seed) {
  const rand = mulberry32(seed);
  let regNow = T0;
  const r = new MemoryRegistry({ now: () => regNow });
  const s0 = fakeStore();
  // The fake store pins the SigV4 credential date to its fixture day; the
  // shared clock advances past it, so normalize the date on B2 calls only.
  const s = { ...s0, objects: s0.objects, fetchImpl: async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (headers.authorization) headers.authorization = String(headers.authorization).replace(/kid\/\d{8}\//, 'kid/20261118/');
    return s0.fetchImpl(url, { ...init, headers });
  } };
  const deps = { fetchImpl: s.fetchImpl, now: () => new Date(regNow), e2eeRegistry: r };
  const keyAt = (i) => keyFromSeed(crypto.createHash('sha256').update(`http-${seed}-${i}`).digest());
  const devices = [keyAt(0), keyAt(1), keyAt(2)];
  const stranger = keyAt(99);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const successes = {};
  const ok = (kind, res) => { if (res.status < 400) successes[kind] = (successes[kind] ?? 0) + 1; return res; };

  const epoch = async () => (await (await handle(new Request(
    `https://yataverse.com/awai-drive/v1/e2ee-registry/status/${OWNER}`), envFor(), deps)).json()).epoch;
  const stmt = async (key, op, args) => signStatement(key, { aud: EENV.CACAO_AUD, domain: EENV.CACAO_DOMAIN, op,
    owner: OWNER, actorDid: key.did, args, issuedAt: regNow, expiresAt: regNow + 300_000, epoch: await epoch() });
  const call = (path, body, extra = {}) => handle(new Request(`https://yataverse.com${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined }), envFor(), deps);
  const nonce = async () => (await (await handle(new Request('https://yataverse.com/auth/nonce'), EENV, deps)).json()).nonce;
  const cacao = async (key, resource) => `CACAO ${mintDirect(key, { aud: 'https://yataverse.com', domain: 'yataverse.com',
    nonce: await nonce(), resources: [resource], now: regNow, ttlSec: 120 }).cacaoB64}`;

  // Enroll serially: every device seed-registers (wait 3 days between so
  // pendings admit), guaranteeing live terminals for later pack/head ops.
  for (const d of devices) {
    const args = [d.did, DERIVED.registration.did, 'seed'];
    const a = await stmt(DERIVED.registration, 'register', args);
    const c = await stmt(d, 'register', args);
    const res = await call('/awai-drive/v1/e2ee-registry/register', { owner: OWNER, deviceDid: d.did, kind: 'seed',
      approval: { approverDid: DERIVED.registration.did, statement: a.fields, signature: a.signature },
      deviceConsent: { statement: c.fields, signature: c.signature } });
    assert.equal(res.status, 200, `enroll ${d.did.slice(-6)}`);
    successes['register-seed'] = (successes['register-seed'] ?? 0) + 1;
    regNow += 3 * 86_400_000 + 1000;
  }

  for (let step = 0; step < 120; step++) {
    await epoch(); // settle due events before the snapshot
    const before = core(r);
    const beforeIndex = new Map(r.deviceIndex);
    const op = Math.floor(rand() * 9);
    const d = pick(devices);
    let res;
    if (op === 0) {
      const kind = rand() < 0.5 ? 'seed' : 'existing-device';
      let approver;
      if (kind === 'seed') approver = DERIVED.registration;
      else {
        // Approve with a currently live terminal when one exists (not the device itself).
        const rec = r._get(OWNER);
        const live = rec ? [...rec.devices.entries()].filter(([, v]) => !v.revokedAt && !v.released).map(([did]) => did) : [];
        if (!live.length) continue;
        const others = live.filter((did) => did !== d.did);
        if (!others.length) continue;
        approver = devices.find((k) => k.did === pick(others)) ?? devices[0];
      }
      const args = [d.did, approver.did, kind];
      const a = await stmt(approver, 'register', args);
      const c = await stmt(d, 'register', args);
      res = await call('/awai-drive/v1/e2ee-registry/register', { owner: OWNER, deviceDid: d.did, kind,
        approval: { approverDid: approver.did, statement: a.fields, signature: a.signature },
        deviceConsent: { statement: c.fields, signature: c.signature } });
      ok(`register-${kind}`, res);
    } else if (op === 1) {
      const st = await stmt(d, 'revoke', [pick(devices).did]);
      res = await call('/awai-drive/v1/e2ee-registry/revoke', { owner: OWNER, statement: st.fields, signature: st.signature });
      ok('revoke', res);
    } else if (op === 2) {
      const st = await stmt(rand() < 0.3 ? stranger : DERIVED.registration, 'batch-revoke', []);
      res = await call('/awai-drive/v1/e2ee-registry/batch-revoke', { owner: OWNER, statement: st.fields, signature: st.signature });
      ok('batch-revoke', res);
    } else if (op === 3) {
      const st = await stmt(d, 'cancel', [String(1 + Math.floor(rand() * 3))]);
      res = await call('/awai-drive/v1/e2ee-registry/cancel', { owner: OWNER, statement: st.fields, signature: st.signature });
      ok('cancel', res);
    } else if (op === 4) {
      const st = await stmt(DERIVED.registration, 'release', [d.did]);
      res = await call('/awai-drive/v1/e2ee-registry/release', { owner: OWNER, statement: st.fields, signature: st.signature });
      ok('release', res);
    } else if (op === 5) {
      const bytes = packBytes(); const id = sha(bytes);
      res = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-packs/${id}`,
        { method: 'PUT', body: bytes, headers: { 'content-type': 'application/vnd.ipld.car',
          authorization: await cacao(d, e2eePutResource(id)) } }), envFor(), deps);
      ok('put', res);
    } else if (op === 6) {
      const bytes = packBytes(); const id = sha(bytes);
      res = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-packs/${id}`,
        { headers: { authorization: await cacao(d, e2eeGetResource(id)) } }), envFor(), deps);
      ok('get', res);
    } else if (op === 7) {
      const cur = r._get(OWNER)?.headSeq ?? 0;
      const seq = cur + 1;
      res = await call(`/awai-drive/v1/e2ee-heads/${DERIVED.headNameHex}`,
        { owner: OWNER, deviceDid: d.did, seq, headSha: sha(Buffer.from(`h-${step}`)) },
        { authorization: await cacao(d, e2eeHeadResource(DERIVED.headNameHex, seq)) });
      ok('head-publish', res);
    } else {
      res = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-heads/${DERIVED.headNameHex}`,
        { headers: { authorization: await cacao(d, e2eeHeadReadResource(DERIVED.headNameHex)) } }), envFor(), deps);
      ok('head-read', res);
    }
    if (res.status >= 400) {
      // Settled-clone comparison: rejected HTTP ops change nothing.
      await epoch();
      assert.equal(core(r), before, `step ${step} op ${op}: rejected HTTP op mutated core state`);
      for (const [did, o] of r.deviceIndex) assert.ok(beforeIndex.get(did) === o, `step ${step}: rejected op added index entry`);
    }
    regNow += Math.floor(rand() * 3) * 86_400_000; // 0-2 days per step, same clock for handler
  }
  // Core op kinds must have succeeded (existing-device/cancel are opportunistic:
  // batches frequently freeze the existing lane, so they are not required).
  for (const kind of ['register-seed', 'revoke', 'batch-revoke', 'release', 'put', 'get', 'head-publish']) {
    assert.ok((successes[kind] ?? 0) >= 1, `seed ${seed}: no successful ${kind} (successes=${JSON.stringify(successes)})`);
  }
}

test('seeded HTTP sequences keep the registry consistent with real successes (2 seeds x 120 ops)', async () => {
  await run(5);
  await run(9);
});
