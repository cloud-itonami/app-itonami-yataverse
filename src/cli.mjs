import fs from 'node:fs';
import { rawCid, parseCid } from './cid.mjs';
import { loadConfig, saveConfig, status, configDir, ConfigError } from './config.mjs';
import { makeAuthorizer } from './auth.mjs';
import { makeClient } from './client.mjs';
import { serve } from './mcp.mjs';

const USAGE = `yataverse — CLI for the yataverse bytes plane (formerly kotobase)

  yataverse cid <file|->               print the CIDv1 (raw, sha2-256) of a file or stdin
  yataverse get <cid> [-o file]        read a block, verified against its CID (stdout if no -o)
  yataverse verify <cid>               is it present, and do the served bytes hash to it?
  yataverse put <file|->               publish a block, then read it back and verify
  yataverse status                     how this machine is configured (names only, no secrets)
  yataverse config init [--url U] [--read-url U] [--prefix P] [--tenant-id t_..] [--storage S]
                        [--sa-token-stdin]   write ~/.config/yataverse (secret from stdin, 0600)
  yataverse token                      print a fresh Authorization value (for another tool's
                                       auth-cmd, e.g. murakumo's yataverse.auth-cmd). It IS a secret.
  yataverse mcp                        run as an MCP server on stdio

Writes are authorised by, in order: YATAVERSE_AUTH_CMD / config authCmd (your minter, argv, no shell),
a tenant service-account secret (~/.config/yataverse/sa-token, 0600) exchanged at Authn for a Biscuit,
or a static value. This tool mints no credential; a service-account secret comes from a tenant admin.
`;

const readInput = (arg) => (arg === '-' || arg === undefined) ? fs.readFileSync(0) : fs.readFileSync(arg);

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') out.o = argv[++i];
    else if (a === '--sa-token-stdin') out.saTokenStdin = true;
    else if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else out._.push(a);
  }
  return out;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  const out = (x) => stdout.write(typeof x === 'string' ? x : JSON.stringify(x, null, 2) + '\n');
  try {
    switch (cmd) {
      case undefined: case 'help': case '--help': case '-h': out(USAGE); return 0;
      case 'cid': { const b = readInput(f._[0]); out({ cid: rawCid(b), bytes: b.length }); return 0; }
      case 'status': out(status(loadConfig())); return 0;
      case 'config': {
        if (f._[0] !== 'init') { stderr.write('usage: yataverse config init [...]\n'); return 2; }
        let saToken;
        if (f.saTokenStdin) saToken = fs.readFileSync(0, 'utf8').trim();
        const dir = saveConfig({ url: f.url, readUrl: f.readUrl, prefix: f.prefix, tenantId: f.tenantId, storage: f.storage, saToken });
        out({ wrote: dir, saTokenStored: saToken !== undefined });
        return 0;
      }
      case 'get': case 'verify': case 'put': case 'token': {
        const cfg = loadConfig();
        const authorize = makeAuthorizer(cfg);
        if (cmd === 'token') { stdout.write(await authorize() + '\n'); return 0; }
        const client = makeClient(cfg, { authorize });
        if (cmd === 'get') {
          const bytes = await client.get(f._[0]);
          if (!bytes) { stderr.write('not found\n'); return 1; }
          if (f.o) fs.writeFileSync(f.o, bytes); else stdout.write(bytes);
          return 0;
        }
        if (cmd === 'verify') { const r = await client.verifyRemote(f._[0]); out(r); return r.verified ? 0 : 1; }
        const r = await client.putBytes(readInput(f._[0])); out(r); return 0;
      }
      case 'mcp': serve(); return await new Promise(() => {});
      default: stderr.write(`unknown command: ${cmd}\n\n${USAGE}`); return 2;
    }
  } catch (e) {
    // codes and short details only: nothing here can contain a secret value
    stderr.write(`yataverse: ${e instanceof ConfigError || e.code ? e.message : String(e.message).slice(0, 200)}\n`);
    return 1;
  }
}
