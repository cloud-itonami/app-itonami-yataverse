// EIP-712 hashing for flat structs (https://eips.ethereum.org/EIPS/eip-712): atomic members
// (uintN, bytesN, bool, address) and the dynamic `bytes` and `string`. Nested structs and
// arrays are not supported and are rejected, since no Yataverse type uses them.
import { keccak256 } from './keccak.mjs';

export class Eip712Error extends Error { constructor(code) { super(code); this.code = code; } }
const bad = (code) => { throw new Eip712Error(code); };

/** "Name(type1 name1,type2 name2)". fields: [[name, type], ...]. */
export const typeString = (name, fields) => `${name}(${fields.map(([n, t]) => `${t} ${n}`).join(',')})`;
export const typeHash = (name, fields) => keccak256(new TextEncoder().encode(typeString(name, fields)));

function uintWord(value, bits, field) {
  let v;
  if (typeof value === 'bigint') v = value;
  else if (Number.isSafeInteger(value)) v = BigInt(value);
  else bad(`not-an-integer:${field}`);
  if (v < 0n || v >= 1n << BigInt(bits)) bad(`out-of-range:${field}`);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function encodeValue(type, value, field) {
  let m;
  if ((m = /^uint(\d+)$/.exec(type))) {
    const bits = Number(m[1]);
    if (bits < 8 || bits > 256 || bits % 8) bad(`bad-type:${type}`);
    return uintWord(value, bits, field);
  }
  if (type === 'bool') { if (typeof value !== 'boolean') bad(`not-a-bool:${field}`); return uintWord(value ? 1 : 0, 8, field); }
  if (type === 'bytes') { if (!(value instanceof Uint8Array)) bad(`not-bytes:${field}`); return keccak256(value); }
  if (type === 'string') { if (typeof value !== 'string') bad(`not-a-string:${field}`); return keccak256(new TextEncoder().encode(value)); }
  if (type === 'address') {
    if (!(value instanceof Uint8Array) || value.length !== 20) bad(`not-an-address:${field}`);
    const out = new Uint8Array(32); out.set(value, 12); return out;
  }
  if ((m = /^bytes(\d+)$/.exec(type))) {
    const n = Number(m[1]);
    if (n < 1 || n > 32) bad(`bad-type:${type}`);
    if (!(value instanceof Uint8Array) || value.length !== n) bad(`not-bytes${n}:${field}`);
    const out = new Uint8Array(32); out.set(value); return out;
  }
  return bad(`unsupported-type:${type}`);
}

/** hashStruct(s) = keccak256(typeHash || encodeData(s)). Every field must be present; no extras. */
export function hashStruct(name, fields, value) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some(([n]) => !Object.hasOwn(value, n))) bad('fields-do-not-match-type');
  const parts = [typeHash(name, fields), ...fields.map(([n, t]) => encodeValue(t, value[n], n))];
  const buf = new Uint8Array(32 * parts.length);
  parts.forEach((p, i) => buf.set(p, 32 * i));
  return keccak256(buf);
}

// EIP712Domain members, in the order EIP-712 fixes; only the present ones are part of the type.
const DOMAIN_FIELDS = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'],
                       ['verifyingContract', 'address'], ['salt', 'bytes32']];

export function domainSeparator(domain) {
  for (const k of Object.keys(domain)) if (!DOMAIN_FIELDS.some(([n]) => n === k)) bad(`unknown-domain-field:${k}`);
  const fields = DOMAIN_FIELDS.filter(([n]) => domain[n] !== undefined);
  return hashStruct('EIP712Domain', fields, Object.fromEntries(fields.map(([n]) => [n, domain[n]])));
}

/** keccak256(0x1901 || domainSeparator || hashStruct(message)): the value an EIP-712 signer signs. */
export function typedDataDigest(domain, name, fields, message) {
  const buf = new Uint8Array(66);
  buf[0] = 0x19; buf[1] = 0x01;
  buf.set(domainSeparator(domain), 2);
  buf.set(hashStruct(name, fields, message), 34);
  return keccak256(buf);
}
