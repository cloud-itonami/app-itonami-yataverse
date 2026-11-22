// Legal L1 (KOTOBA-159): no OS cloud backup and no device-to-device transfer of this app's data.
// Android: allowBackup="false" (Android 11 and older) and dataExtractionRules excluding every domain from
// cloud-backup and device-transfer (Android 12 and newer). macOS: the Keychain key is queried with
// kSecAttrSynchronizable = false, so it is never an iCloud Keychain item.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const MAIN = 'src-tauri/gen/android/app/src/main';
const DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];

export function backupProblems(manifest, rules) {
  const problems = [];
  const app = /<application\b[^>]*>/s.exec(manifest)?.[0] ?? '';
  if (!/android:allowBackup="false"/.test(app)) problems.push('allowBackup is not "false"');
  const name = /android:dataExtractionRules="@xml\/([\w-]+)"/.exec(app)?.[1];
  if (!name) { problems.push('no dataExtractionRules'); return problems; }
  const xml = rules(name);
  for (const section of ['cloud-backup', 'device-transfer']) {
    const body = new RegExp(`<${section}(?:\\s[^>]*)?>([\\s\\S]*?)</${section}>`).exec(xml)?.[1];
    if (body === undefined) { problems.push(`no <${section}>`); continue; }
    if (/<include\b/.test(body)) problems.push(`<${section}> includes something`);
    for (const domain of DOMAINS) {
      if (!new RegExp(`<exclude\\s+domain="${domain}"\\s+path="\\."\\s*/>`).test(body)) problems.push(`<${section}> does not exclude ${domain}`);
    }
  }
  return problems;
}

test('Android: no cloud backup and no device-to-device transfer of app data', () => {
  assert.deepEqual(backupProblems(read(`${MAIN}/AndroidManifest.xml`), (name) => read(`${MAIN}/res/xml/${name}.xml`)), []);
});

test('negative control: the check fails on a manifest without the settings', () => {
  const bare = read(`${MAIN}/AndroidManifest.xml`).replace(/\s*android:allowBackup="false"/, '').replace(/\s*android:dataExtractionRules="[^"]*"/, '');
  assert.deepEqual(backupProblems(bare, () => ''), ['allowBackup is not "false"', 'no dataExtractionRules']);
  const partial = (name) => read(`${MAIN}/res/xml/${name}.xml`).replace('<exclude domain="file" path="." />', '');
  assert.ok(backupProblems(read(`${MAIN}/AndroidManifest.xml`), partial).some((p) => p.includes('does not exclude file')));
});

test('macOS: every Keychain query is not synchronizable', () => {
  const rs = read('src-tauri/src/keychain.rs');
  assert.match(rs, /set_access_synchronized\(Some\(false\)\)/);
  const production = rs.slice(0, rs.indexOf('#[cfg(test)]\nmod tests'));
  for (const legacy of ['get_generic_password(', 'set_generic_password(', 'delete_generic_password(']) {
    assert.ok(!production.includes(legacy), `${legacy} bypasses the non-synchronizable query`);
  }
});
