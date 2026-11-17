# Drive pack fixtures

`drive-v1.car` and `drive-v2.car` were generated once, locally, on 2026-11-18 with the Awai
Drive app's vendored CAR codec, to check that the yataverse.com Worker accepts the packs Drive
actually writes. They are test data; the codec is not a dependency and does not run in CI.

- Codec: `apps/drive/vendor/awai/fs/car.cljc` from network-awai/awai-os main `39e0d82`
  (sha256 `ed8e3d96f9262b7b093a07983953273a3fc007d9fb9ceecab7e2c12cbb2a4704`, the pin in
  `apps/drive/vendor/PINS.json`), run with nbb v1.4.208 on Node 26.0.0.
- Content: five synthetic raw leaves (not real files, not encrypted) and the pack root block
  `{leaves: [...]}`. `drive-v1.car` uses `carv1-encode` (what Drive's sync uses);
  `drive-v2.car` uses `assemble-pack` (CARv2 with a MultihashIndexSorted index).
- Root: `bafyreify3m6c5oc56iolzf2t5ammu6ua5xtzrrdzvn37grezerj5xxsnzy`.
