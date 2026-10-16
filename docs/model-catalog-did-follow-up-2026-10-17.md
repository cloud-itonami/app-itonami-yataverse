# Model catalog DID and YATA source follow-up

This is a source and evidence audit, not an asset registration or reward claim. It follows the
[2026-10-16 backfill snapshot](legacy-did-backfill-2026-10-16.json) and keeps catalog-record identity,
artifact-byte identity, ownership evidence, and payout eligibility separate.

## Registry readback

The current `network-awai/cloud-murakumo-api` `main` was
`7b4965d43ae3539713c4821fa9bf4209fa84696e` when checked. Its
`src/local_murakumo/model_registry.cljk` has SHA-256
`a7d83d7f953b2dd3144233aea94b2d141374c14bb3b8a8a640627fc3ba9bd6e2`, matching the registry hash in
the candidate-index manifest. The registry contains the same nine model IDs as the checked-in catalog
index. The output hashes are `d7dcc522cf7351af0d52add607d1748d760451c6661fc94ef14e347e0b16ef4f` for the
[catalog DID candidates](model-catalog-did-candidates-2026-10-16.jsonl) and
`ec733649200299cef8e8f4a728687bb54e61adba4225abad35b554a347866549` for the
[weight CID candidates](model-weight-cid-candidates-2026-10-16.jsonl).

The catalog DID is derived as
`did:web:api.murakumo.cloud:training:models:<sha256("murakumo.training.model/v1:" + modelId)>`.
It names a model-catalog record. It does not identify or verify the model weights.

For `ling-3.0-tiny`, the registry declares `Ling-3.0-tiny-Q4_K_M.gguf` with SHA-256
`246d67d45f5b0c7447ca0ce0bdb8b46b8a47b593c5068635dc16422c051d7be9`. Encoding that declared digest
as a raw CIDv1 produces the candidate
`bafkreibenvt5ix23br2epsqm4c63rndlrjd3le6fa2ddlxawiiwakhl35e`. The model-catalog DID candidate is
`did:web:api.murakumo.cloud:training:models:722edc260664d1ae0a32e6f809c59e704eb17c148ee1d502a5414a458d51494b`;
the separate artifact DID candidate is
`did:web:api.murakumo.cloud:training:assets:bafkreibenvt5ix23br2epsqm4c63rndlrjd3le6fa2ddlxawiiwakhl35e`.
This establishes that the candidate CID is a deterministic encoding of the registry's digest. It does
not establish that the file exists, that its bytes hash to the digest, or that the artifact was
published to Yataverse.

The second weight-derived candidate is for the `qwen-image-2.1-uncensored` diffusion component only;
it does not identify the full multi-file model. The other eight catalog entries have no declared
`artifactCid`. A model catalog DID therefore remains useful for indexing all nine records, while an
artifact DID can be attached only to a specific declared or independently verified CID.

## Bytes, manifest, and eligibility

The exact Ling and Qwen model files were not found in the checked API/Yataverse repository trees or
the candidate-index workspace. The public read tool could not retrieve the Ling CID, its asset record,
or its DID document on 2026-10-17, so it returned no HTTP status or verified bytes. The previous
2026-10-16 audit recorded the training DID routes as unavailable and the configured Yataverse bytes
read path as unavailable. Current production readback remains unresolved.

No asset manifest CID, rights-evidence CID, contributor claims, or actual training-run evidence is
present for the Ling candidate. Yataverse's manifest command can canonicalize a supplied manifest and
the separate `put` command can publish and read it back; neither operation can manufacture rights or
contributor proof. Murakumo's source marks a declared registry hash as
`registry-declared-sha256-no-file-readback`; without artifact and manifest readback plus reviewed
rights, contributor-DID linkage, complete shares, and actual-use evidence, the candidate remains
`not-eligible`. The API records operator review attestations; it does not inspect model inputs or
independently prove actual training use. No reward claim was created.

## Source path from a reviewed asset to a wallet claim

The API source at the checked `main` revision already provides deterministic catalog snapshots and
separate asset DID resolution. Its five-minute Worker cron calls catalog backfill, funded-epoch
allocation, and pending-claim relay. Catalog backfill snapshots model identity and public registry
fields only; it does not create contribution claims. The allocation job processes only already-funded
epochs and runs only when payout configuration is enabled.

The contribution path requires a registered-human session and a Yataverse CID. Registration binds a
wallet signature to the World ID proof's signal; the source also requires an eligible Human Passport
aggregate score. Model and legacy claims require a manifest. An operator must review artifact and
manifest readbacks, rights, contributor-DID linkage, deduplication, and actual epoch use before
accepting the claims. The claim endpoint verifies the published on-chain root before returning a
proof to the registered human. A keeper can relay `claimRegistered` proofs, or the registered wallet
can settle its own claim; the contract binds the payout to the wallet commitment in the claim leaf.

## Cost and YATA pool relationship

Training costs are recorded separately as integer USD micros for compute, storage, egress, data
preparation, and evaluation. Metered accelerator costs are checked from accelerator-seconds and an
operator-supplied USD-micros-per-hour rate; invoice-based costs remain operator attestations. The API
does not fetch or verify the receipt contents. Unknown historical costs are recorded as `unmeasured`,
not zero.

Those USD figures do not convert into YATA. The epoch pool is an explicit raw-unit YATA amount
transferred from the configured treasury Safe to the distributor and verified from the configured
token's transfer receipt. Allocation prorates that prefunded pool by reviewed
`uniqueTokens × qualityBps × usageBps × contributorShareBps`, using integer arithmetic and flooring.
The code defines no YATA/USD price, redemption promise, liquidity assumption, or cost-to-token formula.
Therefore the maximum payout is the funded pool, independent of the USD cost record.

This review inspected source and metadata only. It ran no tests, performed no deployment or transfer,
and read no secret values. Production bindings and payout activation were not rechecked here; source
presence does not establish that the DID, registration, cron, or claim routes are live.
