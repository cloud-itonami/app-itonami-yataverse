# AWAI-3399 shared SHA-256 WNFS sync

The Itonami Yataverse app consumes the pinned Drive WNFS bundle, worker and
signed receipt verifier identified by `drive-wnfs-pin.json`. Its Android
vault supports the same capsule, ordered pack identifiers and copy-only
restore staging. App builds use their own runtime capability and consent
surface. The Yataverse service validates SHA2-256 CIDv1 CAR blocks and pack
SHA-256 using its existing contract. The local compatibility test builds a
genuine snapshot with the shared writer and checks it with the service
parser and verifier, then opens and queries its forest.

`AWAI_DRIVE_WNFS_SYNC=1` enables the shared WNFS profile for this build.
`AWAI_WNFS_QA=1` additionally separates the debug APK identity. An
already-authorized owner session and one fresh approval per GET are needed
for read-only inspection of a snapshot from another app. Product sharing
and key transfer are separate from this test interface.

See [Drive #12](https://github.com/network-awai/app-drive/pull/12) and
[AWAI-3399](https://linear.app/kotobalabs/issue/AWAI-3399).
