const CHUNK_BYTES = 65531;
const PACK_BYTES = 12 * 1024 * 1024;
const PACK_ID = /^[a-f0-9]{64}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASIS_ID = /^b[a-z2-7]{20,128}$/;
const SUBJECT = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,192}$/;
const MAX_ACCOUNT_SOURCES = 8;
const b64 = bytes => {
  let text = '';
  for (let start = 0; start < bytes.length; start += 16384) {
    text += String.fromCharCode(...bytes.subarray(start, start + 16384));
  }
  return btoa(text);
};
const unb64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

function computeInWorker(operation, session, input, buffers) {
  const worker = new Worker('./wnfs-worker.js');
  const secret = session.secret.slice();
  let timeout;
  return new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(Error("wnfs-worker-timeout")), 120000);
    worker.onmessage = ({ data }) => {
      if (data.error) reject(Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = () => reject(Error('invalid-wnfs-snapshot'));
    worker.onmessageerror = () => reject(Error('invalid-wnfs-snapshot'));
    worker.postMessage({ operation, record: session.record, secret, ...input },
      [secret.buffer, ...buffers]);
  }).finally(() => {
    clearTimeout(timeout);
    if (secret.byteLength) secret.fill(0);
    worker.terminate();
  });
}

export function createWnfsSync({ invoke, origin, packs, verifyReceipt, sha256, compute = computeInWorker }) {
  async function restoreCopy(rows, legacy = false, shared) {
    let operation;
    try {
      ({ operation } = await invoke('vaultWnfsRestoreBegin', { legacy, ...shared }));
      if (!operation) throw Error('restore-operation-missing');
      for (const { path, directory, chunks } of rows) {
        if (directory) continue;
        let offset = 0;
        for (const chunk of chunks) {
          for (let start = 0; start < chunk.length; start += CHUNK_BYTES) {
            const piece = chunk.subarray(start, start + CHUNK_BYTES);
            await invoke('vaultWnfsRestoreWrite', { operation, path, offset, bytes: b64(piece) });
            offset += piece.length;
          }
        }
        if (offset === 0) await invoke('vaultWnfsRestoreWrite', { operation, path, offset: 0, bytes: '' });
      }
      return await invoke('vaultWnfsRestorePublish', { operation });
    } catch (error) {
      if (operation) await invoke('vaultWnfsRestoreAbort', { operation }).catch(() => {});
      throw error;
    } finally {
      for (const { chunks = [] } of rows) for (const chunk of chunks) chunk.fill(0);
    }
  }

  function validateHead(head) {
    if (head?.schema !== 'awai.drive.wnfs.v1' || head.origin !== origin ||
        !PACK_ID.test(head.root) || !PACK_ID.test(head.capsule) || !Array.isArray(head.packs) ||
        head.packs.length < 1 || head.packs.length > 8 ||
        head.packs.some(id => !PACK_ID.test(id)) ||
        new Set([head.capsule, ...head.packs]).size !== head.packs.length + 1) {
      throw Error('recovery-required');
    }
  }

  async function readSnapshot(session, operation, extension) {
    const head = session.wnfs;
    validateHead(head);
    const started = performance.now();
    const capsule = await packs.download(head.capsule);
    if (capsule.length > 262144) throw Error('invalid-wnfs-snapshot');
    const capsuleBytes = capsule.length;
    const data = [];
    let size = 0;
    for (const id of head.packs) {
      const pack = await packs.download(id);
      size += pack.length;
      if (size > 4 * PACK_BYTES) throw Error('invalid-wnfs-snapshot');
      data.push(pack);
    }
    const fetched = performance.now();
    const snapshot = await compute(operation, session, { root: head.root, capsule, packs: data, extension },
      [capsule.buffer, ...data.map(pack => pack.buffer)]);
    if (Array.isArray(snapshot)) return snapshot;
    return { ...snapshot, fetchMs: fetched - started, openMs: performance.now() - fetched, bytes: size + capsuleBytes };
  }

  return {
    restoreCopy,
    publicRecipient: session => compute('public-recipient', session, {}, []),
    async grant(session, recipient) {
      const verified = await compute('validate-recipient', session, { recipient }, []);
      return invoke('vaultWnfsRecipientSet', { id: verified.id, recipient: verified });
    },
    revoke: id => invoke('vaultWnfsRecipientSet', { id }),
    async restoreShared(session, grant) {
      const recipient = await compute('public-recipient', session, {}, []);
      if (grant?.schema !== 'awai.drive.wnfs.grant.v1' || grant.recipient !== recipient.id ||
          typeof grant.basis !== 'string' || !grant.basis) throw Error('invalid-snapshot-grant');
      const snapshot = await readSnapshot({ ...session, wnfs: grant.head }, 'open-share', 'txt');
      const { rows, entries, ...verified } = snapshot;
      if (verified.basis !== grant.basis) {
        for (const { chunks = [] } of rows) for (const chunk of chunks) chunk.fill(0);
        throw Error('snapshot-basis-mismatch');
      }
      const published = await restoreCopy(rows, false, { share: grant.head.capsule, entries });
      return { ...published, ...verified };
    },
    async sync(session) {
      const { entries } = await invoke('vaultWnfsInventory');
      const { revision, items } = await invoke('vaultWnfsRecipients');
      if (!entries.length) throw Error('empty-sync-snapshot');
      const rows = [];
      try {
        for (const entry of entries) {
          if (entry.directory) {
            rows.push({ path: entry.path, directory: true });
            continue;
          }
          const bytes = new Uint8Array(entry.size);
          rows.push({ path: entry.path, bytes });
          for (let offset = 0; offset < entry.size; offset += CHUNK_BYTES) {
            const length = Math.min(CHUNK_BYTES, entry.size - offset);
            const piece = unb64((await invoke('vaultRead', { path: entry.path, offset, length })).bytes);
            if (piece.length !== length) throw Error('source-size-changed');
            bytes.set(piece, offset);
            piece.fill(0);
          }
          if (await sha256(bytes) !== entry.sha256) throw Error('source-size-changed');
        }
        const sealStart = performance.now();
        const sealed = await compute('seal', session, { rows, recipients: Object.values(items) },
          rows.flatMap(row => row.bytes ? [row.bytes.buffer] : []));
        const publishStart = performance.now();
        const packBytes = sealed.packs.reduce((n, pack) => n + pack.length, sealed.capsule.bytes.length);
        const dataIds = [];
        for (const pack of sealed.packs) dataIds.push(await packs.publish(pack, verifyReceipt));
        const capsule = await packs.publish(sealed.capsule.bytes, verifyReceipt);
        const grants = [];
        for (const { recipient, capsule: wrapped } of sealed.grants ?? []) {
          const id = await packs.publish(wrapped.bytes, verifyReceipt);
          grants.push({ schema: 'awai.drive.wnfs.grant.v1', recipient, basis: sealed.basis,
            head: { schema: 'awai.drive.wnfs.v1', origin, root: wrapped.root, capsule: id, packs: dataIds } });
        }
        const publishedAt = performance.now();
        await invoke('vaultWnfsCommit', { root: sealed.capsule.root, capsule, packs: dataIds, origin, entries, recipientRevision: revision });
        return { files: rows.filter(row => !row.directory).length, basis: sealed.basis,
          bytes: packBytes, grants, dataPacks: dataIds.length, sealMs: publishStart - sealStart, publishMs: publishedAt - publishStart };
      } finally {
        for (const row of rows) if (row.bytes?.byteLength) row.bytes.fill(0);
      }
    },

    async catalog(session) {
      const { rows } = await readSnapshot(session, 'catalog');
      return rows;
    },

    // The owner host supplies these grants after authenticating the account,
    // confirming device authorization and binding the stored heads to it.
    async catalogAuthorizedAccount({ subject, sources }) {
      if (typeof subject !== 'string' || !SUBJECT.test(subject) || !Array.isArray(sources) ||
          sources.length > MAX_ACCOUNT_SOURCES) throw Error('invalid-account-snapshot-grant');
      const deviceIds = new Set();
      for (const source of sources) {
        if (source?.subject !== subject || typeof source.deviceId !== 'string' || !DEVICE_ID.test(source.deviceId) ||
            deviceIds.has(source.deviceId) || typeof source.basis !== 'string' || !BASIS_ID.test(source.basis) ||
            typeof source.owner?.record !== 'string' || !source.owner.record || source.owner.record.length > 16000 ||
            !(source.owner.secret instanceof Uint8Array) || source.owner.secret.length !== 32) {
          throw Error('invalid-account-snapshot-grant');
        }
        validateHead(source.owner.wnfs);
        deviceIds.add(source.deviceId);
      }
      const entries = [];
      const admitted = sources.map(({ owner, deviceId, basis }) => ({
        deviceId, basis,
        owner: { record: owner.record, secret: owner.secret.slice(),
          wnfs: { ...owner.wnfs, packs: [...owner.wnfs.packs] } }
      }));
      try {
        for (const { owner, deviceId, basis } of admitted) {
          const catalog = await readSnapshot(owner, 'catalog');
          if (catalog.basis !== basis) throw Error('snapshot-basis-mismatch');
          for (const { path, directory = false } of catalog.rows) {
            entries.push({ path, directory, sourceDevice: deviceId });
          }
        }
        return entries;
      } finally {
        for (const { owner } of admitted) owner.secret.fill(0);
      }
    },
    async restore(session) {
      const snapshot = await readSnapshot(session, 'open', 'txt');
      // The production worker returns basis and query results with the
      // decrypted rows. Preserve old callers that supply only an array.
      if (Array.isArray(snapshot)) return restoreCopy(snapshot);
      const { rows, ...verified } = snapshot;
      const started = performance.now();
      const published = await restoreCopy(rows);
      return { ...published, ...verified, publishMs: performance.now() - started };
    },

    async inspect(session, expectedBasis, extension) {
      if (typeof expectedBasis !== 'string' || !expectedBasis || typeof extension !== 'string' || extension.length > 48) {
        throw Error('invalid-snapshot-query');
      }
      const snapshot = await readSnapshot(session, 'inspect', extension);
      if (snapshot.basis !== expectedBasis) throw Error('snapshot-basis-mismatch');
      return snapshot;
    }
  };
}
