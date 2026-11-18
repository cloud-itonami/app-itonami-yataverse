# yataverse

CLI and MCP server for the **yataverse** bytes plane (the bytes plane was formerly called kotobase; kotobase now names the datom/graph plane, root ADR-2610101900): content-addressed
blocks, **verified on every read and after every write**. Zero dependencies, Node 18+.

New uploads use CIDv1/raw/sha2-256. Reads also accept legacy CIDv0 dag-pb blocks and other supported
CIDv1 sha2-256 blocks, including multi-byte codec IDs in the Multiformats unsigned-varint format.
`yataverse` requests the raw block representation and refuses any response whose bytes do not match
the CID's multihash.

```sh
yataverse cid file.bin                 # the CID a file would have (local)
yataverse canonical-cid Qm...           # normalize a legacy CIDv0 to CIDv1 base32
yataverse get bafkrei... -o out.bin    # read, verified against the CID
yataverse verify bafkrei...            # present? and do the served bytes hash to it?
yataverse put file.bin                 # publish, then read back and verify
yataverse car-put dag.car              # import a CAR (roots + complete closure), then export and compare
yataverse car-get bafy... -o dag.car   # export a root as a verified CARv1 (--scope all|block)
yataverse put file.bin > r.json && yataverse verify-receipt r.json --file file.bin --kind block
                                       # check a saved signed storage receipt (also --kind car|drive-pack)
yataverse asset-manifest asset.json | yataverse put -  # canonicalize, publish, and verify the manifest
yataverse asset-did <cid>                             # derive its Murakumo did:web identifier
yataverse asset-did-index lake.jsonl > asset-dids.jsonl  # stream a supplied inventory into a DID index
yataverse status                       # how this machine is configured (names only)
yataverse config init --tenant-id t_... --storage blocks --sa-token-stdin < secret
yataverse token                        # a fresh Authorization value, for another tool's auth-cmd
yataverse mcp                          # MCP server on stdio
```

`put` and `car-put` send a fresh `Yataverse-Request-Id` and verify the signed storage receipt in
the response: the signature with the write host's published keys (or `--keys <file>`), the key's
validity at `acceptedAt`, and the client's own subject, digest, size, request id and requester.
A bad receipt is an error even though the bytes were stored. From `https://yataverse.com` a missing
receipt is also an error; other hosts may omit it (`requireReceipt: true` in the client config forces
it). `--request-id <64 hex>` retries a write and gets the same receipt back. A receipt says only
that the gateway stored and read back the bytes, not that they are retained or replicated.

## Reads and writes

- **Read**: `GET <readUrl>/ipfs/<cid>` (default `https://yataverse.com`, the Worker below). If a
  gateway answers with a `301` to a per-CID subdomain, that is followed (at most 3 hops) but **only
  inside the read host's own parent domain**, over https. Requests include `Accept: application/vnd.ipld.raw` and
  `?format=raw`, so legacy dag-pb blocks are checked as blocks rather than as decoded files.
- **Write**: `PUT <url><prefix><cid>` (default `https://yataverse.com/ipfs/`, `application/vnd.ipld.raw`).
  A write **never follows a redirect**: the `Authorization` header must not travel to another host.
  Writes accept CIDv1/sha2-256 blocks with codec raw (`put`, the default) or dag-cbor
  (`put --codec dag-cbor`), the core subset of the Awai File Format. A dag-cbor block must be
  canonical DAG-CBOR (definite lengths, shortest integers, sorted unique text map keys, tag 42
  links only, 64-bit finite floats). Every write is read back and its CID recomputed.

## Training asset manifests

`yataverse asset-manifest <json|->` validates the versioned Murakumo asset-manifest shape, sorts
fields and contributor claims into a stable representation, and writes canonical JSON to stdout. Pipe
that output to `yataverse put -` to publish the manifest and get its verified CID. A manifest may include
`trainingRunEvidenceCids` to reference immutable run-provenance records; this field is a list of claims
and does not verify that the run occurred.

`yataverse training-run-manifest <json|->` canonicalizes a run-provenance claim and fixes
`claimStatus: unverified`. It requires an epoch/run ID, UTC start/completion times, input, model and
output CIDs, a training-code CID, a sanitized configuration CID, receipt CIDs, and an operator DID.
The record contains no credentials or personal identity proofs. Its presence does not independently
prove execution; a Murakumo reviewer must read back the referenced bytes and verify that the target
asset, model, and completed epoch match the run. Publish the canonical manifest with
`yataverse put` only after removing private data, then list its returned CID in the asset manifest's
`trainingRunEvidenceCids`. A run-manifest input has this shape; replace every placeholder with
a verified Yataverse CID or an actual run identifier before canonicalizing:

```json
{
  "schema": "https://api.murakumo.cloud/training/run-manifest/v1",
  "runId": "actual-run-id",
  "epochId": "actual-completed-epoch-id",
  "startedAt": "2026-10-17T00:00:00Z",
  "completedAt": "2026-10-17T01:00:00Z",
  "inputCids": ["REPLACE_WITH_ASSET_CID"],
  "modelCids": ["REPLACE_WITH_MODEL_CID"],
  "outputCids": ["REPLACE_WITH_OUTPUT_CID"],
  "trainingCodeCid": "REPLACE_WITH_TRAINING_CODE_CID",
  "configCid": "REPLACE_WITH_SANITIZED_CONFIG_CID",
  "receiptCids": ["REPLACE_WITH_RUN_RECEIPT_CID"],
  "operatorDid": "did:web:example.org:operators:trainer"
}
```

The manifest references the model, dataset, checkpoint, adapter, or evaluation artifact by its existing Yataverse
CID, so adding a DID never requires rewriting the artifact bytes. Legacy CIDv0 values are normalized
to their equivalent CIDv1/dag-pb base32 representation in the canonical manifest.

`yataverse asset-did <cid>` derives the deterministic asset DID that the Murakumo training feature
resolves at `GET /training/assets/<cid>/did.json` when deployed. An earlier read-only production readback on 2026-10-17 returned 404 for `/training/policy` on the active
`local-murakumo` v393 Worker. A later direct probe could not resolve `api.murakumo.cloud` (curl status `000`), so current route availability is unresolved; see the [historical DID runtime status](docs/legacy-did-runtime-status-2026-10-17.md). To enumerate a supplied JSONL inventory, use
`yataverse asset-did-index <jsonl|-> [--domain host] [--summary file]`; each input line may be a CID string or an
object with `cid` and optional `bytes`. It streams one canonical JSON record per unique CID, including
the DID, resolver URL, `recordStatus: unregistered`, `evidenceStatus: cid-only-unverified`, and
`rewardStatus: not-eligible-unregistered`. A generated DID candidate cannot become reward-eligible
without a verified artifact root, rights, registered contributors, and reviewed training use. Set
`TRAINING_ASSET_DID_DOMAIN` or pass
`--domain` to match the domain configured on the deployed Murakumo Worker.

The input fields are `schema`, `assetType`, `artifactCid`, `license`, `rightsEvidenceCid`,
`contributors`, and optional `sourceCids`, `trainingRunIds`, `trainingRunEvidenceCids`, and `createdAt`. `contributors` is a list
of `{ "did", "role", "shareBps" }` claims. For example (replace the placeholders with real CIDs and
the registered contributor's wallet DID):

```json
{
  "schema": "https://api.murakumo.cloud/training/asset-manifest/v1",
  "assetType": "dataset",
  "artifactCid": "REPLACE_WITH_ARTIFACT_CID",
  "license": "CC-BY-4.0",
  "rightsEvidenceCid": "REPLACE_WITH_RIGHTS_EVIDENCE_CID",
  "trainingRunEvidenceCids": ["REPLACE_WITH_RUN_MANIFEST_CID"],
  "contributors": [
    {
      "did": "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
      "role": "data-provider",
      "shareBps": 10000
    }
  ]
}
```

The example DID is illustrative. A `did:pkh` claimant must match the wallet bound to that person's
World ID registration. Other DIDs can be used, but the Murakumo operator must verify their link to the
registered claimant before accepting the reward claim. Each contributor submits a separate claim;
the operator checks that the submitted DID and share match the published manifest. Contributor DIDs
are public in the manifest; a `did:pkh` exposes the wallet address and can be linked to its on-chain
activity.

The manifest carries an `unverified` claim status. A CID proves only which bytes were published; it
does not prove a contributor's identity, rights, consent, or training use. Murakumo must separately
match each claimant to a registered eligible human, verify the rights and provenance evidence, check
that accepted contributor claims total exactly 10,000 basis points, and record a read-back training-run
manifest that matches the asset and completed epoch before allocating a funded YATA pool. Do not put personal data or identity proofs in this public manifest.

### Historical model and data migration audit (2026-10-17)

The checked-in indexes currently derive nine model-catalog DIDs, two weight-hash CID/DID
candidates, and six inventory-manifest-root DIDs. They are identifiers only. Eight of the nine
catalog entries have no artifact CID; neither weight-derived CID has a byte readback; and none of
the six inventory roots has a remote bytes readback. The tracked candidate records remain
unregistered and not reward eligible.

A prior audit verified 825,258 unique CID rows across epoch 0–3 source inventories, totaling
91,395,006,284 declared bytes. Their 825,258-record DID candidate index is currently outside this
repository (43,829,349 compressed bytes) and has not been uploaded to Yataverse. The source inventory
for epoch 4 (24 rows) and epoch 6 (107 rows) is absent from the inspected workspace; epoch 5 is
excluded because it is a P6 drill action, not a lake listing. The six tracked roots cover inventory
epochs 0–4 and 6, but do not enumerate or verify the contained blocks. Do not describe the 825,258
rows or root DIDs as a complete asset catalog. The latest source-schedule and live-readback distinction is in the
[historical DID runtime status](docs/legacy-did-runtime-status-2026-10-17.md).

No verified rights-evidence CID, complete contributor-DID/share claims, or actual training-run
manifest has been found for the historical candidates. Therefore none is eligible for retroactive
YATA allocation. To migrate an existing asset, the claimant must supply its exact root CID, a
published asset manifest, rights evidence, contributor DIDs with an agreed complete share total of
10,000 basis points, and a run manifest linking that asset to the model and completed epoch. Each
claimant then submits their own `legacyAsset: true` claim from a registered wallet-bound human
account. Murakumo must read back the artifact, asset manifest, rights evidence, and run manifest;
verify claimant identity/share, deduplication, and actual completed-epoch use; and accept only the
complete reviewed share set. Existing catalogue names, hash notes, lake roots, or generated DIDs do
not supply any missing evidence.

After that review, the existing Murakumo source can automatically allocate only within an explicitly
funded YATA epoch to eligible registered humans, and prepare the epoch claim root. On-chain
publication/claims still require verified chain/token/distributor/Safe identities, owner authorization,
prefunding, and keeper configuration. A prepared root is not a payment. No historical claim or
reward is created by DID generation or manifest publication.

For a supplied inventory, use `yataverse asset-did-index inventory.jsonl --summary index-summary.json`
to stream one unregistered DID candidate per unique CID and write a summary binding the source SHA-256,
record count, duplicate count, and output-index SHA-256. The summary describes the supplied input; it
does not prove bytes, ownership, or asset-root completeness.

### Backfilling existing models and datasets

An existing Yataverse CID can receive a deterministic DID without moving or changing the bytes. The
Murakumo feature source resolves it at `GET /training/assets/<cid>/did.json`, but that route is not
available in the current production Worker. The CLI can derive a DID for one CID or write a
deduplicated index from a supplied lake inventory. These records identify CID bytes only; a lake
block can be an internal DAG node or shard rather than a complete dataset/model root, and every
generated entry remains unregistered. The Murakumo feature source also derives catalog DIDs for its
current model entries at `GET /training/models`; that route is also not deployed yet. Those DIDs name
catalog records, not model-weight bytes. A model DID document carries any source revision, license,
and weight fingerprints already present in the model catalog; those are registry claims, not a
Yataverse byte readback or proof of ownership. An operator can attach `artifactCid` and `assetManifestCid`
to a catalog entry; Murakumo then exposes a separate artifact DID, marked unverified until the
normal Yataverse readback and rights/contributor review pass. Model names or checksum text in
registry notes are not enough to identify a DAG root or qualify contributor rewards. The index
command processes an inventory file supplied by the operator; it does not query or enumerate an
account's remote content inventory.

When deployed, the asset DID document includes a `murakumo` status extension for registration, CID/manifest
readbacks, claim review, registered-human eligibility, and reward allocation. `claimStatus: reviewed`
means every submitted claim was accepted; partial or mixed claim decisions remain `mixed-review`.
The aggregate human-eligibility field does not disclose claimant IDs, wallets, World ID data, or
Human Passport scores. `rewardStatus: awaiting-complete-contributor-claims` and
`not-eligible-human` explain why accepted claims do not yet pass allocation's complete-share and
registered-human gates; `awaiting-payout-configuration` means the Murakumo chain, token, distributor,
Safe addresses, or payout activation are not configured yet. `claim-root-prepared` means an
off-chain allocation and claim root were prepared; it does not mean a token transfer was confirmed.
These status values link to the public asset record and remain review attestations, not proof of
legal title.

For a legacy CIDv0, `yataverse get` and `yataverse verify` request and verify its raw dag-pb block.
Use `yataverse canonical-cid <cid>` or the `artifactCid` emitted by `asset-manifest` to get the
canonical CIDv1 form. Murakumo also normalizes supported CIDv0 input to that same CIDv1 asset DID.
A lake block inventory is not an asset catalog: an
individual block may be an internal DAG node or shard, not a complete model or dataset. Identify the
artifact root and verify its bytes before submitting a claim.

To backfill an older asset, first identify and verify the exact artifact bytes in Yataverse. Publish a
canonical manifest that points to the artifact CID and rights-evidence CID and names the contributors,
their roles and shares, and the historical training run IDs. Each contributor submits a
`legacyAsset: true` claim to Murakumo for the existing artifact CID. Murakumo then requires operator
review of rights, provenance, Yataverse readback, duplicate claims, contributor DID ownership, and
evidence that the asset was actually used in the retroactive epoch. Shares must add up to exactly
10,000 basis points among the eligible registered-human claimants before that artifact receives an
allocation. If historical training costs are unknown, record them as `unmeasured`; do not invent a
zero or estimate. Historical YATA rewards still require human registration, a funded epoch pool, and
the normal wallet claim flow.

The audited backfill snapshot for 2026-10-16 counted 825,390 rows across historical epoch manifests;
that aggregate includes an epoch-5 P6 drill action and is not a verified unique lake-CID count. The
available epoch 0–3 source inventories now produce an 825,258-record candidate index; each source
hash, row count, and byte total was validated, and the gzip output passed integrity checking. A
narrower 822,510-CID fence-B snapshot is also retained. Both indexes are outside the repository and
have not been uploaded. Each block-CID entry remains `unregistered` and `cid-only-unverified`, with
`not-eligible-unregistered` reward status. Epochs 4–6 add 132 rows (79,818 bytes), but their row CID
lists are absent; six manifest inventory-root DID candidates are recorded separately as
unverified references and are not reward eligible. The inventory does not identify complete asset
roots, contributors, rights, or actual training use.
Three older epoch inventory blocks have locally verified CID/SHA-256 bytes, but remote Yataverse
readback is still unverified and they are inventory metadata, not proven training assets. The nine
model-catalog DID candidates include one SHA-256-derived artifact CID candidate for `ling-3.0-tiny`;
the model file and Yataverse readback are not verified, and the other eight model entries lack artifact
CIDs. A second SHA-256-derived candidate identifies the Qwen Image diffusion weight component, not
the complete multi-file model. Neither candidate is reward eligible. See the
[backfill audit snapshot](docs/legacy-did-backfill-2026-10-16.json) and generated indexes under
`workspaces/codex/yataverse-training-did-index`. No legacy reward claims or transfers were created.

The model DID and weight CID candidate records are now checked in as
[metadata-only indexes](docs/model-catalog-did-follow-up-2026-10-17.md). The bulk lake candidate
indexes remain under `workspaces/codex/yataverse-training-did-index`.

The 2026-10-16 public bytes-plane check also found that the configured
`https://ipfs.yataverse.com` read host had no base-host DNS record, Worker custom
domain, or Worker route in the checked Cloudflare account. The wildcard CID
subdomain DNS record existed, but direct CID-subdomain HTTPS readback failed.
The CLI could not fetch the three inventory roots. A repository Wrangler file
that declares these hosts is configuration evidence only; it does not establish
that the Worker or domain is deployed. The audit snapshot records these limits. An additional read-only Cloudflare configuration snapshot is in the
[2026-10-17 bytes-plane readback](docs/public-bytes-plane-cloudflare-readback-2026-10-17.md).

The MCP tools `yataverse_asset_manifest` and `yataverse_asset_did` perform local validation and
deterministic derivation. They do not upload a manifest or prove an asset claim.

## Authorisation

Writes need an `Authorization` value. In order:

1. **Your minter command** — `YATAVERSE_AUTH_CMD='["/path/to/mint","--aud","..."]'` (or `authCmd` in the
   config). Run as an argv array, **no shell**; stdout is the value. Runs before every write.
2. **A tenant service-account secret** (`kb_sa_...`, issued by a **tenant admin**) with `tenantId`
   (`t_...`) and optionally `storage`: exchanged at `https://auth.kotoba.cloud/v1/biscuit/token` for a
   15-minute Biscuit, cached until 60 s before expiry. The secret is only ever sent to an allow-listed
   Authn host over https.
3. **A static value** (`~/.config/yataverse/auth`, 0600), for a gateway that accepts one.

This tool **mints no credential**. A self-signed CACAO is refused by the plane (probed 2026-09-29),
and Authn issues a Biscuit only to a tenant member — so the secret has to come from a tenant admin.

Config lives in `~/.config/yataverse` (`$YATAVERSE_CONFIG_DIR`): `config.json` (non-secret) and
`sa-token` / `auth` (0600 — a secret file readable by group or other is **refused**).

## Administration: tenants and service-account secrets

Everything up to the secret can be done from the CLI or the MCP server, with **your own** key:

```sh
yataverse admin keygen                  # ~/.config/yataverse/admin.key (0600); prints only the did:key
yataverse admin login                   # signs in to Authn with that key — the FIRST sign-in creates the account
yataverse tenant create "My tenant"     # you become its owner        -> t_...
yataverse sa create --tenant t_... --name web-node --storage blocks
                                        # issues a service account; its one-time kb_sa_ secret is stored
                                        # 0600 as this machine's write credential and NOT printed (--print to see it)
yataverse sa list|rotate|revoke --tenant t_... [--id sa_...]
yataverse member list|add --tenant t_... [--user-id U --role R]
```

### One command, per node (decentralized)

```sh
yataverse bootstrap --yes --tenant-name my-node --sa-name web-node --storage blocks
```

Idempotent: admin key -> sign in -> tenant -> service account -> secret stored 0600. **`--yes` is required
because the first sign-in creates an account.** Run it on each machine that writes, and every node holds its
**own** identity and its **own** secret — no shared secret is copied around, and revoking one node is one
`sa revoke`. (murakumo's `web_node` picks up `~/.config/yataverse` on its own; a bot may run
`yataverse_bootstrap` over MCP only after the operator approves that node.)

Authn decides who may do what: a caller who is not an admin of the tenant is refused by Authn. Two things
this tool cannot do for you: writing bytes also needs the account to hold a **`storage/pin` grant** (the
plane's quota gate — it is granted by the operator, not by a tenant), and a fresh account is not a member of
anyone else's tenant. Signing in creates an account, so `admin login` and every mutating MCP tool
(`yataverse_admin_login`, `yataverse_tenant_create`, `yataverse_sa_create|rotate|revoke`) require `confirm: true`.

## MCP

```sh
claude mcp add yataverse -- node /path/to/yataverse/bin/yataverse.mjs mcp
```

Tools: `yataverse_status`, `yataverse_cid`, `yataverse_cid_normalize`, `yataverse_asset_did`, `yataverse_asset_manifest`, `yataverse_get`, `yataverse_verify`, `yataverse_put`, and the administration set `yataverse_admin_status`, `yataverse_admin_login`, `yataverse_tenant_list`, `yataverse_tenant_create`, `yataverse_sa_list`, `yataverse_sa_create`, `yataverse_sa_rotate`, `yataverse_sa_revoke`. A service-account secret issued through MCP is stored on this machine and is **never returned** in a tool result.
Credentials come from the operator's config and **never pass through a tool argument or result**:
any argument named like a credential is refused. `yataverse_put` requires `confirm: true` (it writes to a
shared plane and cannot be undone). Bytes returned by `yataverse_get` are untrusted data.

## Yataverse app

The Tauri app (Android α) that encrypts files on the device and saves them to yataverse.com lives in [`app/`](app/README.md).

## yataverse.com Worker (Backblaze B2)

`worker/` is the server side of the bytes plane on `yataverse.com` (AWAI-3102). Owner decision
2026-11-17: the plane uses yataverse.com hosts (kotobase is a library name, not a host), Cloudflare
may be used, and blocks are stored in Backblaze B2 through its S3-compatible API. It uses no R2,
KV, D1 or Durable Objects.

| Request | Behaviour |
|---|---|
| `PUT /ipfs/<cid>` | `Authorization: Bearer <write token>`, `Content-Type: application/vnd.ipld.raw`. CIDv1/sha2-256 with codec raw or dag-cbor (canonical DAG-CBOR only), at most `MAX_BLOCK_BYTES`. The body must hash to the CID; it is stored at `B2_PREFIX + cid`, read back from B2 and verified again before `201`. |
| `GET` / `HEAD /ipfs/<cid>` | Served from B2 after verification. On a B2 miss, `READ_FALLBACK_URL` (the self-hosted Reader at `ipfs.yataverse.com`) is tried and its bytes are verified the same way. |
| `GET /ipfs/<cid>?format=car` (or `Accept: application/vnd.ipld.car`) | CARv1 with `order=dfs; dups=n`. `dag-scope=all` (default) follows DAG-CBOR links down to raw leaves; `dag-scope=block` returns the root alone. Every block is verified first; a missing block or an untraversable codec is an error, never a truncated CAR. |
| `POST /ipfs/` | `Authorization: Bearer <write token>`, `Content-Type: application/vnd.ipld.car`, a CARv1 or CARv2 (`.awai`) body. Before anything is stored: canonical DAG-CBOR header, every block passes the write rules, every root is in the CAR, the closure is complete (in the CAR or already stored) and no block is unreachable. Then each block is stored and read back. Limits: `MAX_CAR_BLOCKS` (256), `MAX_CAR_BYTES` (32 MiB). |
| Per-person writes (`POST /ipfs/` only) | **ATProto service auth** (AWAI-3274, owner decision 2026-11-18, `worker/src/service-auth.mjs`): `Authorization: Bearer <JWT>` with header `alg: ES256K`, `aud` = `SERVICE_AUTH_AUD` (`did:web:yataverse.com`), `lxm` = `com.yataverse.importCar`, `iat`/`exp` with a lifetime of at most 300 s. The issuer must be a `did:plc` (resolved at `PLC_DIRECTORY_URL`) or `did:web` whose `#atproto_pds` is in `SERVICE_AUTH_PDS` (`https://pds.aozora.app`) and whose `#atproto` secp256k1 key signed the JWT (low-S; verified with `@noble/curves` 1.9.7). That PDS must also report the repo active (`com.atproto.sync.getRepoStatus`), because anyone can publish a DID document naming it. `SERVICE_AUTH_DENY_DIDS` revokes a person; removing `SERVICE_AUTH_AUD` turns the scheme off (`503`). The request is counted by the rate limiter before any lookup. The receipt's `requester` is the SHA-256 of the DID. Neither the app nor the Worker holds a secret. Residual risks: no `jti` replay store (no KV/D1/DO), so a token can be reused for the same method until it expires; DID documents and repo status are cached for 60 s per isolate. Block `PUT` still needs a write token. |
| CORS on `/ipfs` | Only `IPFS_ALLOWED_ORIGINS` (default `https://tauri.localhost`, the Nagare WebView; AWAI-3274) is answered: preflight allows `POST` on `/ipfs` (headers `authorization`, `content-type`, `yataverse-request-id`) and `GET`/`HEAD` on `/ipfs/<cid>`; other origins and methods get `403 cors-not-allowed`. Responses to the allowed origin, errors included, carry `Access-Control-Allow-Origin`; no credentials mode. A `POST`/`PUT` whose `Origin` header is outside the list is refused with `403 origin-not-allowed` before the body is read. Clients without an `Origin` header (CLI, MCP) are unaffected. Reads stay public: other origins still get the bytes, without CORS headers. The write token, CID checks, readback and rate limits are unchanged. |
| `PUT` / `GET /awai-drive/v1/packs/<sha256>` | The Awai Drive pack protocol, as Drive's `sync.js` speaks it: no credentials, `Content-Type: application/vnd.ipld.car`, JSON receipt `{sha256, bytes}`. No authentication (owner decision 2026-11-18); instead the body must hash to the id, be at most `DRIVE_MAX_PACK_BYTES` (12 MiB) and be a well-formed CARv1/CARv2 whose blocks hash to their CIDs. Packs are stored, read back and verified; downloads are verified. CORS answers only `DRIVE_ALLOWED_ORIGINS` (`http://tauri.localhost`). Anyone can still store opaque packs within these limits. |
| Write limits | **In effect: a WAF rate limiting rule on the `yataverse.com` zone** (AWAI-3242, owner decision 2026-11-18): `(http.request.method in {"PUT" "POST"} and (starts_with(http.request.uri.path, "/ipfs/") or starts_with(http.request.uri.path, "/awai-drive/")))`, counted per client IP, 10 requests / 10 s, action Block for 10 s (Free plan: one rule, 10 s period and duration, request counts only). Blocked writes get Cloudflare's `429` (`error code: 1015`, `Retry-After: 10`) and never reach the Worker. It is approximate per location; a burst can pass a few more before it engages (observed: 16 of 40 parallel writes passed). The Worker also carries per-IP Workers Rate Limiting bindings (`WRITE_REQUEST_LIMITER` 60 / 60 s, `WRITE_MIB_LIMITER` 64 MiB / 60 s, `worker/src/write-limits.mjs`), but on 2026-11-18 they did not refuse any request in this account, even at 3 requests / 10 s; treat them as inactive. Writes still fail closed (`503`) without those bindings. There is no byte budget in effect. |
| Receipts | **Every successful write returns a signed storage receipt** (AWAI-3305; design [docs/storage-receipt-design.md](docs/storage-receipt-design.md)): `receipt` is a `YataverseStorageReceipt` v1 (EIP-712 typed data, Ed25519 over the EIP-712 digest), `receiptCid` its canonical DAG-CBOR record, stored at `ipld/receipts/by-request/<requestId>`. It claims only that this gateway stored and read back the bytes (`state` 1 `local-durable-readback`, `storeClass` 1 `edge-gateway`, `retentionUntil` 0); it is not retention or independent-replica evidence. Optional header `Yataverse-Request-Id: <64 hex>` (default: the content digest). A repeat gets the same receipt; a different write under the same id is `409 request-id-conflict` and is not stored. `requester` is the SHA-256 of the write token, 0 for Drive. Without a signing key that is published and valid now, writes are `503` and nothing is stored. Drive packs get the receipt in the same JSON; Drive does not check it yet. |
| `GET /.well-known/…` | `yataverse-receipt-keys.json` (signing keys: `keyId`, `keyEpoch`, public JWK, `notBefore`/`notAfter`/`revokedAt` in Unix ms), `did.json` (`did:web:yataverse.com`), `yataverse-policy/<revision>.json` and `current.json` (the limits and store a receipt's `policyRevision` names; every revision is also a dag-cbor block at `/ipfs/<cid>`). |
| `GET /health` | Liveness only. |

The Worker never follows a redirect. Write tokens are checked against `WRITE_TOKEN_SHA256`
(comma-separated SHA-256 hex digests), so the Worker holds no token in clear. Verifying the
Authn Biscuit instead is a follow-up: the Authn service does not publish its verification key.

Merging does **not** deploy it. Deploying adds the `yataverse.com` custom domain and needs the
owner's approval and these secrets: `B2_ENDPOINT`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY`,
`WRITE_TOKEN_SHA256`, `RECEIPT_SIGNING_KEY` (`wrangler secret put <NAME>` from `worker/`; the signing key's
public half goes in `RECEIPT_PUBLIC_KEYS` in `wrangler.jsonc`). Deploy with
`wrangler deploy --var SOURCE_COMMIT:<commit>`. After deploying, check
`/health`, then put one block with a test token and read it back with `yataverse get`.

## Test

```sh
npm test        # CLI: CID vectors, redirect policy, Authn exchange/caching, sign-in CACAO verified by a fake Authn, admin flow, config permissions, MCP
                # Worker: write/read/verify against a fake B2, fallback verification, SigV4 vector from the AWS docs
```

Apache-2.0.
