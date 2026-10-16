# Historical DID backfill: runtime and evidence status (2026-10-17)

This note reconciles the historical candidate inventory with the current Murakumo source schedule and the latest read-only API probe. It records source behavior and evidence status; it does not register assets or authorize rewards.

## Source behavior

The checked Murakumo `main` source contains three distinct five-minute scheduled operations in `src/local_murakumo/worker.cljk`:

- `backfill-model-catalog!` snapshots current model-catalog identities and public fields. It does not enumerate or persist the 825,258 historical lake-CID candidates.
- `auto-distribute-funded-epochs!` may allocate already-funded epochs when the full YATA payout configuration is enabled. Its source gate returns disabled when payout configuration is absent.
- `relay-pending-claims!` handles claim-root relay separately.

The source also derives an asset `did:web` document on demand for a valid CID in `asset-did-document!`. This deterministic resolution is not durable registration of every candidate and is not a bulk backfill of the lake index. A generated DID or model-catalog snapshot proves neither artifact bytes nor ownership, rights, contributor identity, or actual training use.

Source readbacks: [worker.cljk](https://github.com/network-awai/cloud-murakumo-api/blob/main/src/local_murakumo/worker.cljk) (blob `be7ccf128b1218ba02640c0d81cf44928120f188`) and [training_economy_http.cljk](https://github.com/network-awai/cloud-murakumo-api/blob/main/src/local_murakumo/training_economy_http.cljk) (blob `6a476a214beb93ed061d47f84fa877612025c6a0`). Scheduled source is not proof that the Worker, routes, bindings, or cron are live.

## Latest live readback

On 2026-10-17, direct read-only requests for `GET /training/policy`, `GET /training/models`, and one `GET /training/assets/{cid}/did.json` could not resolve `api.murakumo.cloud`. The requests ended at DNS resolution with curl status `000`; no HTTP response was received.

An earlier same-day check had reported HTTP 404. The newer DNS failure does not establish a current 404 or a current 200: live route availability is unresolved. The feature remains present in source, while serving behavior was not verified by this probe.

## Candidate inventory status

- The model catalog has nine deterministic model-record DID candidates. Eight entries have no artifact CID. Two weight-derived CID/DID candidates encode registry-declared hashes but have no model-file byte readback.
- Six tracked inventory-root DID candidates reference inventory metadata for epochs 0–4 and 6. Their remote bytes and contained blocks are unverified.
- The separate local epoch 0–3 index has 825,258 unique CID candidates and 91,395,006,284 inventory-declared bytes. Its compressed candidate file (SHA-256 `8521869965fad9e49de2e1afd19cf822b33ea5adab0283db2be85700dfcc3f56`) remains outside this repository and was not uploaded. These rows may include internal DAG blocks or shards and are not a complete asset catalog.
- Epoch 4 (24 rows) and epoch 6 (107 rows) source row inventories were absent from the inspected workspace. Epoch 5 is excluded because it is a P6 drill action, not a lake listing.

These counts and limits are also recorded in the [legacy audit snapshot](legacy-did-backfill-2026-10-16.json), [model-catalog follow-up](model-catalog-did-follow-up-2026-10-17.md), and [README historical audit](../README.md#historical-model-and-data-migration-audit-2026-10-17).

## Retroactive contribution and reward gate

No verified rights-evidence CID, complete contributor-DID/share set, or actual-use run manifest was found for the historical candidates. They remain unregistered and not reward eligible.

A historical claim requires an exact verified artifact root; a published and read-back asset manifest; rights evidence; wallet-bound, registered human contributors whose reviewed shares total exactly 10,000 basis points; and a read-back run manifest linking the asset and model to the completed epoch. Each contributor submits a separate `legacyAsset: true` claim. Murakumo must review identity/share linkage, rights, deduplication, and actual use before accepting the complete claim set. Historical allocation remains conditional on an explicitly funded YATA epoch. A source-scheduled allocator does not supply missing evidence, fund a pool, or prove a payment.

## Change boundary

This audit adds only a repository record. It did not upload or register candidate data, publish asset manifests, create claims, fund or transfer tokens, deploy a Worker, or run tests. The latest probe's DNS failure leaves production route status unresolved.
