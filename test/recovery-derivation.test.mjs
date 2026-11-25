// Unified seed derivation (design §2): pinned HKDF vectors, domain separation,
// and seed-change renaming. Synthetic seed only; no real keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DERIVATION_PREFIX, DERIVATION_TABLE, deriveFromSeed, deriveLabel, mintE2eeFetchCacao } from '../src/recovery-derivation.mjs';
import { keyFromSeed, newSeed } from '../src/cacao.mjs';

const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const hex = (b) => Buffer.from(b).toString('hex');

test('pinned HKDF vectors for the synthetic seed (0x00..0x1f)', () => {
  const d = deriveFromSeed(SEED);
  assert.equal(hex(d.recoveryRecipient.kemCoins), '67ed5bf2124dc54860c97e741c4e9499acc01b6bca8b212a5b418cb21f88d353765db1c15c21fe5509a63018fca0bddda9fb49197358a994d1646c9d94e9240e');
  assert.equal(hex(d.recoveryRecipient.x25519Scalar), 'eb5619e88f54b2836288a6e4b5d182ad8dd3599a9f5e961779ea170f9a83b328');
  assert.equal(hex(d.registrationKey), '2df2d208823622de4111fa245abc7918e163836f0548f9dd93ff7fd99f630cc8');
  assert.equal(d.registration.did, 'did:key:z6MksLrd9vGHF9sfS5b3z4bZ3JVLKycE3aHrzHMfnPdQLaRX');
  assert.equal(d.owner, '4dce4381c38e733aa1118dfbf8e66207c8b176022709aa593639fc6327a44c94');
  assert.equal(d.headNameHex, 'b239f8d9aff14f9448e37838cd0e9351d37a328f1510574cf4e1f94e6f5534d8');
  assert.equal(hex(d.headSignRoot), '20fe3a291271d10bc2c1f419516175bc3f8ec698414353db1bf6f8452fc526ed');
  // Independent cross-check: seed 0x01*32, owner-pseudonym from HKDF directly.
  assert.equal(deriveFromSeed(Buffer.alloc(32, 1)).owner, 'e652c72c8e3b0d622e09475480d1c91eb70e32d9ed9617e3ee722a488ec929df');
});

test('table shape: prefix, five labels, lengths', () => {
  assert.equal(DERIVATION_PREFIX, 'awai-drive/v1/');
  assert.deepEqual(DERIVATION_TABLE.map((r) => [r.label, r.bytes]), [
    ['recovery-recipient', 96], ['device-registration', 32], ['owner-pseudonym', 32],
    ['head/name', 32], ['head/sign-root', 32],
  ]);
  assert.throws(() => deriveFromSeed(Buffer.alloc(16)), /32 bytes/);
  assert.throws(() => deriveLabel(SEED, 'head', 32), /unknown derivation label/);
});

test('domain separation: every label gives different bytes for the same seed', () => {
  const outs = DERIVATION_TABLE.map((r) => hex(deriveLabel(SEED, r.label)));
  assert.equal(new Set(outs).size, outs.length);
  // head/name (public) must not reveal head/sign-root: different labels and bytes.
  assert.notEqual(hex(deriveLabel(SEED, 'head/name')), hex(deriveLabel(SEED, 'head/sign-root')));
});

test('seed change renames pseudonym and head name (migration, design §2)', () => {
  const a = deriveFromSeed(SEED);
  const b = deriveFromSeed(Buffer.alloc(32, 2));
  assert.notEqual(a.owner, b.owner);
  assert.notEqual(a.headNameHex, b.headNameHex);
  assert.notEqual(a.registration.did, b.registration.did);
});

test('fetch credential: per-device CACAO naming one pack, pseudonym absent', () => {
  const device = keyFromSeed(newSeed());
  const d = deriveFromSeed(SEED);
  const sha = 'a'.repeat(64);
  const minted = mintE2eeFetchCacao(device, sha, { nonce: 'n', aud: 'https://yataverse.com', domain: 'yataverse.com', now: 0 });
  const plain = Buffer.from(minted.cacaoB64, 'base64').toString('utf8');
  assert.ok(plain.includes(`yataverse:e2ee:get:${sha}`));
  assert.ok(!plain.includes(d.owner), 'owner pseudonym must not appear in the fetch CACAO');
  assert.throws(() => mintE2eeFetchCacao(device, 'zz', {}), /64 hex/);
});
