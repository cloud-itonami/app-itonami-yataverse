// CACAO (CAIP-122 / SIWE) minting with node:crypto only — byte-compatible with
// kotoba-lang/org-chainagnostic-cacao (cacao.edge.mint / cacao.edge.verify.siwe-message).
// Two shapes, both signed by an ed25519 key the CALLER holds:
//   direct   {p, s:{t:"EdDSA", s:<base64url>}}   the "direct block-origin" profile
//   session  {p, s:{s:<base64>}}                 the Authn sign-in profile (POST /v1/cacao/session)
// Nothing here talks to a network; nothing here stores a key.
import crypto from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX_LEN = 12;

export function base58btc(buf) {
  const bytes = [...buf];
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) { const x = digits[i] * 256 + carry; digits[i] = x % 58; carry = Math.floor(x / 58); }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

/** A 32-byte ed25519 seed (Buffer/hex) -> {privateKey, publicRaw, did}. */
export function keyFromSeed(seed) {
  const s = Buffer.isBuffer(seed) ? seed : Buffer.from(seed, 'hex');
  if (s.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, s]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicRaw = spki.subarray(SPKI_ED25519_PREFIX_LEN);
  return { privateKey, publicRaw, did: 'did:key:z' + base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), publicRaw])) };
}

export const newSeed = () => crypto.randomBytes(32);

const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The plaintext that is signed (identical to cacao.edge.verify/siwe-message). */
export function siweMessage({ domain, iss, aud, version, nonce, iat, exp, statement, resources }) {
  const lines = [`${domain} wants you to sign in with your Ethereum account:`, iss.split(':').pop(), ''];
  if (statement) lines.push(statement, '');
  lines.push(`URI: ${aud}`, `Version: ${version}`, 'Chain ID: 1', `Nonce: ${nonce}`, `Issued At: ${iat}`);
  if (exp) lines.push(`Expiration Time: ${exp}`);
  if (resources?.length) { lines.push('Resources:'); for (const r of resources) lines.push(`- ${r}`); }
  return lines.join('\n');
}

// --- the restricted CBOR profile a CACAO uses: text, arrays of text, maps of those ---
function head(major, n) {
  if (n < 24) return [(major << 5) | n];
  if (n <= 0xff) return [(major << 5) | 24, n];
  if (n <= 0xffff) return [(major << 5) | 25, n >> 8, n & 0xff];
  throw new Error('cbor: value too large for this profile');
}
const text = (s) => { if (typeof s !== 'string') throw new Error('cbor: expected a string'); const b = [...Buffer.from(s, 'utf8')]; return [...head(3, b.length), ...b]; };
const value = (v) => (Array.isArray(v) ? [...head(4, v.length), ...v.flatMap(text)] : text(v));
const map = (pairs) => [...head(5, pairs.length), ...pairs.flatMap(([k, v]) => [...text(k), ...value(v)])];

function mint({ privateKey, did }, { aud, domain, resources = [], ttlSec = 300, nonce, now = Date.now(), profile }) {
  if (!aud || !domain) throw new Error('aud and domain are required');
  const iat = utc(now), exp = utc(now + ttlSec * 1000);
  nonce = nonce ?? crypto.randomBytes(12).toString('hex');
  const p = { iss: did, aud, iat, nonce, domain, version: '1', exp, resources };
  const sig = crypto.sign(null, Buffer.from(siweMessage(p), 'utf8'), privateKey);
  const pairs = [['iss', did], ['aud', aud], ['iat', iat], ['nonce', nonce], ['domain', domain], ['version', '1'], ['exp', exp]];
  if (resources.length) pairs.push(['resources', resources]);
  const sMap = profile === 'direct'
    ? map([['t', 'EdDSA'], ['s', sig.toString('base64url')]])
    : map([['s', sig.toString('base64')]]);
  const envelope = [...head(5, 2), ...text('p'), ...map(pairs), ...text('s'), ...sMap];
  return { cacaoB64: Buffer.from(envelope).toString('base64'), did, iat, exp, nonce };
}

/** CACAO for a direct block write (`Authorization: CACAO <b64>`). */
export const mintDirect = (key, opts) => mint(key, { ...opts, profile: 'direct' });

/** Sign-in CACAO for Authn's POST /v1/cacao/session. */
export const mintSession = (key, opts) => mint(key, { ...opts, profile: 'session' });
