# Copying fallback-only blocks into B2, and removing READ_FALLBACK_URL

AWAI-3833. `yataverse-bytes` serves `GET /ipfs/<cid>` from B2 and, on a B2 miss, from
`READ_FALLBACK_URL` (`https://ipfs.yataverse.com`, the self-hosted Reader on xavier). xavier has
been offline on the tailnet since 2026-11-06 and will not come back before Awai Android OS is ready. A block that only xavier holds has one copy, and nobody can read it now
(`504 read-fallback-unreachable`). The inventory of referenced CIDs is in
[fallback-only-inventory-2026-11-22.md](fallback-only-inventory-2026-11-22.md).

This page is the procedure for when xavier is back. Nothing here has been run against xavier yet.

## 1. Copy (scripts/migrate-fallback.mjs)

Run it where the `ipfs` CLI of xavier's Kubo node works (on xavier, or through
`--ipfs "ssh xavier ipfs"`), with the yataverse CLI configured for writes
(`yataverse login` / a write token, as for any `car-put`).

```sh
# 1. Plan only: export, check against the write rule, pack into CARs. Writes nothing.
node scripts/migrate-fallback.mjs --pins --cids docs/fallback-only-cids-2026-11-22.txt --dry-run \
  --state .agent-output/migrate-fallback/state.jsonl

# 2. Copy. Resumable: rerun the same command after an interruption; done roots are skipped.
node scripts/migrate-fallback.mjs --pins --cids docs/fallback-only-cids-2026-11-22.txt \
  --state .agent-output/migrate-fallback/state.jsonl --work .agent-output/migrate-fallback/cars

# 3. Check every copied block is served from B2.
node scripts/migrate-fallback.mjs --verify --state .agent-output/migrate-fallback/state.jsonl
```

What it does for each root (each recursive pin from `ipfs pin ls --type=recursive`, and each CID
in `--cids`):

1. `ipfs dag export <root>` gives a CAR. Every block is hashed against its CID.
2. A CIDv0 (`Qm…`) block is named by the CIDv1 dag-pb CID with the same multihash (`bafybei…`).
   Writes accept only CIDv1. The Worker reads a CIDv0 from that CIDv1 key
   (`storeKeys` in `worker/src/index.mjs`), so `GET /ipfs/Qm…` keeps working.
3. Every block is checked with the write rule (`src/block.mjs`): raw, canonical DAG-CBOR, or plain
   UnixFS dag-pb with CIDv1 links, at most 16 MiB. If any block of a root fails, the root is not
   copied at all. It is recorded as `unacceptable` with each block's reason. A root that contains a
   CID on the read deny list (`READ_DENY_CIDS` in `worker/wrangler.jsonc`) is recorded as `denied`
   and not copied.
4. The blocks are packed children-first into CARs within the import limits: 32 MiB, 256 blocks,
   at most 23 roots per CAR header. A later CAR links to blocks that an earlier CAR already stored.
   The Worker accepts those as `external`.
5. Each CAR goes through `yataverse car-put`. That command verifies the signed storage receipt and
   exports the roots back. Writes are kept under the WAF rule (10 requests / 10 s) and 60 MiB / 60 s.
6. Each block is read again with `GET /ipfs/<cid>?format=raw`. It must come back byte-identical
   with `Yataverse-Read-Source: store`. While `READ_FALLBACK_URL` is set, a `200` alone does not
   prove there is a copy in B2.

The state file (JSON lines, one per root and attempt, last line wins) records `done` (blocks, CAR
digests, receipt CIDs), `planned`, `denied`, `unacceptable` (with the reasons) or `failed` (retried
on the next run).

### What the current write rule cannot take

- **CIDv0 DAGs with CIDv0 links.** Kubo's default for `ipfs add` without `--cid-version=1` links
  chunks and directory entries by bare multihash (CIDv0). `src/dag-pb.mjs` accepts CIDv1 links only
  (`not-accepted-unixfs:link-not-cidv1-sha2-256`). Rewriting the links would change every CID above
  them, so the script does not do it. A single-block CIDv0 file (up to one 256 KiB chunk, no links)
  is accepted.
  - The three JUN-228 CIDs (`QmNLgJDa…`, `QmNLhRAr…`, `QmNLi4aM…`, about 262 KB each) are larger
    than one default chunk. They are probably such DAGs. The dry run will tell.
- HAMT-sharded directories, symlinks, UnixFS metadata nodes, mode/mtime fields, non-canonical
  dag-pb, and codecs other than raw, dag-cbor and dag-pb (for example dag-json, git, eth).
- Blocks over 16 MiB (`MAX_BLOCK_BYTES`).

Accepting any of these changes the write policy. That is a separate decision. Until then they stay
on xavier only, and the `unacceptable` rows of the state file are the list to decide on.

## 2. Removing READ_FALLBACK_URL (not done here)

Removing the fallback is a separate decision. When it is made:

1. Run the copy until the state file has no `failed` roots, and `--verify` exits 0.
2. Decide on each `unacceptable` and `denied` root. When the fallback is removed, these become
   `404 block-not-found` on yataverse.com (a denied CID stays `451`).
3. Re-run the inventory probe from
   [fallback-only-inventory-2026-11-22.md](fallback-only-inventory-2026-11-22.md). Every CID that
   was `504` should now be `200` with `Yataverse-Read-Source: store`.
4. In `worker/wrangler.jsonc`, delete the `READ_FALLBACK_URL` line and its comment. Merge, then
   deploy from the merged `main` with `npx wrangler deploy --var SOURCE_COMMIT:<commit>` (from `worker/`).
5. Check:
   - `curl -sI https://yataverse.com/ipfs/<a copied CID>` gives `200` and `yataverse-read-source: store`.
   - `curl -s https://yataverse.com/ipfs/<a CID that is not in B2>` gives `404 block-not-found`,
     not `504`.
   - A denied CID still gives `451`.
6. Rollback: put the line back and deploy again. B2 is not changed by either step.

## Limits of the script

- One root is exported into memory at a time, up to 1 GiB (`maxBuffer`). A larger pin fails with
  the export error and stays `failed`. Split it by exporting its children as roots (`--cids`).
- A root whose CID is not sha2-256 (for example a sha2-512 or identity CID) is `unacceptable`
  (`root-not-a-sha2-256-cid`).
- `--pins` covers recursive pins only. Direct and indirect pins and unpinned blocks in xavier's
  blockstore are not copied unless a root that reaches them is listed.
