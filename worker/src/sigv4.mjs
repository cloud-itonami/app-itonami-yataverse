// AWS Signature Version 4 for the Backblaze B2 S3-compatible API.
// Only what this Worker needs: path-style object URLs, no query string, a caller-supplied
// payload hash. Uses node:crypto (Workers `nodejs_compat`, Node 18+ in tests).
import crypto from 'node:crypto';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** 2026-11-18T01:02:03.456Z -> { amzDate: '20261118T010203Z', dateStamp: '20261118' } */
export function amzDates(date) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** s3.us-west-004.backblazeb2.com -> us-west-004. Returns null for any other host shape. */
export function regionFromEndpoint(endpoint) {
  const m = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(new URL(endpoint).hostname);
  return m ? m[1] : null;
}

/**
 * Sign one request. `headers` holds every header to send besides Authorization; all of
 * them are signed. Returns a new header object that adds x-amz-date, x-amz-content-sha256
 * and Authorization.
 */
export function signV4({ method, url, headers = {}, payloadHash, keyId, secret, region, service = 's3', now = new Date() }) {
  if (!keyId || !secret || !region) throw new Error('sigv4-missing-credentials');
  if (!/^[0-9a-f]{64}$|^UNSIGNED-PAYLOAD$/.test(payloadHash)) throw new Error('sigv4-bad-payload-hash');
  const u = new URL(url);
  if (u.search) throw new Error('sigv4-query-not-supported');
  const { amzDate, dateStamp } = amzDates(now);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
                host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((k) => `${k}:${all[k]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, u.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const out = { ...all };
  delete out.host;   // fetch sets Host from the URL
  out.authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
