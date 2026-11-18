import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';
// The awai-os files copied into vendor/awai-os must stay byte-identical to the pinned revision.
test('vendored awai-os files match their recorded SHA-256',()=>{
 const base=new URL('../vendor/awai-os/',import.meta.url),pins=JSON.parse(fs.readFileSync(new URL('PINS-AWAI-OS.json',base)));
 assert.match(pins.revision,/^[0-9a-f]{40}$/);
 for(const [p,h] of Object.entries(pins.files))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(p,base))).digest('hex'),h,p);
});
test('the store origin is yataverse.com and only it is reachable',()=>{
 const d=JSON.parse(fs.readFileSync(new URL('../dist/descriptor.json',import.meta.url)));
 assert.deepEqual([...new Set(d.operations.map(o=>o.endpoint.origin))],['https://yataverse.com']);
 assert.ok(d.operations.every(o=>o.consent==='each-operation'));
 const csp=JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url))).app.security.csp;
 assert.match(csp,/connect-src https:\/\/yataverse\.com ipc:/);
});

test('consent denial from the canonical broker maps to its own message', async () => {
  const runtime = fs.readFileSync(new URL('../vendor/awai-os/otehon/shell/vendor/kotoba-client-runtime.js', import.meta.url), 'utf8');
  const i18n = fs.readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  const thrown = runtime.match(/throw new Error\('client (operation was not approved)'\)/)[1];
  assert.ok(i18n.includes(`"error.${thrown}"`), 'i18n must key the broker denial text');
});
