import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_URL, DEFAULT_READ_URL, DEFAULT_PREFIX } from '../src/config.mjs';

// Owner decision 2026-11-17 (AWAI-3102): the bytes plane uses yataverse.com hosts;
// kotobase is a library name, not a host.
test('default read and write endpoints are the yataverse.com Worker', () => {
  assert.equal(DEFAULT_URL, 'https://yataverse.com');
  assert.equal(DEFAULT_READ_URL, 'https://yataverse.com');
  assert.equal(DEFAULT_PREFIX, '/ipfs/');
});
