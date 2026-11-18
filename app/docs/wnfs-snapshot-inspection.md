# AWAI-3390 Itonami Yataverse WNFS candidate

The Android dapp build uses the signed-pack verifier and the exact Drive WNFS
and Kotoba Datalog browser core recorded in `app/drive-sdk-pin.json`. Build
verification checks the source commit's pinned file digests. Set
`AWAI_DRIVE_WNFS=1` to enable the bounded WNFS writer for this candidate.
Existing owner-store snapshots can still be read.

`inspectAuthorizedSnapshot` accepts explicitly provisioned custody and a
trusted forest basis from the local host, performs one freshly approved
broker GET, verifies the encrypted CAR, restores files in memory and
runs an extension query against the same basis. It never installs the
supplied custody into the app vault. The published candidate has no owner
invitation or key-transfer UI.

## Device evidence

In a fresh install on dedicated Android 35 ARM64 emulator AWAI3390, the dapp
started with zero local files. An isolated harness passed the synthetic
Drive owner session in memory only for this case. It first denied the GET
and captured zero requests. On a separate invocation an allowed GET returned
283,922 ciphertext bytes and the exact same forest CID and all three file
SHA-256 digests as Drive. The `.txt` query returned two matching paths and
sizes. No dapp cache or native file was published during this read-only test.

| Stage | Android dapp, ms |
|---|---:|
| GET and digest verification, including fresh consent | 1,787.4 |
| Reopen WNFS and restore file bytes in memory | 935.9 |
| Build Kotoba Datalog projection | 0.6 |
| Query | 3.2 |

One cross-app trial. Device tests used the Android debug candidates with the
real yataverse.com endpoint. This is evidence for synthetic cross-app
custody only. Production owner grants, cross-device sharing, and physical
Awai OS verification remain separate work.
