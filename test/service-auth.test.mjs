// Per-person CAR writes by ATProto service auth (AWAI-3274). Every negative case must store
// nothing; the write-token path and its tests are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ENV, NOW, fakeStore, fakeLimiter, dataKeys } from './worker-fixtures.mjs';
import { handle } from '../worker/src/index.mjs';
import { verifyK256, multikeyToK256, decompress, atprotoIdentity, didDocUrl, clearServiceAuthCache,
         IMPORT_CAR_LXM, isServiceAuth } from '../worker/src/service-auth.mjs';
import { rawCid } from '../src/cid.mjs';
import { encodeCarV1 } from '../src/car.mjs';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex')); let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
function k256() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  const compressed = new Uint8Array([pub[64] & 1 ? 3 : 2, ...pub.subarray(1, 33)]);
  return { privateKey, compressed, multikey: 'z' + b58(new Uint8Array([0xe7, 0x01, ...compressed])) };
}
function sign(privateKey, msg, { highS = false } = {}) {
  const sig = crypto.sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  let s = BigInt('0x' + sig.subarray(32).toString('hex'));
  if ((s > N / 2n) !== highS) s = N - s;
  return new Uint8Array([...sig.subarray(0, 32), ...Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
}
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const T0 = Math.floor(NOW().getTime() / 1000);
function jwt(key, claims = {}, { header = { typ: 'JWT', alg: 'ES256K' }, highS = false } = {}) {
  const body = { iss: DID, aud: 'did:web:yataverse.com', lxm: IMPORT_CAR_LXM, iat: T0 - 5, exp: T0 + 55, jti: 'j1', ...claims };
  const signing = `${b64u(header)}.${b64u(body)}`;
  return `${signing}.${Buffer.from(sign(key.privateKey, Buffer.from(signing), { highS })).toString('base64url')}`;
}

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const KEY = k256();
const doc = (did = DID, multikey = KEY.multikey, pds = 'https://pds.aozora.app') => ({
  '@context': ['https://www.w3.org/ns/did/v1'], id: did,
  verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: multikey }],
  service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] });
const SA_ENV = { ...ENV, SERVICE_AUTH_AUD: 'did:web:yataverse.com', SERVICE_AUTH_PDS: 'https://pds.aozora.app' };

/** B2 plus fake plc.directory, did:web host and PDS. */
function world({ docs = { [DID]: doc() }, status = { [DID]: { did: DID, active: true } }, plcDown = false } = {}) {
  const s = fakeStore(); const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'plc.directory') {
      calls.push(`plc:${u.pathname.slice(1)}`); assert.equal(init.redirect, 'manual');
      if (plcDown) throw new TypeError('network');
      const d = docs[decodeURIComponent(u.pathname.slice(1))];
      return d ? Response.json(d) : new Response('not found', { status: 404 });
    }
    if (u.host === 'alice.example') { calls.push('web'); const d = docs['did:web:alice.example']; return d ? Response.json(d) : new Response(null, { status: 404 }); }
    if (u.host === 'pds.aozora.app' || u.host === 'pds.other.example') {
      assert.equal(u.pathname, '/xrpc/com.atproto.sync.getRepoStatus'); calls.push(`status:${u.searchParams.get('did')}`);
      const st = status[u.searchParams.get('did')];
      return st ? Response.json(st) : Response.json({ error: 'RepoNotFound' }, { status: 400 });
    }
    return s.fetchImpl(url, init);
  };
  return { s, calls, deps: { fetchImpl, now: NOW } };
}
const bytes = Buffer.from('nagare video bytes, one raw block');
const cid = rawCid(bytes);
const post = (auth, origin = 'https://tauri.localhost') => new Request('https://yataverse.com/ipfs', { method: 'POST',
  body: encodeCarV1([cid], [{ cid, bytes }]),
  headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/vnd.ipld.car', origin } });

test.beforeEach(() => clearServiceAuthCache());

test('verifyK256 agrees with OpenSSL signatures and refuses high-S, other messages and other keys', () => {
  for (let i = 0; i < 12; i++) {
    const k = k256(); const msg = crypto.randomBytes(40);
    assert.ok(verifyK256(k.compressed, msg, sign(k.privateKey, msg)));
    assert.equal(verifyK256(k.compressed, msg, sign(k.privateKey, msg, { highS: true })), false);
    assert.equal(verifyK256(k.compressed, Buffer.concat([msg, Buffer.from('x')]), sign(k.privateKey, msg)), false);
    assert.equal(verifyK256(KEY.compressed, msg, sign(k.privateKey, msg)), false);
  }
  assert.equal(decompress(new Uint8Array(33)), null);
  assert.equal(verifyK256(KEY.compressed, Buffer.from('m'), new Uint8Array(64)), false);
});

test('Multikey, DID document and DID URL parsing are strict', () => {
  assert.deepEqual(multikeyToK256(KEY.multikey), KEY.compressed);
  assert.equal(multikeyToK256('z6MkvbF1j4J8EDYJNYDLJKaNw2XuUpHhDdDH26XaXQsHrUGD'), null); // Ed25519 did:key Multikey
  assert.deepEqual(atprotoIdentity(doc(), DID), { key: KEY.compressed, pds: 'https://pds.aozora.app' });
  assert.equal(atprotoIdentity(doc(), 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz'), null); // id must match the issuer
  assert.equal(atprotoIdentity({ ...doc(), service: [] }, DID), null);
  assert.equal(didDocUrl(DID, {}), `https://plc.directory/${DID}`);
  assert.equal(didDocUrl('did:web:alice.example', {}), 'https://alice.example/.well-known/did.json');
  for (const d of ['did:key:zQ3sh', 'did:web:localhost', 'did:web:a.example%3A8080', 'did:plc:short']) assert.equal(didDocUrl(d, {}), null, d);
  assert.ok(isServiceAuth(`Bearer ${jwt(KEY)}`));
  assert.equal(isServiceAuth('Bearer yv_write_0123456789abcdef'), false);
});

test('a person with an active Aozora repo can POST a CAR from Nagare; the receipt names the DID hash', async () => {
  const w = world();
  const r = await handle(post(jwt(KEY)), SA_ENV, w.deps);
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://tauri.localhost');
  const body = await r.json();
  assert.deepEqual(body.roots, [cid]); assert.equal(body.verified, true);
  assert.equal(body.receipt.receipt.requester, '0x' + crypto.createHash('sha256').update(DID).digest('hex'));
  assert.deepEqual(dataKeys(w.s), [`ipld/${cid}`]);
  assert.deepEqual(w.calls, [`plc:${DID}`, `status:${DID}`]);
  // A second write within the cache window does not resolve again.
  assert.equal((await handle(post(jwt(KEY, { jti: 'j2' })), SA_ENV, w.deps)).status, 201);
  assert.equal(w.calls.length, 2);
});

test('did:web issuers resolve from /.well-known/did.json', async () => {
  const web = 'did:web:alice.example'; const k = k256();
  const w = world({ docs: { [web]: doc(web, k.multikey) }, status: { [web]: { did: web, active: true } } });
  assert.equal((await handle(post(jwt(k, { iss: web })), SA_ENV, w.deps)).status, 201);
  assert.deepEqual(w.calls, ['web', `status:${web}`]);
});

test('negative controls: each bad token is refused and nothing is stored', async () => {
  const other = k256(); const t = (c, o) => jwt(KEY, c, o);
  const cases = [
    ['wrong audience', t({ aud: 'did:web:evil.example' }), {}, 401, 'service-auth-wrong-audience'],
    ['wrong method', t({ lxm: 'com.atproto.repo.uploadBlob' }), {}, 403, 'service-auth-wrong-method'],
    ['no lxm', t({ lxm: undefined }), {}, 403, 'service-auth-wrong-method'],
    ['expired', t({ iat: T0 - 120, exp: T0 - 1 }), {}, 401, 'service-auth-expired'],
    ['too long-lived', t({ iat: T0, exp: T0 + 301 }), {}, 401, 'service-auth-lifetime-not-allowed'],
    ['issued in the future', t({ iat: T0 + 60, exp: T0 + 120 }), {}, 401, 'service-auth-lifetime-not-allowed'],
    ['no times', t({ iat: undefined }), {}, 401, 'service-auth-times-missing'],
    ['ES256', t({}, { header: { typ: 'JWT', alg: 'ES256' } }), {}, 401, 'service-auth-alg-not-supported'],
    ['alg none', t({}, { header: { alg: 'none' } }), {}, 401, 'service-auth-alg-not-supported'],
    ['high-S signature', t({}, { highS: true }), {}, 401, 'service-auth-bad-signature'],
    ['signed by another key', jwt(other), {}, 401, 'service-auth-bad-signature'],
    ['did:key issuer', t({ iss: 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme' }), {}, 401, 'service-auth-issuer-not-supported'],
    ['unknown DID', t({ iss: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' }), {}, 401, 'issuer-did-not-found'],
    ['DID names another PDS', t(), { docs: { [DID]: doc(DID, KEY.multikey, 'https://pds.other.example') } }, 403, 'service-auth-pds-not-allowed'],
    ['DID claims Aozora but Aozora does not host it', t(), { status: {} }, 403, 'issuer-not-hosted-by-pds'],
    ['repo deactivated', t(), { status: { [DID]: { did: DID, active: false, status: 'deactivated' } } }, 403, 'issuer-repo-not-active'],
    ['PLC unreachable', t(), { plcDown: true }, 502, 'issuer-did-unresolvable'],
  ];
  for (const [name, token, opts, status, error] of cases) {
    clearServiceAuthCache();
    const w = world(opts);
    const r = await handle(post(token), SA_ENV, w.deps);
    assert.equal(r.status, status, name);
    assert.equal((await r.json()).error, error, name);
    assert.equal(dataKeys(w.s).length, 0, name);
  }
  // Tampering with the payload after signing breaks the signature.
  const [h, , s] = jwt(KEY).split('.');
  const forged = `${h}.${b64u({ iss: DID, aud: 'did:web:yataverse.com', lxm: IMPORT_CAR_LXM, iat: T0, exp: T0 + 60, x: 1 })}.${s}`;
  const w = world();
  assert.equal((await (await handle(post(forged), SA_ENV, w.deps)).json()).error, 'service-auth-bad-signature');
  assert.equal(dataKeys(w.s).length, 0);
});

test('revocation, switch-off, origin and rate limits still apply', async () => {
  let w = world();
  assert.equal((await handle(post(jwt(KEY)), { ...SA_ENV, SERVICE_AUTH_DENY_DIDS: `did:plc:other, ${DID}` }, w.deps)).status, 403);
  assert.equal((await handle(post(jwt(KEY)), { ...SA_ENV, SERVICE_AUTH_AUD: '' }, w.deps)).status, 503);
  assert.equal((await handle(post(jwt(KEY), 'https://evil.example'), SA_ENV, w.deps)).status, 403);
  assert.deepEqual(w.calls, []);
  // The rate limiter counts the request before any DID lookup.
  w = world();
  const r = await handle(post(jwt(KEY)), { ...SA_ENV, WRITE_REQUEST_LIMITER: fakeLimiter(0) }, w.deps);
  assert.equal(r.status, 429); assert.deepEqual(w.calls, []);
  assert.equal(dataKeys(w.s).length, 0);
});

test('a service-auth JWT does not authorize a block PUT (write-token only)', async () => {
  const w = world();
  const put = new Request(`https://yataverse.com/ipfs/${cid}`, { method: 'PUT', body: bytes,
    headers: { authorization: `Bearer ${jwt(KEY)}`, 'content-type': 'application/vnd.ipld.raw' } });
  assert.equal((await handle(put, SA_ENV, w.deps)).status, 401);
  assert.equal(dataKeys(w.s).length, 0); assert.deepEqual(w.calls, []);
});

// ---- PDS-attested tokens (AWAI-3370) -------------------------------------------------------
const PDS_DID = 'did:web:pds.aozora.app';
const PDS_KEY = k256();
const MEMBER = 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme';
const AT_ENV = { ...SA_ENV, SERVICE_AUTH_PDS_KEYS: `${PDS_DID}=${PDS_KEY.multikey}` };
const attested = (claims = {}, key = PDS_KEY) => jwt(key, { iss: PDS_DID, sub: MEMBER, ...claims });

test('a PDS-attested token for an active member stores the CAR; the receipt names the member', async () => {
  const w = world({ status: { [MEMBER]: { did: MEMBER, active: true } } });
  const r = await handle(post(attested()), AT_ENV, w.deps);
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.receipt.receipt.requester, '0x' + crypto.createHash('sha256').update(MEMBER).digest('hex'));
  assert.deepEqual(dataKeys(w.s), [`ipld/${cid}`]);
  assert.deepEqual(w.calls, [`status:${MEMBER}`], 'no DID document lookup for the attested member');
});

test('negative controls for PDS-attested tokens: nothing is stored', async () => {
  const other = k256();
  const active = { status: { [MEMBER]: { did: MEMBER, active: true } } };
  const cases = [
    ['not pinned (no SERVICE_AUTH_PDS_KEYS)', attested(), SA_ENV, active, 401, 'service-auth-attester-not-trusted'],
    ['pinned PDS not in SERVICE_AUTH_PDS', attested(), { ...AT_ENV, SERVICE_AUTH_PDS: 'https://pds.other.example' }, active, 401, 'service-auth-attester-not-trusted'],
    ['signed by another key', attested({}, other), AT_ENV, active, 401, 'service-auth-bad-signature'],
    ['the member signing as the PDS', jwt(KEY, { iss: PDS_DID, sub: MEMBER }), AT_ENV, active, 401, 'service-auth-bad-signature'],
    ['no subject', attested({ sub: undefined }), AT_ENV, active, 401, 'service-auth-subject-not-supported'],
    ['subject not a DID', attested({ sub: 'alice' }), AT_ENV, active, 401, 'service-auth-subject-not-supported'],
    ['member not hosted', attested(), AT_ENV, { status: {} }, 403, 'issuer-not-hosted-by-pds'],
    ['member deactivated', attested(), AT_ENV, { status: { [MEMBER]: { did: MEMBER, active: false } } }, 403, 'issuer-repo-not-active'],
    ['member denied', attested(), { ...AT_ENV, SERVICE_AUTH_DENY_DIDS: MEMBER }, active, 403, 'service-auth-issuer-denied'],
    ['wrong audience', attested({ aud: 'did:web:evil.example' }), AT_ENV, active, 401, 'service-auth-wrong-audience'],
    ['wrong method', attested({ lxm: 'com.atproto.repo.createRecord' }), AT_ENV, active, 403, 'service-auth-wrong-method'],
    ['too long-lived', attested({ iat: T0, exp: T0 + 301 }), AT_ENV, active, 401, 'service-auth-lifetime-not-allowed'],
    ['a person claiming a sub other than themself', jwt(KEY, { sub: MEMBER }), SA_ENV, {}, 401, 'service-auth-attester-not-trusted'],
  ];
  for (const [name, token, env, opts, status, error] of cases) {
    clearServiceAuthCache();
    const w = world(opts);
    const r = await handle(post(token), env, w.deps);
    assert.equal(r.status, status, name);
    assert.equal((await r.json()).error, error, name);
    assert.equal(dataKeys(w.s).length, 0, name);
  }
});
