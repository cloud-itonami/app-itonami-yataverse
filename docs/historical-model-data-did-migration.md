# Historical model and data DID migration

Status: source-only migration tooling and review procedure. No historical asset was registered or marked reward eligible by this document.

Checked source heads on 2026-10-17:
- API: `network-awai/cloud-murakumo-api` main `687be1faaf9179095bebece09da487a89a4ad697`.
- Yataverse: `kotoba-lang/yataverse` main `87c3819648ad8e79b05421eb223f6fd1f135c8a2`.

## Inventory audit

The tracked indexes contain 9 model catalog DID candidates, 2 weight-hash CID/DID candidates, and 6 inventory-root DID candidates. These are deterministic identifiers only. The 9 catalog DIDs refer to model catalog records; 8 records have no artifact CID. The 2 weight-derived CIDs encode declared registry hashes only and have no byte readback. The 6 inventory roots reference epochs 0–4 and 6; none is verified against Yataverse bytes, and a root is not a listing of its contained asset blocks.

The legacy audit records 825,258 unique CID rows in the source inventories it could verify (epochs 0–3), with 91,395,006,284 declared bytes. A generated 825,258-record candidate index is outside this repository and has not been uploaded. It is not a claim registry. The epoch 4 and epoch 6 inventory files are absent from the inspected workspace; epoch 5 is a one-row P6 drill action and is excluded. Therefore the source evidence does not enumerate the complete historical lake.

No historical candidate currently has a reviewed rights-evidence CID, complete contributor identity/share claims, or a read-back training-run manifest that binds the asset to a model and completed epoch. None is reward eligible. The current API auto-allocation source applies these additional gates: accepted contributions, CID/right/deduplication/actual-use reviews, registered eligible humans with wallet control, a complete 10,000-bps share set for each asset, and an explicitly funded epoch. A keeper/contract payout additionally requires verified deployment identities, authorization, prefunding, and keeper operation.

## Migration procedure

1. Recover the complete inventory source for each historical epoch and retain its original file hash, row count, and declared bytes. Exclude training drills or operational actions that are not asset listings.
2. Derive asset DIDs using `yataverse asset-did-index`. Write an index summary that binds the exact input hash to the canonical output index hash. Treat each row as an unregistered CID candidate. A CID that names an internal DAG block or shard is not automatically an asset root.
3. For each actual model, dataset, checkpoint, or adapter root, retrieve the bytes from Yataverse and verify the root CID. Do not substitute a registry hash or inventory root.
4. Prepare an asset manifest with the exact root, supported license, rights-evidence CID, contributor DIDs and roles, and an agreed share total of exactly 10,000 basis points across all claims. Publish the manifest only after removing private data. Its claim status remains `unverified`.
5. Prepare a training-run manifest with the run/epoch IDs, UTC execution window, input asset CIDs, model CIDs, output CIDs, code and sanitized config CIDs, receipt CIDs, and operator DID. Read its bytes back from Yataverse and verify that the target CID is included in the run and that the run matches the completed Murakumo epoch. Its claim status remains `unverified`.
6. Each contributor must submit their own legacy claim from their own registered, wallet-bound, eligible human account. A model or legacy claim references the asset manifest and the relevant run-manifest CID; no operator may infer or assign an absent contributor.
7. An authorized Murakumo reviewer verifies and records bytes/readbacks, rights, claimant-to-DID linkage, complete shares, deduplication, and actual run use before accepting claims. Claims with missing/conflicting evidence remain pending or rejected and are excluded from distribution.
8. The existing funded-epoch allocator can then automatically divide only the funded pool among accepted, eligible contributors. Root publication and keeper relay remain gated by the separately verified YATA deployment identity, treasury funding, owner-approved publisher, recipient registration, and keeper configuration.

Generating an asset DID, publishing a manifest, or attaching an old model name does not create a claim or reward entitlement. No retroactive allocation, pool, or transfer is created by this procedure.
