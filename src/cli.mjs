import fs from 'node:fs';
import readline from 'node:readline';
import { once } from 'node:events';
import { rawCid, parseCid, normalizeCid } from './cid.mjs';
import { loadConfig, saveConfig, status, configDir, ConfigError } from './config.mjs';
import { makeAuthorizer } from './auth.mjs';
import { makeClient } from './client.mjs';
import { serve } from './mcp.mjs';
import { keygen, adminStatus, makeAdmin, AdminError } from './admin.mjs';
import { canonicalAssetManifest } from './asset-manifest.mjs';
import { assetDidRecord } from './asset-did.mjs';

const USAGE = `yataverse — CLI for the yataverse bytes plane (formerly kotobase)

  yataverse cid <file|->               print the CIDv1 (raw, sha2-256) of a file or stdin
  yataverse canonical-cid <cid>        normalize a CIDv0 or CIDv1 to CIDv1 base32
  yataverse get <cid> [-o file]        read a block, verified against its CID (stdout if no -o)
  yataverse verify <cid>               is it present, and do the served bytes hash to it?
  yataverse put <file|->               publish a block, then read it back and verify
  yataverse asset-manifest <json|->    validate and canonicalize a training-asset manifest
  yataverse asset-did <cid> [--domain host]  derive the deterministic Murakumo did:web for a CID
  yataverse asset-did-index <jsonl|-> [--domain host]
                                       stream unique CIDs to JSONL DID records (CID-only, unverified)
  yataverse status                     how this machine is configured (names only, no secrets)
  yataverse config init [--url U] [--read-url U] [--prefix P] [--tenant-id t_..] [--storage S]
                        [--sa-token-stdin]   write ~/.config/yataverse (secret from stdin, 0600)
  yataverse token                      print a fresh Authorization value (for another tool's
                                       auth-cmd, e.g. murakumo's yataverse.auth-cmd). It IS a secret.
  yataverse mcp                        run as an MCP server on stdio

Administration (Authn) — uses YOUR ed25519 key; the first sign-in creates the account:
  yataverse bootstrap --yes [--tenant-name N] [--sa-name N] [--storage S]
                                       keygen -> sign in -> tenant -> service account, idempotent. --yes is required:
                                       the first sign-in CREATES AN ACCOUNT. The secret is stored (0600), never printed.
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

async function writeAssetDidIndex(inputPath, domain, stdout) {
  const input = inputPath === '-' || inputPath === undefined
    ? process.stdin
    : fs.createReadStream(inputPath);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const seen = new Set();
  let lineNumber = 0;
  let count = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = line.trimStart().startsWith('{') ? JSON.parse(line) : line.trim();
    } catch {
      throw new Error(`inventory line ${lineNumber} is not valid JSON`);
    }
    const cidValue = typeof parsed === 'string' ? parsed : parsed?.cid;
    let record;
    try {
      record = assetDidRecord(cidValue, domain);
    } catch (error) {
      throw new Error(`inventory line ${lineNumber}: ${error.message}`);
    }
    if (seen.has(record.cid)) continue;
    seen.add(record.cid);
    const output = {
      ...record,
      ...(Number.isSafeInteger(parsed?.bytes) && parsed.bytes >= 0
        ? { inventoryBytes: parsed.bytes }
        : {}),
    };
    if (!stdout.write(`${JSON.stringify(output)}\n`)) await once(stdout, 'drain');
    count++;
  }
  return { uniqueCids: count };
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') out.o = argv[++i];
    else if (a === '--sa-token-stdin') out.saTokenStdin = true
    else if (a === '--print') out.print = true
    else if (a === '--yes') out.yes = true;
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
      case 'canonical-cid': {
        const cid = normalizeCid(f._[0]);
        if (!cid) throw new Error('expected a supported CIDv0 or CIDv1 sha2-256 CID');
        out({ cid, version: 1 });
        return 0;
      }
      case 'asset-did': {
        out(assetDidRecord(f._[0], f.domain ?? process.env.TRAINING_ASSET_DID_DOMAIN));
        return 0;
      }
      case 'asset-did-index': {
        const result = await writeAssetDidIndex(
          f._[0], f.domain ?? process.env.TRAINING_ASSET_DID_DOMAIN, stdout,
        );
        stderr.write(`wrote ${result.uniqueCids} unique CID DID records; all remain unregistered and unverified\n`);
        return 0;
      }
      case 'asset-manifest': {
        const manifest = canonicalAssetManifest(readInput(f._[0]).toString('utf8'));
        stdout.write(manifest);
        return 0;
      }
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
      case 'bootstrap': {
        out(await makeAdmin(loadConfig()).bootstrap({ yes: Boolean(f.yes), tenantName: f.tenantName, saName: f.saName, storage: f.storage, role: f.role }));
        return 0;
      }
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
