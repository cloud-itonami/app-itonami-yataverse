import { verifyWnfsAccountProof } from './wnfs-account.js';

const recipientSchema = 'awai.wnfs.account-recipient.v1';
const shareSchema = 'awai.wnfs.account-share.v1';
const basis = /^b[a-z2-7]{20,128}$/;
const digest = /^[a-f0-9]{64}$/;

const binding = id => ({ purpose: 'bind-wnfs-key', value: id });

export function createAccountSharing({ invoke, wnfs, sha256, app }) {
  async function accountProof(action) {
    const { proof } = await invoke('accountProof', action);
    const verified = await verifyWnfsAccountProof(proof, action);
    if (verified.app !== app) throw Error('wrong-account-app');
    await invoke('vaultWnfsBindAccount', { account: verified.account });
    return { proof, account: verified.account };
  }

  async function grantAction(grant, recipient) {
    const head = grant?.head;
    if (grant?.schema !== 'awai.drive.wnfs.grant.v2' || !basis.test(grant.basis) ||
        typeof grant.releaseKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(grant.releaseKey) ||
        head?.schema !== 'awai.drive.wnfs.v1' || typeof head.origin !== 'string' ||
        !digest.test(head.root) || !digest.test(head.capsule) ||
        !Array.isArray(head.packs) || !head.packs.length || head.packs.length > 8 ||
        head.packs.some(pack => !digest.test(pack))) throw Error('invalid-account-share');
    const bytes = new TextEncoder().encode(JSON.stringify([
      shareSchema, recipient, grant.recipient, grant.basis, grant.releaseKey,
      head.origin, head.root, head.capsule, ...head.packs,
    ]));
    try {
      return { purpose: 'sign-wnfs-share', value: await sha256(bytes), recipient };
    } finally {
      bytes.fill(0);
    }
  }

  return {
    async publicRecipient(session) {
      const publicKey = await wnfs.publicRecipient(session);
      const { proof } = await accountProof(binding(publicKey.id));
      return { schema: recipientSchema, publicKey, proof };
    },

    async grant(session, recipient) {
      if (recipient?.schema !== recipientSchema) throw Error('account-recipient-required');
      const { publicKey, proof } = recipient;
      await verifyWnfsAccountProof(proof, binding(publicKey?.id));
      const local = await wnfs.publicRecipient(session);
      await accountProof(binding(local.id));
      return wnfs.grant(session, publicKey, proof);
    },

    async revoke(session, id) {
      const local = await wnfs.publicRecipient(session);
      await accountProof(binding(local.id));
      return wnfs.revoke(id);
    },

    async sync(session) {
      const recipients = new Map();
      const published = await wnfs.sync(session, async (items, proofs) => {
        for (const key of Object.values(items)) {
          const proof = proofs?.[key.id];
          if (!proof) continue;
          const { account } = await verifyWnfsAccountProof(proof, binding(key.id));
          recipients.set(key.id, account);
        }
        return Object.values(items).filter(key => recipients.has(key.id));
      });
      const grants = [];
      for (const grant of published.grants) {
        const recipient = recipients.get(grant.recipient);
        const { proof } = await accountProof(await grantAction(grant, recipient));
        grants.push({ schema: shareSchema, recipient, grant, proof });
      }
      return { ...published, grants };
    },

    async restore(session, share, sender) {
      if (share?.schema !== shareSchema) throw Error('account-share-required');
      const { grant, recipient, proof } = share;
      const issued = await verifyWnfsAccountProof(proof, await grantAction(grant, recipient));
      if (issued.account !== sender) throw Error('wrong-share-sender');
      const local = await wnfs.publicRecipient(session);
      if (local.id !== grant.recipient) throw Error('invalid-snapshot-grant');
      const { account } = await accountProof(binding(local.id));
      if (account !== recipient) throw Error('wrong-share-recipient');
      return wnfs.restoreShared(session, grant);
    },
  };
}
