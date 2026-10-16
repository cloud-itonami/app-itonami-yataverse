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

## Read-only node hash attempt (2026-10-17)

The later API main readback was `aadd17fc18136b3c64058e8ecd20f97d4c059709` (PR #330). Its model
registry still declares the same Ling SHA-256 and candidate CID recorded above. The current
[provider catalog](https://github.com/network-awai/cloud-murakumo-api/blob/aadd17fc18136b3c64058e8ecd20f97d4c059709/src/local_murakumo/provider_catalog.cljk)
has a 2026-09-13 note of `4,823,894,940` bytes with the `246d67d4…` hash prefix. The
[edge-ring reference](https://github.com/network-awai/cloud-murakumo-api/blob/aadd17fc18136b3c64058e8ecd20f97d4c059709/hermes/profiles/murakumo-tier-routing/skills/murakumo-edge-ring/references/murakumo-tiers.md)
lists `/root/models/Ling-3.0-tiny-Q4_K_M.gguf` and a historical size of `4,823,894,944` bytes,
four bytes larger. These are source records, not a current file readback; the size discrepancy is
unresolved.

Read-only SSH was attempted with only `stat` and `sha256sum` for that path. `root@aiueos-node-260910-usagi`
failed before connection because the hostname did not resolve. The source's SSH alias
`root@aiueos-node-260910` then failed because the local Tailscaled process was unavailable, and SSH
closed before running the remote command. A local `tailscale status` query reported the same missing
daemon. No remote size or digest was obtained, and no host setting or file was changed.

The Qwen Image candidate was not probed: its registry entry supplies a component filename and hash,
plus fleet labels, but no concrete filesystem path on a named node. No path was inferred. The checked-in
weight candidate index therefore remains unchanged and marked
`registry-declared-sha256-no-byte-readback`; no byte-derived CID was verified. Yataverse public
readback, rights, consent, contributor shares, and actual training use also remain unverified, so
neither weight candidate is reward eligible.

## Live YATA configuration readback (2026-10-17)

The current source heads checked for this follow-up are
`network-awai/cloud-murakumo-api` main
`aadd17fc18136b3c64058e8ecd20f97d4c059709` and this repository's main
`b27d2abe24df9b5bb860a2d081d77b9441f6fa28`.

A read-only Cloudflare settings/deployment readback of the production
`local-murakumo` Worker returned 65 bindings. Its latest deployment is
100% on version `68734dad-51cb-40d8-bda9-5a4048385581`, created
2026-10-13. No binding names were present for `TRAINING_*`, `WORLD_ID`,
`HUMAN_PASSPORT`, `YATA_*`, or the training challenge rate limiters.
Secret values were not read. This confirms the training registration and YATA
payout configuration is absent from the current production Worker.

The checked `wrangler.toml` documents the YATA settings only as commented
placeholders. Its `PAY_CHAIN` and `TREASURY_ADDR` variables belong to the
separate `/itonami/pay` USDC payment route; they are not YATA chain or treasury
configuration and must not be substituted. The checked API main and current Worker configuration expose no configured
value for the YATA token contract, CAIP-2 chain, distributor address, treasury
Safe, or distributor-owner Safe. An independent on-chain deployment, if any,
remains unverified; no chain lookup was made. No address is inferred from a
token symbol or unrelated payment setting.

| Workstream | Source and documentation | Production or evidence status |
|---|---|---|
| Contributor attribution, consent, rights, and actual use | Contribution records require a supported license, versioned consent, rights declaration, contributor DID/share, and operator review of readback, rights, deduplication, and actual training use. | The legacy index is not uploaded; its records are unregistered and CID-only/unverified. No verified rights, consent, contributor shares, or actual-use evidence is present. |
| World ID and Human Passport | Source implements wallet-bound World ID uniqueness verification and a fail-closed Passport score threshold. | Required training bindings and rate limiters are absent from production; live registration is unavailable. |
| Wallet registration and claims | Source supports wallet-bound registration, prefunded epoch claims, and one-time on-chain recipient registration. | YATA chain/token/distributor/Safe configuration is absent. No production claim or recipient-registration evidence is recorded. |
| Epoch costs and YATA pool | Source records measured training costs as USD micros with receipts/meter attestations; allocation uses an explicit prefunded YATA pool. USD costs do not define a YATA price or conversion formula. | No live funded YATA epoch or funding receipt was observed. Historical costs without receipts remain `unmeasured`, not zero. |
| Existing model and data DIDs | Source derives model-catalog DIDs and separate artifact DIDs; a DID does not verify bytes or rights. | The nine catalog candidates include eight with no artifact CID. Two weight-derived candidates have no byte readback; legacy inventory roots are not remotely verified. |
| Retroactive reward eligibility | Source requires verified asset/manifest, rights, complete contributor shares, eligible humans, and actual epoch use before allocation. | Legacy audit records zero legacy claims and zero YATA transfers; candidates remain ineligible. |
| Automatic payouts | Source supports allocations and claim-root/keeper relays after required configuration, Safe authorization, prefunding, and wallet registration. | No training bindings, distributor deployment, prefunded pool, keeper, or confirmed transfer was read back in production. Automatic payouts are not active. |

This refresh is evidence documentation only. It did not read secret values,
create claims, start a keeper, deploy a Worker or contract, or perform an
on-chain transaction. No tests were added or run.
