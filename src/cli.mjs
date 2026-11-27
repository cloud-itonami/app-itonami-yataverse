import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { rawCid, parseCid, normalizeCid } from './cid.mjs';
import { loadConfig, saveConfig, status, configDir, ConfigError } from './config.mjs';
import { makeAuthorizer } from './auth.mjs';
import { makeClient, YataverseError } from './client.mjs';
import { packFiles, siteCars } from './unixfs.mjs';
import { verifyReceiptInput } from './verify-receipt.mjs';
import crypto from 'node:crypto';
import { envelopeFromJson, importSigningKey, keyIdFor, ZERO32 } from './receipt.mjs';
import {
  leaseEnvelopeFromJson, leaseEnvelopeToJson, leaseEnvelopeToDagCbor, statusEnvelopeToJson, statusEnvelopeToDagCbor, statusEnvelopeFromJson,
  leaseFromTerms, signLeaseAsRequester, signLeaseAsVerifier, leaseProposalToJson, leaseProposalFromJson, verifyLeaseProposal,
  verifyLease, verifyStatus, gradeSatisfied, GRADE, STATUS,
} from './retention.mjs';
import { cidToBytes, cidFromBytes } from './cid.mjs';
import { statusName } from './verifier.mjs';
import { runVerifierOnce } from './verifier.mjs';
import { makeArchiveProbe } from './archive-probe.mjs';
import { serve } from './mcp.mjs';
import { keygen, adminStatus, makeAdmin, loadKey, AdminError } from './admin.mjs';
import { canonicalAssetManifest } from './asset-manifest.mjs';
import { assetDidRecord } from './asset-did.mjs';
import { canonicalTrainingRunManifest } from './training-run-manifest.mjs';
import { buildOntologySnapshot, verifyOntologySnapshot } from './ontology.mjs';
import { getOntologySchema, invokeOntologyOperation } from './ontology-viewer.mjs';

/** The admin key is read only when the configured mode signs with it. */
const cacaoDeps = (cfg) => (cfg.authMode === 'cacao' ? { cacaoKey: loadKey() } : {});

const USAGE = `yataverse — CLI for the yataverse bytes plane (formerly kotobase)

  yataverse cid <file|->               print the CIDv1 (raw, sha2-256) of a file or stdin
  yataverse canonical-cid <cid>        normalize a CIDv0 or CIDv1 to CIDv1 base32
  yataverse get <cid> [-o file]        read a block, verified against its CID (stdout if no -o)
  yataverse verify <cid>               is it present, and do the served bytes hash to it?
  yataverse put <file|-> [--codec raw|dag-cbor|dag-pb]  publish a block (dag-cbor must be canonical, dag-pb a UnixFS node), then read it back and verify
  yataverse car-put <file.car|->       import a CARv1/CARv2 (roots + complete closure), then export and compare
      put and car-put also verify the signed storage receipt (required from yataverse.com) and print it.
      [--request-id <64 hex>]          reuse an id to retry a write and get the same receipt back
      [--keys <file>]                  verify against this key set instead of the host's /.well-known keys
  yataverse verify-receipt <response.json|-> [--keys <file>] [--file <path> --kind block|car|drive-pack [--codec raw|dag-cbor]]
                                       check a saved receipt: signature, key validity at acceptedAt, state; with
                                       --file, also the subject, digest and size recomputed from the file
  yataverse retention-keygen <file>    create an Ed25519 key for a lease requester or a retention verifier
                                       (private JWK, owner-readable only, never overwritten); prints the keyId
  yataverse lease-new --file <path> --until <ISO time|Nd> --verifier <0x keyId> --requester-key-file <jwk>
                        [--challenge-period <seconds>] [-o proposal.json]
                                       propose a grade R1 lease for one block, signed by the requester
  yataverse lease-cosign --lease <proposal.json> --signing-key-file <jwk> [-o lease.json]
                                       as the verifier the proposal names: check it and add the second signature
  yataverse put <file> --lease <lease.json>   write under that lease: the answer must be a retention receipt
                                       (store class operator-archive) for the lease, or the command fails
  yataverse retention-status --lease-id <0x id> | --cid <cid>   [--keys <keys.json>]
  yataverse retention-status --status <status.json> --lease <lease.json> --keys <keys.json>
                                       fetch the published status of a lease or block (or read a saved one) and
                                       check it against its lease and the published keys; a record past its
                                       validUntil is refused (the state is then unknown)
  yataverse retention-publish --status <status.json> --lease <lease.json> [--evidence <evidence.cbor>]
                                       publish a verifier-signed status (and its evidence record) to the host
  yataverse retention-verify-sweep --registry <dir> --keys <keys.json> --signing-key-file <jwk> --key-epoch <n>
                        [--archive-endpoint U --archive-bucket B ...] [--sample-read true] [--publish true]
                                       run the verifier over every <name>.lease.json in the directory (with
                                       <name>.write.json when present), write <name>.status.json and
                                       <name>.evidence.cbor, and publish them when asked. Meant to be run on a
                                       schedule by the verifier, at most one challenge period apart.
  yataverse retention-verify-once --lease <lease.json> --keys <keys.json> --signing-key-file <jwk> --key-epoch <n>
                        [--receipts <a.json,b.json,...>] [--inventory <cids.json>] [--sample-read true]
                        [--archive-endpoint U --archive-bucket B [--archive-prefix P] [--archive-region R]]
                        [--evidence-out <file>]
                                       one run of the retention verifier: check the lease, the receipts and the
                                       operator's archive copy, and print a signed retention status. The signing
                                       key file must be readable by its owner only. Archive credentials come from
                                       YATAVERSE_ARCHIVE_KEY_ID / YATAVERSE_ARCHIVE_APP_KEY. Provider proofs are not
                                       implemented, so a lease of grade R2 or R3 is reported as degraded.
  yataverse car-get <cid> [--scope all|block] [-o file.car]  export a root as a verified CARv1
  yataverse site-pack <dir> -o <outdir>  pack a directory as a UnixFS site (the CID \`ipfs add -r --cid-version=1\` gives)
                                       and write site-001.car, site-002.car, ... to import in that order with car-put.
                                       Local only: nothing is sent. Symbolic links are refused. Names starting with "."
                                       are left out and listed (as \`ipfs add -r\` does); --hidden true includes them,
                                       which a site needs for .well-known/.
  yataverse asset-manifest <json|->    validate and canonicalize a training-asset manifest
  yataverse training-run-manifest <json|-> validate and canonicalize run provenance (unverified)
  yataverse asset-did <cid> [--domain host]  derive the deterministic Murakumo did:web for a CID
  yataverse asset-did-index <jsonl|-> [--domain host] [--summary file]
                                       stream unique CID DIDs and bind input/index hashes
  yataverse ontology schema            print Semantic UI noun.verb ontology operation catalog & schemas
  yataverse ontology build <spec.json|-> [-o snapshot.car]
                                       build & verify canonical DAG-CBOR IPLD ontology snapshot (CARv1)
  yataverse ontology verify <snapshot.car|-> [--basis <cid>]
                                       verify CAR ontology snapshot CIDs, DAG-CBOR, closure & provenance
  yataverse ontology inspect <snapshot.car|-> [--basis <cid>]
                                       inspect object types, connectors, tables, joins & CID links
  yataverse ontology sql <snapshot.car|-> --query "<SQL>" [--basis <cid>] [--jurisdiction J] [--max-scan N] [--max-rows N]
                                       run bounded read-only SQL SELECT on a pinned ontology snapshot
  yataverse ontology sparql <snapshot.car|-> (--query "<SPARQL>" | --algebra-edn "<EDN>") [--basis <cid>] [--jurisdiction J]
                                       run bounded read-only SPARQL query/EDN algebra on a pinned snapshot
  yataverse ontology view <snapshot.car|-> [--format html|svg|json] [-o out] [--basis <cid>]
                                       render Semantic UI Ontology Viewer (HTML, SVG, or JSON viewModel)
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

With YATAVERSE_AUTH_MODE=cacao (or "authMode": "cacao" in config.json) every block and CAR write is signed
with the admin key (yataverse admin keygen) over a fresh nonce from the service; the key's did:key must be
listed as a writer there. CACAO signed with the operator's key is the default write path whenever that
key exists, and the did:key is derived as did:key:z + base58btc(0xed01 ‖ ed25519 public key) (src/cacao.mjs
keyFromSeed). The key may live in the OS keychain instead of admin.key (YATAVERSE_USE_KEYCHAIN=1, service
yataverse-admin-key). ATProto service-auth writes are not implemented on the client. Otherwise:
Writes are authorised by, in order: YATAVERSE_AUTH_CMD / config authCmd (your minter, argv, no shell),
a tenant service-account secret (~/.config/yataverse/sa-token, 0600) exchanged at Authn for a Biscuit,
or a static value. Token values in the environment (YATAVERSE_SA_TOKEN / YATAVERSE_AUTH) are read only
when --allow-bearer-token (or YATAVERSE_ALLOW_BEARER=1) is given. This tool mints no credential; a service-account secret comes from a tenant admin.
`;

const readInput = (arg) => (arg === '-' || arg === undefined) ? fs.readFileSync(0) : fs.readFileSync(arg);

async function writeAssetDidIndex(inputPath, domain, stdout, summaryPath) {
  const input = inputPath === '-' || inputPath === undefined
    ? process.stdin
    : fs.createReadStream(inputPath);
  const inputHash = createHash('sha256');
  const outputHash = createHash('sha256');
  input.on('data', (chunk) => inputHash.update(chunk));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const seen = new Map();
  let lineNumber = 0;
  let inputRows = 0;
  let duplicateRows = 0;
  let byteSizeConflicts = 0;
  let uniqueDeclaredBytes = 0n;
  let uniqueByteRecords = 0;
  let count = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    inputRows++;
    let parsed;
    try {
      const trimmed = line.trim();
      parsed = trimmed.startsWith('{') || trimmed.startsWith('"')
        ? JSON.parse(trimmed)
        : trimmed;
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
    const bytes = Number.isSafeInteger(parsed?.bytes) && parsed.bytes >= 0
      ? parsed.bytes
      : undefined;
    if (seen.has(record.cid)) {
      duplicateRows++;
      const previous = seen.get(record.cid);
      if (bytes !== undefined && previous.bytes !== undefined && bytes !== previous.bytes) {
        byteSizeConflicts++;
      }
      continue;
    }
    seen.set(record.cid, { bytes });
    if (bytes !== undefined) {
      uniqueDeclaredBytes += BigInt(bytes);
      uniqueByteRecords++;
    }
    const output = {
      ...record,
      ...(bytes === undefined ? {} : { inventoryBytes: bytes }),
    };
    const jsonLine = `${JSON.stringify(output)}\n`;
    outputHash.update(jsonLine);
    if (!stdout.write(jsonLine)) await once(stdout, 'drain');
    count++;
  }
  const sourceName = !inputPath || inputPath === '-'
    ? 'stdin'
    : inputPath.split(/[\\/]/).at(-1);
  const summary = {
    schema: 'yataverse.asset-did-index-summary/v1',
    domain: (domain ?? 'api.murakumo.cloud').toLowerCase(),
    source: {
      name: sourceName,
      sha256: inputHash.digest('hex'),
      nonEmptyRows: inputRows,
    },
    index: {
      format: 'jsonl',
      uniqueCids: count,
      sha256: outputHash.digest('hex'),
    },
    duplicateRows,
    byteSizeConflicts,
    declaredBytes: {
      uniqueCidRecords: uniqueByteRecords,
      total: uniqueDeclaredBytes.toString(),
      status: 'inventory-declared-not-byte-verified',
    },
    evidenceStatus: 'cid-only-unverified',
    recordStatus: 'unregistered',
    rewardStatus: 'not-eligible-unregistered',
  };
  if (summaryPath) {
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  }
  return summary;
}

/** A private signing key file: refused when anyone but its owner can read it. */
async function readSigningKey(file) {
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) {
    const e = new Error('signing-key-file-is-readable-by-others (chmod 600)'); e.code = 'signing-key-file-is-readable-by-others'; throw e;
  }
  return importSigningKey(fs.readFileSync(file, 'utf8'));
}

/** One verifier run from files (shared by retention-verify-once and retention-verify-sweep). */
async function verifyOnce({ f, signer, leaseFile, receiptFiles, env, fetchImpl, now }) {
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  // A receipt file is a bare envelope or a write response; a locking write's response also
  // names the version it locked, which the verifier then checks instead of the newest one.
  const versions = {};
  const receiptEnvs = receiptFiles.map((p) => {
    const j = readJson(p);
    if (typeof j?.cid === 'string' && typeof j?.archive?.versionId === 'string') versions[j.cid] = j.archive.versionId;
    return envelopeFromJson(j && j.v === 1 && j.sig ? j : j?.receipt);
  });
  const probe = f.archiveEndpoint ? makeArchiveProbe({ endpoint: f.archiveEndpoint, bucket: f.archiveBucket, prefix: f.archivePrefix ?? '',
    region: f.archiveRegion, keyId: env.YATAVERSE_ARCHIVE_KEY_ID, secret: env.YATAVERSE_ARCHIVE_APP_KEY, ...(fetchImpl ? { fetchImpl } : {}) }) : null;
  return runVerifierOnce({ leaseEnv: leaseEnvelopeFromJson(readJson(leaseFile)), receiptEnvs, keys: readJson(f.keys), probe, signer,
    keyEpoch: Number(f.keyEpoch), now: now(), inventory: f.inventory ? readJson(f.inventory) : undefined, sampleRead: f.sampleRead === 'true', versions });
}
const verifyOutput = (run) => ({ summary: run.summary, status: statusEnvelopeToJson(run.status), statusCid: statusEnvelopeToDagCbor(run.status).cid,
  evidenceCid: run.evidence.cid, evidenceRoot: '0x' + Buffer.from(run.evidence.root).toString('hex') });

/** Publish the evidence record (as an ordinary dag-cbor block) and then the status that commits to it. */
async function publishRun(client, leaseEnv, statusEnv, evidenceBytes) {
  let evidence = null;
  if (evidenceBytes) {
    const digest = createHash('sha256').update(evidenceBytes).digest();
    if (!digest.equals(Buffer.from(statusEnv.status.evidenceRoot))) { const e = new Error('evidence-does-not-match-the-status'); e.code = 'evidence-does-not-match-the-status'; throw e; }
    evidence = (await client.putBytes(evidenceBytes, { codec: 'dag-cbor' })).cid;
  }
  return { ...(await client.publishStatus(leaseEnv, statusEnv)), evidenceCid: evidence };
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') out.o = argv[++i];
    else if (a === '--sa-token-stdin') out.saTokenStdin = true
    else if (a === '--allow-bearer-token' || a === '--allow-bearer') out.allowBearerToken = true
    else if (a === '--print') out.print = true
    else if (a === '--yes') out.yes = true;
    else if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else out._.push(a);
  }
  return out;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, fetchImpl, now = Date.now, env = process.env } = {}) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  // Token credentials out of the environment are opt-in, never the default: only with
  // --allow-bearer-token (or YATAVERSE_ALLOW_BEARER=1) are YATAVERSE_SA_TOKEN and
  // YATAVERSE_AUTH read. CACAO signed with the operator key is the default write mode.
  if (f.allowBearerToken) process.env.YATAVERSE_ALLOW_BEARER = '1';
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
          f._[0], f.domain ?? process.env.TRAINING_ASSET_DID_DOMAIN, stdout, f.summary,
        );
        stderr.write(`wrote ${result.index.uniqueCids} unique CID DID records; source sha256 ${result.source.sha256}; index sha256 ${result.index.sha256}; all candidates remain unregistered and unverified\n`);
        return 0;
      }
      case 'asset-manifest': {
        const manifest = canonicalAssetManifest(readInput(f._[0]).toString('utf8'));
        stdout.write(manifest);
        return 0;
      }
      case 'training-run-manifest': {
        const manifest = canonicalTrainingRunManifest(readInput(f._[0]).toString('utf8'));
        stdout.write(manifest);
        return 0;
      }
      case 'ontology': {
        const [sub, target] = f._;
        if (sub === 'schema') {
          out(getOntologySchema());
          return 0;
        }
        if (sub === 'build') {
          const spec = JSON.parse(readInput(target).toString('utf8'));
          const snap = buildOntologySnapshot(spec);
          if (f.o) fs.writeFileSync(f.o, snap.carBytes);
          out({
            basisCid: snap.basisCid,
            schema: snap.schema,
            id: snap.id,
            blockCids: snap.blockCids,
            stats: snap.stats,
            carBytes: snap.carBytes.length,
            ...(f.o ? { carFile: f.o } : {}),
          });
          return 0;
        }
        if (sub === 'verify') {
          const carBytes = readInput(target);
          const snap = verifyOntologySnapshot(carBytes, { expectedBasisCid: f.basis ?? null });
          const res = await invokeOntologyOperation('ontology.verify', { basisCid: snap.basisCid }, { snapshot: snap });
          out(res);
          return 0;
        }
        if (sub === 'inspect') {
          const carBytes = readInput(target);
          const snap = verifyOntologySnapshot(carBytes, { expectedBasisCid: f.basis ?? null });
          const res = await invokeOntologyOperation('ontology.inspect', { basisCid: snap.basisCid }, { snapshot: snap });
          out(res);
          return 0;
        }
        if (sub === 'sql') {
          if (!f.query) { stderr.write('yataverse: ontology sql needs --query "<SQL>"\n'); return 2; }
          const carBytes = readInput(target);
          const snap = verifyOntologySnapshot(carBytes, { expectedBasisCid: f.basis ?? null });
          const limits = {};
          if (f.maxScan) limits.maxScanRows = Number(f.maxScan);
          if (f.maxRows) limits.maxResultRows = Number(f.maxRows);
          const res = await invokeOntologyOperation('ontology.query_sql', {
            basisCid: f.basis ?? snap.basisCid,
            query: f.query,
            ...(f.jurisdiction ? { jurisdiction: f.jurisdiction } : {}),
            ...(f.allowedSources ? { allowedSources: f.allowedSources.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
            ...(Object.keys(limits).length ? { limits } : {}),
          }, { snapshot: snap });
          out(res);
          return 0;
        }
        if (sub === 'sparql') {
          if (!f.query && !f.algebraEdn) {
            stderr.write('yataverse: ontology sparql needs --query "<SPARQL>" or --algebra-edn "<EDN>"\n');
            return 2;
          }
          const carBytes = readInput(target);
          const snap = verifyOntologySnapshot(carBytes, { expectedBasisCid: f.basis ?? null });
          const limits = {};
          if (f.maxScan) limits.maxScanSteps = Number(f.maxScan);
          if (f.maxRows) limits.maxSolutions = Number(f.maxRows);
          const res = await invokeOntologyOperation('ontology.query_sparql', {
            basisCid: f.basis ?? snap.basisCid,
            ...(f.query ? { query: f.query } : { algebraEdn: f.algebraEdn }),
            ...(f.jurisdiction ? { jurisdiction: f.jurisdiction } : {}),
            ...(f.allowedSources ? { allowedSources: f.allowedSources.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
            ...(Object.keys(limits).length ? { limits } : {}),
          }, { snapshot: snap });
          out(res);
          return 0;
        }
        if (sub === 'view') {
          const format = f.format ?? 'html';
          const carBytes = readInput(target);
          const snap = verifyOntologySnapshot(carBytes, { expectedBasisCid: f.basis ?? null });
          const res = await invokeOntologyOperation('ontology.view', {
            basisCid: f.basis ?? snap.basisCid,
            format,
            ...(f.title ? { title: f.title } : {}),
            ...(f.apiBase ? { apiBase: f.apiBase } : {}),
          }, { snapshot: snap });
          const payload = format === 'html' ? res.result.html
            : format === 'svg' ? res.result.svg
            : JSON.stringify(res, null, 2) + '\n';
          if (f.o) {
            fs.writeFileSync(f.o, payload, 'utf8');
            out({ basisCid: snap.basisCid, format, wrote: f.o, bytes: Buffer.byteLength(payload, 'utf8') });
          } else {
            stdout.write(payload);
          }
          return 0;
        }
        stderr.write('usage: yataverse ontology schema|build|verify|inspect|sql|sparql|view ...\n');
        return 2;
      }
      case 'site-pack': {
        if (!f._[0] || !f.o) throw new YataverseError('usage', 'site-pack <dir> -o <outdir> [--hidden true]');
        const files = new Map(); const skipped = [];
        const walk = (dir, rel) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
            // Like `ipfs add -r` without -H: names starting with "." are left out unless asked for.
            if (e.name.startsWith('.') && f.hidden !== 'true') { skipped.push(r); continue; }
            if (e.isSymbolicLink()) throw new YataverseError('site-has-symbolic-link', r);
            if (e.isDirectory()) walk(p, r);
            else if (e.isFile()) files.set(r, fs.readFileSync(p));
            else throw new YataverseError('site-entry-not-a-file', r);
          }
        };
        walk(f._[0], '');
        if (!files.size) throw new YataverseError('site-is-empty', f._[0]);
        const site = packFiles(files);
        const cars = siteCars(site.blocks);
        fs.mkdirSync(f.o, { recursive: true });
        const written = cars.map((c, i) => {
          const file = path.join(f.o, `site-${String(i + 1).padStart(3, '0')}.car`);
          fs.writeFileSync(file, c.car);
          return { file, roots: c.roots, blocks: c.blocks, bytes: c.bytes };
        });
        let bytes = 0; for (const b of files.values()) bytes += b.length;
        out({ root: site.root, dnslink: `dnslink=/ipfs/${site.root}`, files: files.size, fileBytes: bytes, blocks: site.blocks.size, cars: written,
              ...(skipped.length ? { skippedHidden: skipped } : {}) });
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
      case 'verify-receipt': {
        const input = JSON.parse(readInput(f._[0]).toString('utf8'));
        const keys = f.keys ? JSON.parse(fs.readFileSync(f.keys, 'utf8')) : await makeClient(loadConfig(), fetchImpl ? { fetchImpl } : {}).receiptKeys();
        out(await verifyReceiptInput(input, keys, { file: f.file ? fs.readFileSync(f.file) : undefined, kind: f.kind, codec: f.codec }));
        return 0;
      }
      case 'retention-keygen': {
        if (!f._[0]) { stderr.write('yataverse: retention-keygen needs an output file\n'); return 2; }
        const j = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
        // 'wx': never replace an existing key file.
        fs.writeFileSync(f._[0], JSON.stringify({ kty: j.kty, crv: j.crv, d: j.d, x: j.x }) + '\n', { flag: 'wx', mode: 0o600 });
        out({ file: f._[0], keyId: '0x' + Buffer.from(keyIdFor(new Uint8Array(Buffer.from(j.x, 'base64url')))).toString('hex'),
              publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: j.x }, note: 'the private key is in the file only; to act as a verifier this key must be published with use retention-verifier' });
        return 0;
      }
      case 'lease-new': {
        for (const k of ['file', 'until', 'verifier', 'requesterKeyFile']) if (!f[k]) { stderr.write(`yataverse: lease-new needs --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}\n`); return 2; }
        const bytes = fs.readFileSync(f.file);
        const t0 = now();
        const days = /^(\d{1,4})d$/.exec(f.until);
        const until = days ? t0 + Number(days[1]) * 86_400_000 : Date.parse(f.until);
        if (!Number.isFinite(until)) { stderr.write('yataverse: bad --until (an ISO time, or a number of days such as 30d)\n'); return 2; }
        const vm = /^(?:0x)?([0-9a-f]{64})$/.exec(String(f.verifier).toLowerCase());
        if (!vm) { stderr.write('yataverse: bad --verifier (64 hex)\n'); return 2; }
        const signer = await readSigningKey(f.requesterKeyFile);
        const lease = leaseFromTerms({ subject: cidToBytes(rawCid(bytes)), size: bytes.length, pieceCommitment: ZERO32, grade: GRADE.R1, providerReplicas: 0,
          domainPolicy: ZERO32, notBefore: t0, retentionUntil: until, challengePeriod: f.challengePeriod ? Number(f.challengePeriod) : 86_400,
          requester: signer.keyId, verifier: new Uint8Array(Buffer.from(vm[1], 'hex')), policyRevision: ZERO32 });
        const proposal = leaseProposalToJson({ lease, sigs: { requester: await signLeaseAsRequester(lease, signer) } });
        if (f.o) fs.writeFileSync(f.o, JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx' });
        out({ proposal, cid: rawCid(bytes), leaseId: proposal.lease.leaseId, retentionUntil: new Date(until).toISOString(),
              next: 'the verifier named in the proposal runs: yataverse lease-cosign --lease <this file> --signing-key-file <its key>' });
        return 0;
      }
      case 'lease-cosign': {
        for (const k of ['lease', 'signingKeyFile']) if (!f[k]) { stderr.write(`yataverse: lease-cosign needs --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}\n`); return 2; }
        const proposal = leaseProposalFromJson(JSON.parse(fs.readFileSync(f.lease, 'utf8')));
        const lease = await verifyLeaseProposal(proposal);
        const signer = await readSigningKey(f.signingKeyFile);
        const env = { v: 1, lease, sigs: { requester: proposal.sigs.requester, verifier: await signLeaseAsVerifier(lease, signer) } };
        const j = leaseEnvelopeToJson(env);
        if (f.o) fs.writeFileSync(f.o, JSON.stringify(j, null, 2) + '\n', { flag: 'wx' });
        out({ lease: j, leaseId: j.lease.leaseId, leaseCid: leaseEnvelopeToDagCbor(env).cid });
        return 0;
      }
      case 'retention-status': {
        // Either a saved record checked against a saved lease and key set, or the published record
        // of a lease or block, fetched from the host and verified here.
        let lease, s, source;
        if (f.leaseId || f.cid) {
          const client = makeClient(loadConfig(), { ...(fetchImpl ? { fetchImpl } : {}), ...(f.keys ? { receiptKeys: JSON.parse(fs.readFileSync(f.keys, 'utf8')) } : {}) });
          const got = await client.fetchStatus({ ...(f.leaseId ? { leaseId: f.leaseId } : { cid: f.cid }), now: now() });
          if (!got) { stderr.write('yataverse: no published status (the state is unknown)\n'); return 1; }
          ({ lease, status: s } = got); source = 'published';
        } else {
          for (const k of ['status', 'lease', 'keys']) if (!f[k]) { stderr.write(`yataverse: retention-status needs --lease-id, --cid, or --status with --lease and --keys\n`); return 2; }
          const keys = JSON.parse(fs.readFileSync(f.keys, 'utf8'));
          lease = await verifyLease(leaseEnvelopeFromJson(JSON.parse(fs.readFileSync(f.lease, 'utf8'))), keys);
          const sj = JSON.parse(fs.readFileSync(f.status, 'utf8'));
          s = await verifyStatus(statusEnvelopeFromJson(sj && sj.v === 1 && sj.sig ? sj : sj?.status), lease, keys, { now: now() });
          source = 'file';
        }
        const hex0x = (b) => '0x' + Buffer.from(b).toString('hex');
        out({ verified: true, source, status: statusName(s.status), satisfied: s.status === STATUS.policySatisfied, grade: `R${s.grade}`,
              operatorCopies: s.operatorCopies, providerReplicas: s.providerReplicas, countsMeetTheGrade: gradeSatisfied(lease, s),
              observedAt: new Date(s.observedAt).toISOString(), validUntil: new Date(s.validUntil).toISOString(),
              leaseId: hex0x(s.leaseId), leaseEnds: new Date(lease.retentionUntil).toISOString(), evidenceRoot: hex0x(s.evidenceRoot),
              evidenceCid: cidFromBytes(Uint8Array.of(0x01, 0x71, 0x12, 0x20, ...s.evidenceRoot)), verifier: hex0x(s.keyId),
              claims: 'the lease verifier observed these counts at observedAt; trust it until validUntil, after which the state is unknown' });
        return 0;
      }
      case 'retention-verify-once': {
        for (const k of ['lease', 'keys', 'signingKeyFile', 'keyEpoch']) if (!f[k]) { stderr.write(`yataverse: retention-verify-once needs --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}\n`); return 2; }
        const signer = await readSigningKey(f.signingKeyFile);
        const run = await verifyOnce({ f, signer, leaseFile: f.lease, receiptFiles: f.receipts ? f.receipts.split(',').filter(Boolean) : [], env, fetchImpl, now });
        if (f.evidenceOut) fs.writeFileSync(f.evidenceOut, run.evidence.bytes, { flag: 'wx' });
        out({ ...verifyOutput(run), published: false, note: 'nothing was published: the status and the evidence record exist only in this output' });
        return 0;
      }
      case 'retention-publish': {
        for (const k of ['status', 'lease']) if (!f[k]) { stderr.write(`yataverse: retention-publish needs --${k}\n`); return 2; }
        const cfg = loadConfig();
        const client = makeClient(cfg, { authorize: makeAuthorizer(cfg, cacaoDeps(cfg)), ...(fetchImpl ? { fetchImpl } : {}), ...(f.keys ? { receiptKeys: JSON.parse(fs.readFileSync(f.keys, 'utf8')) } : {}) });
        const sj = JSON.parse(fs.readFileSync(f.status, 'utf8'));
        out(await publishRun(client, leaseEnvelopeFromJson(JSON.parse(fs.readFileSync(f.lease, 'utf8'))),
          statusEnvelopeFromJson(sj && sj.v === 1 && sj.sig ? sj : sj?.status), f.evidence ? fs.readFileSync(f.evidence) : null));
        return 0;
      }
      case 'retention-verify-sweep': {
        for (const k of ['registry', 'keys', 'signingKeyFile', 'keyEpoch']) if (!f[k]) { stderr.write(`yataverse: retention-verify-sweep needs --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}\n`); return 2; }
        const signer = await readSigningKey(f.signingKeyFile);
        const publish = f.publish === 'true';
        let client = null;
        if (publish) { const cfg = loadConfig(); client = makeClient(cfg, { authorize: makeAuthorizer(cfg, cacaoDeps(cfg)), ...(fetchImpl ? { fetchImpl } : {}), receiptKeys: JSON.parse(fs.readFileSync(f.keys, 'utf8')) }); }
        // One lease per <name>.lease.json; <name>.write.json, when present, is the leased write's response.
        const names = fs.readdirSync(f.registry).filter((n) => n.endsWith('.lease.json')).map((n) => n.slice(0, -'.lease.json'.length)).sort();
        const results = [];
        for (const name of names) {
          const at = (ext) => `${f.registry}/${name}.${ext}`;
          try {
            const run = await verifyOnce({ f, signer, leaseFile: at('lease.json'), receiptFiles: fs.existsSync(at('write.json')) ? [at('write.json')] : [], env, fetchImpl, now });
            // Results replace the previous run's: the newest observation is the one that matters.
            fs.writeFileSync(at('status.json'), JSON.stringify(verifyOutput(run), null, 2) + '\n');
            fs.writeFileSync(at('evidence.cbor'), run.evidence.bytes);
            const r = { name, status: run.summary.status, leaseId: '0x' + Buffer.from(run.status.status.leaseId).toString('hex'), published: false };
            if (client) {
              try { await publishRun(client, leaseEnvelopeFromJson(JSON.parse(fs.readFileSync(at('lease.json'), 'utf8'))), run.status, run.evidence.bytes); r.published = true; }
              catch (e) { r.publishError = String(e.code ?? e.message).slice(0, 120); }
            }
            results.push(r);
          } catch (e) { results.push({ name, error: String(e.code ?? e.message).slice(0, 120) }); }   // one lease failing does not stop the others
        }
        const count = (st) => results.filter((r) => r.status === st).length;
        const failed = results.filter((r) => r.error || r.publishError).length;
        out({ observedAt: new Date(now()).toISOString(), leases: names.length, policySatisfied: count('policy-satisfied'), degraded: count('degraded'), expired: count('expired'), failed, results });
        return failed ? 1 : 0;
      }
      case 'get': case 'verify': case 'put': case 'token': case 'car-put': case 'car-get': {
        const cfg = loadConfig();
        const authorize = makeAuthorizer(cfg, cacaoDeps(cfg));
        if (cmd === 'token') { stdout.write(await authorize() + '\n'); return 0; }
        const client = makeClient(cfg, { authorize, ...(fetchImpl ? { fetchImpl } : {}),
          ...(f.keys ? { receiptKeys: JSON.parse(fs.readFileSync(f.keys, 'utf8')) } : {}) });
        if (cmd === 'get') {
          const bytes = await client.get(f._[0]);
          if (!bytes) { stderr.write('not found\n'); return 1; }
          if (f.o) fs.writeFileSync(f.o, bytes); else stdout.write(bytes);
          return 0;
        }
        if (cmd === 'verify') { const r = await client.verifyRemote(f._[0]); out(r); return r.verified ? 0 : 1; }
        if (cmd === 'car-put') { out(await client.putCar(readInput(f._[0]), { requestId: f.requestId })); return 0; }
        if (cmd === 'car-get') {
          const r = await client.getCar(f._[0], { scope: f.scope ?? 'all' });
          if (!r) { stderr.write('not found\n'); return 1; }
          if (f.o) { fs.writeFileSync(f.o, r.bytes); out({ cid: f._[0], blocks: r.blocks.size, bytes: r.bytes.length, verified: true }); }
          else stdout.write(r.bytes);
          return 0;
        }
        const lease = f.lease ? leaseEnvelopeFromJson(JSON.parse(fs.readFileSync(f.lease, 'utf8'))) : undefined;
        const r = await client.putBytes(readInput(f._[0]), { codec: f.codec ?? 'raw', requestId: f.requestId, lease }); out(r); return 0;
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
