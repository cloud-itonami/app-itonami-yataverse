import { normalizeCid } from './cid.mjs';

const DEFAULT_DOMAIN = 'api.murakumo.cloud';
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;

/**
 * Derive the Murakumo did:web identifier and resolver URLs for an existing
 * Yataverse CID. This creates no registry claim and proves no asset ownership.
 */
export function assetDidRecord(inputCid, domain = DEFAULT_DOMAIN) {
  const cid = normalizeCid(inputCid);
  if (!cid) throw new Error('expected a supported CIDv0 or CIDv1 sha2-256 CID');
  if (typeof domain !== 'string' || domain.trim() !== domain || domain.length > 253 ||
      !DOMAIN_PATTERN.test(domain)) {
    throw new Error('domain must be a DNS hostname without a scheme, port, path, or credentials');
  }
  const host = domain.toLowerCase();
  return {
    cid,
    did: `did:web:${host}:training:assets:${cid}`,
    didDocumentUrl: `https://${host}/training/assets/${cid}/did.json`,
    assetRecordUrl: `https://${host}/training/assets/${cid}`,
    recordStatus: 'unregistered',
    evidenceStatus: 'cid-only-unverified',
    rewardStatus: 'not-eligible-unregistered',
    rewardEligibility: 'requires-verified-asset-root-rights-registered-contributors-and-training-use-review',
  };
}
