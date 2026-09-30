import fs from 'node:fs';
import { rawCid, parseCid } from './cid.mjs';
import { loadConfig, saveConfig, status, configDir, ConfigError } from './config.mjs';
import { makeAuthorizer } from './auth.mjs';
import { makeClient } from './client.mjs';
import { serve } from './mcp.mjs';
import { keygen, adminStatus, makeAdmin, AdminError } from './admin.mjs';

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

Administration (Authn) — uses YOUR ed25519 key; the first sign-in creates the account:
  yataverse admin keygen               create ~/.config/yataverse/admin.key (0600); prints the did:key only
  yataverse admin whoami               did:key and whether a session exists
  yataverse admin login                sign in to Authn with that key (creates the account on first use)
  yataverse tenant create <name>       create a tenant (you become its owner)
  yataverse tenant list                tenants you belong to
  yataverse tenant use <t_id> [--storage S]   make a tenant this machine's default
  yataverse member list|add --tenant t_.. [--user-id U --role R]
  yataverse sa create --tenant t_.. --name N [--role R] [--permissions a,b] [--storage S] [--print]
  yataverse sa list|rotate|revoke --tenant t_.. [--id sa_..] [--print]
                                       'sa create' and 'sa rotate' store the one-time kb_sa_ secret (0600) as this
                                       machine's write credential; it is printed only with --print.

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
    else if (a === '--sa-token-stdin') out.saTokenStdin = true
    else if (a === '--print') out.print = true;
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
      case 'admin': {
        if (f._[0] === 'keygen') { out(keygen()); return 0; }
        if (f._[0] === 'whoami') { out(adminStatus()); return 0; }
        if (f._[0] === 'login') { out(await makeAdmin(loadConfig()).login()); return 0; }
        stderr.write('usage: yataverse admin keygen|whoami|login\n'); return 2;
      }
      case 'tenant': case 'member': case 'sa': {
        const cfg = loadConfig(); const admin = makeAdmin(cfg); const [sub, arg] = f._;
        const tid = f.tenant ?? cfg.tenantId;
        const perms = f.permissions ? f.permissions.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
        if (cmd === 'tenant' && sub === 'create') { out(await admin.tenantCreate(arg)); return 0; }
        if (cmd === 'tenant' && sub === 'list') { out(await admin.tenantList()); return 0; }
        if (cmd === 'tenant' && sub === 'use') { out(admin.tenantUse(arg, f.storage)); return 0; }
        if (cmd === 'member' && sub === 'list') { out(await admin.memberList(tid)); return 0; }
        if (cmd === 'member' && sub === 'add') { out(await admin.memberAdd(tid, { userId: f.userId, role: f.role, permissions: perms })); return 0; }
        if (cmd === 'sa' && sub === 'list') { out(await admin.saList(tid)); return 0; }
        if (cmd === 'sa' && sub === 'create') { out(await admin.saCreate(tid, { name: f.name, role: f.role, permissions: perms, storage: f.storage, reveal: Boolean(f.print) })); return 0; }
        if (cmd === 'sa' && sub === 'rotate') { out(await admin.saRotate(tid, f.id, { storage: f.storage, reveal: Boolean(f.print) })); return 0; }
        if (cmd === 'sa' && sub === 'revoke') { out(await admin.saRevoke(tid, f.id)); return 0; }
        stderr.write(`usage: yataverse ${cmd} <subcommand> (see: yataverse help)\n`); return 2;
      }
      default: stderr.write(`unknown command: ${cmd}\n\n${USAGE}`); return 2;
    }
  } catch (e) {
    // codes and short details only: nothing here can contain a secret value
    stderr.write(`yataverse: ${e instanceof ConfigError || e instanceof AdminError || e.code ? e.message : String(e.message).slice(0, 200)}\n`);
    return 1;
  }
}
