# Yataverse

Yataverse is the verified bytes plane for Awai Android apps and Itonami dapps.
Follow the [shared app storage contract](https://github.com/network-awai/awai-os/blob/main/docs/otehon/app-storage.md).
AwaiFS/WNFS owns private snapshot semantics, and Kotobase owns graph commits and
queries. Storage APIs receive the declared content-addressed blocks or encrypted
packs. Keep file names, private graph indexes and decryption material on the
authorized client.

Yataverse is the service; kotobase (`kotoba-lang/kotobase`) is a library it may depend on, never the reverse
([ADR 0050](https://github.com/network-awai/network-awai-apex/blob/main/docs/adr/0050-kotobase-is-a-library-yataverse-is-the-service.md)). Do not add `kotobase.net` hosts or name a new service, host or repository "kotobase".

- Reuse `src/drive-packs.mjs` for the existing bounded encrypted Drive pack
  protocol. Supply the app's canonical Kotoba operation broker and existing hash
  implementation. Keep app-specific descriptor, consent UI, WNFS and custody in
  the app and owning libraries.
- Verify storage receipts required by the app's pinned trust configuration and
  independently digest-check readback before committing a local sync state.
- Run `npm ci && npm test` for the store and client. Build the pinned UI with
  `npm --prefix app/vendor/awai-os/packages/awai-ui ci` and
  `npm --prefix app/vendor/awai-os/packages/awai-ui run build`.
  With the checked-in generated app core, run `node app/scripts/build.mjs`
  followed by `npm --prefix app test`. Track physical-device qualification
  separately.
