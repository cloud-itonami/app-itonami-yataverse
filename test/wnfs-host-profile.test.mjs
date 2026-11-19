import assert from 'node:assert/strict';
import test from 'node:test';
import { createWnfsSync } from '../app/src/wnfs-sync.js';

test('macOS retains the local-owner WNFS restore IPC', async () => {
  const calls = [];
  const sync = createWnfsSync({
    supportsSharing: async () => false,
    invoke: async (op, request) => {
      calls.push([op, JSON.parse(JSON.stringify(request))]);
      return op === 'vaultWnfsRestorePublish' ? { folder: 'Recovered' } : {};
    }
  });
  const bytes = Uint8Array.of(65);
  assert.deepEqual(await sync.restoreCopy([{ path: 'a.txt', chunks: [bytes] }]), { folder: 'Recovered' });
  assert.equal(bytes[0], 0);
  assert.deepEqual(calls, [
    ['vaultWnfsRestoreBegin', { legacy: false }],
    ['vaultWnfsRestoreWrite', { path: 'a.txt', offset: 0, bytes: 'QQ==' }],
    ['vaultWnfsRestorePublish', { legacy: false }]
  ]);
});

test('Android refuses to write a restore when the native operation token is absent', async () => {
  const calls = [];
  const sync = createWnfsSync({
    invoke: async op => {
      calls.push(op);
      return {};
    }
  });
  const bytes = Uint8Array.of(65);
  await assert.rejects(sync.restoreCopy([{ path: 'a.txt', chunks: [bytes] }]), /restore-operation-missing/);
  assert.deepEqual(calls, ['vaultWnfsRestoreBegin']);
  assert.equal(bytes[0], 0);
});
