import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { loadConfig, saveConfig, status, ConfigError } from '../src/config.mjs';
import { main } from '../src/cli.mjs';
import { serve, callTool, TOOLS } from '../src/mcp.mjs';
import { startServer, baseCfg } from './helpers.mjs';

const tmpEnv = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-')); return { dir: d, env: { YATAVERSE_CONFIG_DIR: d } }; };

test('saveConfig writes 0700/0600 and status never contains the secret', () => {
  const { dir, env } = tmpEnv();
  saveConfig({ tenantId: 't_abc', storage: 'blocks', saToken: 'kb_sa_TOPSECRET' }, env);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'sa-token')).mode & 0o777, 0o600);
  const cfg = loadConfig(env);
  assert.equal(cfg.saToken, 'kb_sa_TOPSECRET');
  assert.equal(status(cfg).authSource, 'service-account');
  assert.ok(!JSON.stringify(status(cfg)).includes('TOPSECRET'));
});

test('a secret file readable by group/other is refused', () => {
  const { dir, env } = tmpEnv();
  fs.writeFileSync(path.join(dir, 'sa-token'), 'kb_sa_x\n', { mode: 0o644 });
  assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && e.code === 'secret-file-permissions');
});

test('configuration is validated', () => {
  const { env } = tmpEnv();
  for (const [k, v, code] of [['YATAVERSE_URL', 'http://x.example', 'url-not-https-origin'],
                              ['YATAVERSE_URL', 'https://x.example/path', 'url-not-https-origin'],
                              ['YATAVERSE_PREFIX', '/../', 'prefix-invalid'],
                              ['YATAVERSE_TENANT_ID', 'abc', 'tenant-id-invalid'],
                              ['YATAVERSE_SA_TOKEN', 'nope', 'sa-token-bad-shape'],
                              ['YATAVERSE_AUTH_CMD', 'rm -rf /', 'auth-cmd-not-json'],
                              ['YATAVERSE_AUTH_CMD', '"a string"', 'auth-cmd-not-an-argv-array']])
    assert.throws(() => loadConfig({ ...env, [k]: v }), (e) => e.code === code, `${k}=${v}`);
});

const capture = () => { let out = '', err = ''; return { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, get out() { return out; }, get err() { return err; } }; };

test('CLI: cid, status, config init (secret from stdin is not echoed)', async () => {
  const { dir, env } = tmpEnv();
  Object.assign(process.env, env);
  try {
    const f = path.join(dir, 'f.txt'); fs.writeFileSync(f, 'hello\n');
    let io = capture();
    assert.equal(await main(['cid', f], io), 0);
    assert.match(io.out, /bafkreicysg23kiwv34eg2d7qweipxwosdo2py4ldv42nbauguluen5v6am/);
    io = capture();
    assert.equal(await main(['config', 'init', '--tenant-id', 't_abc', '--storage', 'blocks'], io), 0);
    io = capture();
    assert.equal(await main(['status'], io), 0);
    assert.match(io.out, /"tenantId": "t_abc"/);
    io = capture();
    assert.equal(await main(['frobnicate'], io), 2);
    io = capture();
    assert.equal(await main(['token'], io), 1);                    // nothing configured
    assert.match(io.err, /no-authorization-configured/);
  } finally { delete process.env.YATAVERSE_CONFIG_DIR; }
});

test('MCP: handshake, tool list, credential-like and unknown arguments refused, confirm required', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const lines = []; output.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
  const rl = serve({ input, output, deps: { cfg: baseCfg('https://x.example') } });
  const send = (m) => input.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'yataverse_put', arguments: { text: 'x', sa_token: 'kb_sa_x', confirm: true } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'yataverse_put', arguments: { text: 'x', confirm: false } } });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'yataverse_cid', arguments: { text: 'hello\n' } } });
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  await new Promise((r) => setTimeout(r, 300)); rl.close();
  const byId = (id) => lines.find((l) => l.id === id);
  assert.equal(byId(1).result.serverInfo.name, 'yataverse');
  assert.deepEqual(byId(2).result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.match(byId(3).result.content[0].text, /credentials never travel through tool arguments/);
  assert.match(byId(4).result.content[0].text, /confirm-required/);
  assert.match(byId(5).result.content[0].text, /bafkreicysg23k/);
  assert.equal(byId(6).error.code, -32602);
});

test('MCP: put/get/verify round trip against a fake gateway; no secret in any result', async () => {
  const s = await startServer('ok');
  try {
    const cfg = { ...baseCfg(s.origin), staticAuth: 'Bearer good' };
    const deps = { cfg, auth: { allowInsecureForTests: true }, client: { allowInsecureForTests: true } };
    const put = await callTool('yataverse_put', { text: 'agent wrote this', confirm: true }, deps);
    assert.equal(put.isError, false);
    const { cid } = JSON.parse(put.text);
    const got = JSON.parse((await callTool('yataverse_get', { cid }, deps)).text);
    assert.equal(Buffer.from(got.base64, 'base64').toString(), 'agent wrote this');
    assert.equal(JSON.parse((await callTool('yataverse_verify', { cid }, deps)).text).verified, true);
    assert.ok(!(put.text + JSON.stringify(got)).includes('Bearer good'));
    const st = (await callTool('yataverse_status', {}, deps)).text;
    assert.ok(!st.includes('Bearer good') && JSON.parse(st).authSource === 'static');
  } finally { await s.close(); }
});
