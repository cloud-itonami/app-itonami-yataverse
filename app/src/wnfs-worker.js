self.window = self;
importScripts('./wnfs-core.js');

self.onmessage = async ({ data: { operation, record, secret, rows, root, capsule, packs, extension, recipient, recipients, releaseKey } }) => {
  try {
    if (operation === 'public-recipient') {
      self.postMessage({ result: await self.AwaiDriveWnfs.publicRecipient(record) });
    } else if (operation === 'validate-recipient') {
      self.postMessage({ result: await self.AwaiDriveWnfs.validateRecipient(recipient) });
    } else if (operation === 'seal') {
      const result = await self.AwaiDriveWnfs.seal(record, secret, rows, recipients);
      self.postMessage({ result }, [result.capsule.bytes.buffer, ...result.packs.map(bytes => bytes.buffer), ...result.grants.flatMap(g => [g.capsule.bytes.buffer, g.releaseKey.buffer])]);
    } else if (operation === 'catalog') {
      self.postMessage({ result: await self.AwaiDriveWnfs.catalog(record, secret, root, capsule, packs) });
    } else if (operation === 'open' || operation === 'inspect' || operation === 'open-share') {
      const snapshot = await self.AwaiDriveWnfs.openSnapshot(record, secret, root, capsule, packs, releaseKey);
      const started = performance.now();
      const query = self.AwaiDriveWnfs.project(snapshot);
      const indexed = performance.now();
      const matches = query(snapshot.basis, extension);
      const result = { basis: snapshot.basis, matches, files: snapshot.rows.filter(row => !row.directory).length,
        indexMs: indexed - started, queryMs: performance.now() - indexed };
      if (operation === 'open-share') result.entries = self.AwaiDriveWnfs.inventory(snapshot.rows);
      if (operation !== 'inspect') {
        self.postMessage({ result: { ...result, rows: snapshot.rows } },
          snapshot.rows.flatMap(row => (row.chunks || []).map(bytes => bytes.buffer)));
      } else {
        for (const row of snapshot.rows) for (const bytes of row.chunks || []) bytes.fill(0);
        self.postMessage({ result });
      }
    } else {
      throw Error('invalid-wnfs-worker-operation');
    }
  } catch (error) {
    self.postMessage({ error: String(error?.message || 'invalid-wnfs-snapshot').slice(0, 80) });
  } finally {
    secret.fill(0);
    releaseKey?.fill(0);
    for (const row of rows || []) row.bytes?.fill(0);
  }
};
