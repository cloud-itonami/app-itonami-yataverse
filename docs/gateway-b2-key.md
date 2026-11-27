# The gateway's B2 key: what it needs, and how to replace it

Tracking: AWAI-3754 (parent AWAI-3618). Status on 2026-11-21: the permissions the Worker needs are
fixed by tests; the narrow key exists and was checked against the real bucket (section 4a), and
**the Worker has used it since 2026-11-21T14:56Z** (section 4b).

## 1. State on 2026-11-21 (read-only checks)

- The Worker `yataverse-bytes` (Cloudflare account `cloud-kotoba`) has the secrets `B2_KEY_ID`,
  `B2_APP_KEY`, `B2_BUCKET`, `B2_ENDPOINT`. Their values cannot be read back, so **which key the
  Worker uses is unknown**.
- The B2 account has ten application keys. Three can reach the bucket `yataverse-blocks`:

  | Key name | Scope | Permissions |
  |---|---|---|
  | `260913` | every bucket, no prefix | 29, among them `deleteFiles`, `deleteBuckets`, `writeBuckets`, `writeKeys`, `deleteKeys`, `bypassGovernance`, `writeFileRetentions`, `writeFileLegalHolds` |
  | `yataverse-retention-lock` | this bucket | `readFiles`, `writeFiles`, `readFileRetentions`, `writeFileRetentions` |
  | `yataverse-retention-verifier-ro` | this bucket | `readFiles`, `readFileRetentions` |

  The other seven are limited to other buckets. By elimination the Worker's ordinary key is
  `260913` (or a key that has since been deleted, in which case writes would fail; they do not).
- What a holder of `260913` could do that the gateway never does: delete or overwrite any file in
  any bucket of the account, delete buckets, create further keys, and change bucket settings. It
  cannot remove a compliance lock (nobody can), but every unlocked block is exposed.
- Who else uses `260913` is unknown. This document does not propose deleting it.

## 2. What the Worker does with the key

The store layer (`b2()` in `worker/src/index.mjs`) signs every request itself. With the ordinary
key it sends exactly three kinds of request, all to `/<bucket>/<B2_PREFIX><name>`:

| Request | Used for | B2 permission |
|---|---|---|
| `GET` object | blocks, Drive packs, receipt records, retention status records | `readFiles` |
| `HEAD` object | does a block exist | `readFiles` |
| `PUT` object | the same four kinds of object | `writeFiles` |

It never deletes, lists, copies, names a version, sets a retention or touches bucket settings.
Locking writes and reads by version use the separate lock key (`B2_LOCK_KEY_ID`).

One more permission is needed for a reason that is not an operation: **`listBuckets`**. Without
it B2 answers `403 AccessDenied` ("Cannot access bucket") instead of `404` for an object that does
not exist. The Worker reads `404` as "absent" in several places (first write of a block, first
receipt for a request id, first status for a lease) and treats `403` as a store failure, so a key
without it fails every first write (`502 receipt-read-failed-403`, seen on 2026-11-21).
`listFiles` does **not** help and is not needed (section 4a); an earlier version of this document
guessed that it was.

These limits are checked by the test suite: every store request a Worker test makes with the
ordinary key passes through `assertGatewayKeyIsEnough` (`test/worker-fixtures.mjs`), and
`test/gateway-key.test.mjs` checks the store layer's source. A new operation that needs more
fails the suite; change this document and the key together with it.

## 3. The narrow key

| | Value |
|---|---|
| Name | `yataverse-gateway` |
| Bucket | `yataverse-blocks` only |
| File name prefix | `ipld/` (the Worker's `B2_PREFIX`) |
| Permissions | `readFiles`, `writeFiles`, `listBuckets` |
| Expiry | none |

Left out on purpose: `deleteFiles` (the gateway never deletes), `listFiles` (the gateway never
lists; without it the key cannot enumerate the stored names), every retention and legal-hold
permission (the lock key has those), and everything else about buckets and keys. With
`listBuckets` a bucket-limited key sees only its own bucket.

What this key still allows, because `writeFiles` covers both: writing a newer version over any
name under `ipld/`, and **hiding** a name (an S3 `DELETE` without a version id adds a hide marker;
checked in section 4a). Neither removes stored bytes: the earlier versions stay, a locked version
stays locked, and deleting a version by id is refused. But a block can be made unreadable by name
until someone with an account-level credential removes the marker or the bad version. B2 has no
permission that allows uploads without allowing this. For a block a wrong newer version is
harmless to readers (bytes are checked against the CID).

## 4. Steps

Each numbered step that changes something needs its own approval. Secrets are written to files
with mode 0600 and never printed.

1. **Create the key** (B2 `b2_create_key`: the bucket id, `namePrefix: "ipld/"`, the three
   permissions). Store it at `~/.config/yataverse/gateway-key.json`. *Done, section 4a.*
2. **Check it from a workstation against the real bucket**, with the Worker's own code and a
   test prefix inside the key's reach (`B2_PREFIX=ipld/zz-key-check/`):
   - a block write returns a verified receipt and reads back; `HEAD` is 200;
   - reading a block that is not there answers the Worker's miss (the store said `404`);
   - a repeated write with the same request id returns the stored receipt;
   - with the key alone: a write or read outside `ipld/`, a write with lock headers, a read in
     another bucket, listing, deleting a version, and listing or creating keys are all refused.
   *Done, section 4a.* The check left small unlocked objects under `ipld/zz-key-check/`; remove
   them with an account-level credential (separate approval, since it is a deletion).
3. **Replace the Worker's secrets.** Both values must change together: with one new and one old
   the Worker cannot sign, and every read and write fails until the second lands. Use one upload:

   ```bash
   CLOUDFLARE_ACCOUNT_ID=<cloud-kotoba id> npx wrangler secret bulk <file with B2_KEY_ID and B2_APP_KEY>
   ```

   That it is applied as a single new version was not verified here; confirm from the output
   (one version id) and from the next step.
4. **Check production right after:** `/health` 200; `GET` of a known stored block 200; a raw block
   write returns a verified receipt and reads back; `GET /.well-known/yataverse-receipt-keys.json` 200.
5. **Afterwards**, as separate decisions: the lock key's prefix (*done, section 4c*); whether
   `260913` can be retired or reduced once its other users are known.

## 4a. Steps 1 and 2 as carried out, 2026-11-21

Owner approval 2026-11-21 for creating the key and checking it from a workstation.

- **Key.** `yataverse-gateway` (id ending `00003a`): bucket `yataverse-blocks`, prefix `ipld/`,
  `readFiles` `writeFiles` `listBuckets`, no expiry. The secret is in
  `~/.config/yataverse/gateway-key.json` (mode 0600) on the workstation used.
- **How the permissions were found.** Four keys were created and probed with the same requests
  (write, read, read of a missing name, list); the three that were not kept were deleted.

  | Prefix | Permissions | Missing object | List |
  |---|---|---|---|
  | `ipld/` | read, write, `listFiles` | 403 | 200 |
  | none | read, write, `listFiles` | 403 | 200 |
  | `ipld/` | read, write, `listFiles`, `listBuckets` | 404 | 200 |
  | `ipld/` | read, write, `listBuckets` (kept) | 404 | 403 |

- **The Worker's code against the real bucket** (handler from `main` at `e79ecd2`, run locally,
  `B2_PREFIX=ipld/zz-key-check/`, throwaway signing key and token):
  - a block write: `201`, the receipt verifies (storeClass 1); store calls were GET receipt 404,
    PUT block 200, GET block 200, HEAD policy block 404, PUT policy block 200, PUT receipt 200;
  - `GET` 200 with the same bytes, `HEAD` 200;
  - a block that is not there: `404 block-not-found` (the store said 404);
  - the same request id again: `201` with the same receipt.
- **With the key alone:**

  | Attempt | Answer |
  |---|---|
  | write outside `ipld/` | 403 |
  | read outside `ipld/` | 403 |
  | write with a compliance lock | 403 |
  | read in another bucket of the account | 403 |
  | list the bucket, list under `ipld/zz-key-check/` | 403, 403 |
  | delete a stored version by id | 403 |
  | `DELETE` by name (no version id) | **204**: a hide marker was added; the name then answered 404, the version stayed and was still readable by id |
  | B2 native: list keys, create a key | 401, 401 |

- **Left in the bucket, then removed:** nine entries under `ipld/zz-key-check/` (eight small
  unlocked uploads and one hide marker; the narrow key cannot remove them). They were deleted by
  version with an account-level credential on 2026-11-21 (owner approval); the prefix is empty.
- **Not checked:** CAR import, Drive packs, service-auth writes, status publication and leased
  writes with this key (they use the same three request kinds, which the test suite pins, but
  they were not run against the real bucket); behaviour under load.

## 4b. Steps 3 and 4 as carried out, 2026-11-21

Owner approval 2026-11-21 for replacing the Worker's secrets.

- **Before.** `/health` 200. A block production serves (13,334 bytes) was read with the new key
  at `yataverse-blocks/ipld/<cid>`: same bytes, hashing to the CID. This confirms the bucket and
  prefix behind the unreadable `B2_BUCKET` secret. Deployed version
  `a9f8bdfd-32f1-470d-b595-b825e104b9dc` (created 14:44:00Z, policy source `4ff2563e`).
- **Change.** `wrangler secret bulk` (wrangler 4.103.0, account `cloud-kotoba`) with `B2_KEY_ID`
  and `B2_APP_KEY`, between 14:56:02Z and 14:56:08Z. It produced **one** deployment, source
  "Secret Change", version `f7f932f1-b8f3-471b-993f-8ab69dbda66b` (14:56:08Z). The code is
  unchanged. The temporary file holding the two values was removed.
- **After.**

  | Request | Answer |
  |---|---|
  | `GET /health` | 200 |
  | `GET /ipfs/<the block read before>` | 200, 13,334 bytes |
  | `yataverse put` of a new 69-byte block | stored, receipt verified |
  | `GET /ipfs/<that block>` | 200, same bytes, no cache status header |
  | `GET /ipfs/<another stored block, not read earlier>` | 200, 552,409 bytes |
  | `GET /.well-known/yataverse-receipt-keys.json` | 200 |
  | `GET /ipfs/<a CID that is not stored>` | 504 `read-fallback-unreachable` after 15.6 s, as before the change (the store answered "absent"; the fallback reader does not answer) |

- **Not checked in production:** CAR import, Drive packs, service-auth and CACAO writes, status
  publication, name-plane reads of a multi-block file.
- **Going back** (section 5): the previous version is `a9f8bdfd-…`. Whether `wrangler rollback`
  to it restores the previous secret values was not tried.
- **Still open:** the old key `260913` is untouched and still valid. Whether the Worker was
  using it cannot be shown from here (the old secret value was never readable); if it was,
  that key is no longer needed by the gateway, and reducing or retiring it is the owner's call
  once its other users are known.

## 4c. The lock key limited to `ipld/`, 2026-11-21T15:03Z to 15:05Z

Owner instruction: give the lock key the same prefix. Tracking: AWAI-3760. B2 keys cannot be
edited, so the key was created again and the old one deleted. The Worker had no lock key
(`B2_LOCK_KEY_ID` is not among its secrets), so nothing in production changed.

- **Key.** `yataverse-retention-lock` (id ending `00003c`): bucket `yataverse-blocks`, prefix
  `ipld/`, `readFiles` `writeFiles` `readFileRetentions` `writeFileRetentions`, no expiry. It
  replaces the key ending `000036` (same permissions, no prefix), which was deleted. The secret
  is in `~/.config/yataverse/archive-lock-key.json` (mode 0600) on the workstation used.
  It has no `listBuckets`: the Worker only uses it for a locking write and for reads of the
  version that write returned, never to find out whether something exists.
- **A leased write with both narrow keys** (handler from `main`, run locally,
  `B2_PREFIX=ipld/zz-lock-check/`, throwaway signing keys, a five-minute lease): `201`, lock
  `COMPLIANCE` until the lease end, a storeClass 3 receipt that verifies and counts for the lease
  as operator archive. Store calls: GET archive receipt 404 (gateway key), PUT block with lock
  200, HEAD and GET of that version 200 (lock key), HEAD policy block 404, PUT policy block 200,
  PUT archive receipt 200 (gateway key). This is the first run of that path with no call kept in
  memory.
- **With the lock key alone:** a locked write outside `ipld/`, a plain write outside `ipld/`, a
  read outside `ipld/`, a read in another bucket, listing under `ipld/`, and deleting the locked
  version were each answered `403`.
- **Left in the bucket, then removed:** three objects under `ipld/zz-lock-check/` (the block,
  locked until 2026-11-21T15:08:45Z; a policy block; an archive receipt record). A first attempt
  at 15:06:41Z stopped because the lock was still running; they were deleted by version at
  15:09:22Z (owner approval) and the prefix is empty.
- **Follow-on.** With the prefix, the lock key cannot write under `retention-test/`, where the
  earlier lock experiments ran; later checks use a name under `ipld/`.

## 4d. The verifier's read-only key limited to `ipld/`, 2026-11-21T15:15Z

Owner instruction: give the verifier's read-only key the same prefix. Tracking: AWAI-3769. The
key was created again and the old one deleted. No verifier is installed anywhere, so nothing
that runs changed.

- **Key.** `yataverse-retention-verifier-ro` (id ending `00003d`): bucket `yataverse-blocks`,
  prefix `ipld/`, `readFiles` `readFileRetentions` `listBuckets`, no expiry. It replaces the key
  ending `000035` (`readFiles` `readFileRetentions`, no prefix), which was deleted. The secret is
  in `~/.config/yataverse/archive-verifier-key.json` (mode 0600) on the workstation used.
- **Why `listBuckets` was added.** The probe (`src/archive-probe.mjs`) reports a `404` as "the
  object is absent" and throws on anything else. With the old key a missing copy gave `403`, so
  the verifier failed instead of judging. With the new key it judges.
- **Checked against the real bucket** (`ipld/zz-verifier-check/`; a leased write through the
  Worker handler with the gateway key and the lock key, then the verifier with this key):
  - `head` of the locked version: the size, `COMPLIANCE`, and the same lock end the write returned;
  - `runVerifierOnce` with a full read: `policy-satisfied`, and its status record verifies;
  - `head` of a block that is not stored: absent (`null`);
  - the verifier pointed at a place where the copy is not: `degraded`, reason `object-missing`.
- **With the key alone:** a write under `ipld/`, hiding the test block (`DELETE` by name),
  deleting the locked version, a read outside `ipld/`, a read in another bucket, and listing under
  `ipld/` were each answered `403`; the test block was still readable afterwards.
- **Left in the bucket, then removed:** three objects under `ipld/zz-verifier-check/` (the
  block, locked until 2026-11-21T15:19:12Z; a policy block; an archive receipt record). They were
  deleted by version at 15:42:45Z (owner approval) and the prefix is empty. No test object from
  the key work remains in the bucket; the two locked files under `retention-test/` from the
  earlier lock experiments (locks until 2026-11-22T06:21:50Z and 06:32:25Z) are still there.
  Update 2026-11-27T04:15:32Z (Decision approval, item 48): after pre-checking the listing
  (2 uploads, 50 and 51 bytes, expired `retainUntil`, no legal hold, no hide markers), both
  versions were deleted by version id without `bypassGovernance`
  (`4_z3d597f561c90ebaaa1120518_f103dc9f7960d4534_d20261121_m052051_c004_v0402026_t0017_u01795238451725`
  and `4_z3d597f561c90ebaaa1120518_f102310e508092aad_d20261121_m053226_c004_v0402031_t0034_u01795239146411`),
  and `b2_list_file_versions` confirmed `retention-test/` is empty (0 entries) at
  2026-11-27T04:15:32Z.
- **State of the keys.** All three Yataverse keys are now limited to `yataverse-blocks` and
  `ipld/`:

  | Key | Permissions | Held by |
  |---|---|---|
  | `yataverse-gateway` | `readFiles` `writeFiles` `listBuckets` | the Worker |
  | `yataverse-retention-lock` | `readFiles` `writeFiles` `readFileRetentions` `writeFileRetentions` | nobody yet (workstation file) |
  | `yataverse-retention-verifier-ro` | `readFiles` `readFileRetentions` `listBuckets` | nobody yet (workstation file) |

## 5. Going back

The old secret value cannot be read from the Worker. Before step 3, make sure the old key's
secret is at hand (the owner has it, or not). If it is not, going back means creating another
key with the old key's reach, which is exactly what this change removes; in that case the
practical way back is forward: fix the narrow key's permissions (B2 keys cannot be edited, so
create a corrected one) and upload it the same way.

`wrangler rollback` to the previous version restores the previous secret values together with
the code of that version; whether that holds for secrets changed with `secret bulk` was not
verified here.

## 6. What this does not cover

- The fallback reader (`READ_FALLBACK_URL`) and any other service that reads or writes the
  bucket with its own credentials.
- The lock key and the verifier's read-only key (created earlier under AWAI-3618).
- Rotation on a schedule. This is a one-time narrowing.
