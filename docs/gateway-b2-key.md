# The gateway's B2 key: what it needs, and how to replace it

Tracking: AWAI-3754 (parent AWAI-3618). Status on 2026-11-21: the permissions the Worker needs are
fixed by tests; the narrow key **exists and was checked against the real bucket** (section 4a);
the Worker's secrets have **not** been changed. Replacing them needs the owner's approval.

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
5. **Afterwards**, as separate decisions: whether to give the lock key the same `ipld/` prefix;
   whether `260913` can be retired or reduced once its other users are known.

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

- **Left in the bucket:** nine entries under `ipld/zz-key-check/` (eight small unlocked uploads
  and one hide marker). The narrow key cannot remove them.
- **Not checked:** CAR import, Drive packs, service-auth writes, status publication and leased
  writes with this key (they use the same three request kinds, which the test suite pins, but
  they were not run against the real bucket); behaviour under load.

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
