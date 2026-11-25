// Seeded HTTP operation sequences: every HTTP op keeps the registry
// consistent, and rejected ops change nothing (settle effects aside).
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
    counts: [...r.owners.values()].map((rec) => [rec.appTimes.seed.length, rec.appTimes.existing.length]),
    deviceKeys: [...r.owners.values()].map((rec) => [...rec.devices.keys()].sort()),
  });
}

async function run(seed) {
  const rand = mulberry32(seed);
  let regNow = T0;
  const r = new MemoryRegistry({ now: () => regNow });
  const s = fakeStore();
  const deps = { fetchImpl: s.fetchImpl, now: NOW, e2eeRegistry: r };
  const keyAt = (i) => keyFromSeed(crypto.createHash('sha256').update(`http-${seed}-${i}`).digest());
  const devices = [keyAt(0), keyAt(1), keyAt(2)];
  const stranger = keyAt(99);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const stmt = (key, op, args) => signStatement(key, { aud: EENV.CACAO_AUD, domain: EENV.CACAO_DOMAIN, op,
    owner: OWNER, actorDid: key.did, args, issuedAt: regNow, expiresAt: regNow + 300_000, epoch: 0 });
  const call = async (path, body, extra = {}) => {
    const res = await handle(new Request(`https://yataverse.com${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined }), envFor(), deps);
    return res;
  };
  const nonce = async () => (await (await handle(new Request('https://yataverse.com/auth/nonce'), EENV, deps)).json()).nonce;
  const cacao = async (key, resource) => `CACAO ${mintDirect(key, { aud: 'https://yataverse.com', domain: 'yataverse.com',
    nonce: await nonce(), resources: [resource], now: T0, ttlSec: 120 }).cacaoB64}`;

  for (let step = 0; step < 80; step++) {
    await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-registry/status/${OWNER}`), envFor(), deps);
    const before = core(r);
    const beforeIndex = new Map(r.deviceIndex);
    const op = Math.floor(rand() * 7);
    const d = pick(devices);
    let res;
    if (op === 0) {
      const args = [d.did, DERIVED.registration.did, 'seed'];
      const a = stmt(DERIVED.registration, 'register', args);
      const c = stmt(d, 'register', args);
      res = await call('/awai-drive/v1/e2ee-registry/register', { owner: OWNER, deviceDid: d.did, kind: 'seed',
        approval: { approverDid: DERIVED.registration.did, statement: a.fields, signature: a.signature },
        deviceConsent: { statement: c.fields, signature: c.signature } });
    } else if (op === 1) {
      const st = stmt(d, 'revoke', [pick(devices).did]);
      res = await call('/awai-drive/v1/e2ee-registry/revoke', { owner: OWNER, statement: st.fields, signature: st.signature });
    } else if (op === 2) {
      const st = stmt(rand() < 0.3 ? stranger : DERIVED.registration, 'batch-revoke', []);
      res = await call('/awai-drive/v1/e2ee-registry/batch-revoke', { owner: OWNER, statement: st.fields, signature: st.signature });
    } else if (op === 3) {
      const bytes = packBytes(); const id = sha(bytes);
      res = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-packs/${id}`,
        { method: 'PUT', body: bytes, headers: { 'content-type': 'application/vnd.ipld.car',
          authorization: await cacao(d, e2eePutResource(id)) } }), envFor(), deps);
    } else if (op === 4) {
      const bytes = packBytes(); const id = sha(bytes);
      res = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-packs/${id}`,
        { headers: { authorization: await cacao(d, e2eeGetResource(id)) } }), envFor(), deps);
    } else if (op === 5) {
      const seq = 1 + Math.floor(rand() * 3);
      res = await call(`/awai-drive/v1/e2ee-heads/${DERIVED.headNameHex}`,
        { owner: OWNER, deviceDid: d.did, seq, headSha: sha(Buffer.from(`h-${step}`)) },
        { authorization: await cacao(d, e2eeHeadResource(DERIVED.headNameHex, seq)) });
    } else {
      res = await handle(new Request(`https://yataverse.com/awai-drive/v1/e2ee-heads/${DERIVED.headNameHex}`,
        { headers: { authorization: await cacao(d, e2eeHeadReadResource(DERIVED.headNameHex)) } }), envFor(), deps);
    }
    if (res.status >= 400) {
      assert.equal(core(r), before, `step ${step} op ${op}: rejected HTTP op mutated core state`);
      for (const [did, o] of r.deviceIndex) assert.ok(beforeIndex.get(did) === o, `step ${step}: rejected op added index entry`);
    }
    // Live devices stay fetchable; revoked ones answer 404.
    const rec = r._get(OWNER);
    if (rec) {
      for (const [did, dv] of rec.devices) {
        const owner = await r.ownerOfDevice(did);
        if (!dv.revokedAt && !dv.released) assert.equal(owner, OWNER, `step ${step}: live device ${did.slice(-6)} has no owner`);
      }
    }
    regNow += Math.floor(rand() * 3) * 86_400_000;
  }
}

test('seeded HTTP sequences keep the registry consistent (2 seeds x 80 ops)', async () => {
  await run(5);
  await run(9);
});
