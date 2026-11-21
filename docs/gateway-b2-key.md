# The gateway's B2 key: what it needs, and how to replace it

Tracking: AWAI-3754 (parent AWAI-3618). Status on 2026-11-21: the permissions the Worker needs are
fixed by tests; the narrow key has **not** been created and the Worker's secrets have **not** been
changed. Creating the key and replacing the secrets each need the owner's approval.

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

One more permission is needed for a reason that is not an operation: **`listFiles`**. Without it
B2 answers `403` instead of `404` for an object that does not exist (seen on 2026-11-21 with the
lock key, AWAI-3677). The Worker reads `404` as "absent" in several places (first write of a
block, first receipt for a request id, first status for a lease) and treats `403` as a store
failure, so a key without `listFiles` would break those paths.

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
| Permissions | `readFiles`, `writeFiles`, `listFiles` |
| Expiry | none |

Left out on purpose: `deleteFiles` (the gateway never deletes; with it an attacker could hide or
remove unlocked blocks), every retention and legal-hold permission (the lock key has those), and
everything about buckets and keys.

What this key still allows: writing a newer version over any name under `ipld/`. For a block that
is harmless to readers (bytes are checked against the CID) but it can make a block unreadable by
name until the bad version is removed. Narrowing the key does not change that.

Not verified yet, to be checked in §4 step 2 before any production change:

- that B2 answers `404` (not `403`) for a missing object when the key has `listFiles` **and** a
  file name prefix;
- that the S3-compatible API accepts a prefix-limited key for `GET`/`HEAD`/`PUT` by full name.

If either fails with the prefix, create the key without a prefix (bucket-only) and record that.

## 4. Steps

Each numbered step that changes something needs its own approval. Secrets are written to files
with mode 0600 and never printed.

1. **Create the key** (B2 `b2_create_key`: the bucket id, `namePrefix: "ipld/"`, the three
   permissions). Store it at `~/.config/yataverse/gateway-key.json`.
2. **Check it from a workstation against the real bucket**, with the Worker's own code and a
   test prefix inside the key's reach (`B2_PREFIX=ipld/zz-key-check/`):
   - a block write returns a verified receipt and reads back; `HEAD` is 200;
   - reading a block that is not there answers the Worker's miss (the store said `404`);
   - a repeated write with the same request id returns the stored receipt;
   - with the key alone: delete is refused, a write outside `ipld/` is refused, a write with
     lock headers is refused, a write to another bucket is refused, listing keys is refused.
   The check leaves a few small unlocked objects under `ipld/zz-key-check/`; remove them with an
   account-level credential afterwards (separate approval, since it is a deletion).
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
