# Yataverse app (Tauri v3)

The demand-side entry of the Yataverse network (Linear [AWAI-3130](https://linear.app/kotobalabs/issue/AWAI-3130),
project "Yataverse — 証明つき分散ストレージ網と YATA"). Files are encrypted on the device and saved to
**yataverse.com**. Plaintext, file names and keys are never sent, and every upload and download asks
for fresh consent.

Design: [Figma AWAI-3130 proposal](https://www.figma.com/design/umqCqP5KSjLWh9fhCI1HaN?node-id=290-1782)
(9 states, built from the Awai Drive Android v2 components).

## What it is built from

This app is a port of Awai Drive (`network-awai/awai-os` `apps/drive` at
`7f74855e170cbbb2aa25f38243fe13b8fb9a2961`). It keeps Drive's design and code:

- **Encryption:** the Kotoba hybrid envelope, owner-store `object-v2` and the AwaiFS CAR codec. The pinned
  sources are in `vendor/` (`vendor/PINS.json`), and the browser core is built from `core/` into
  `generated/core.js`.
- **Consent:** the canonical `kotoba-client-runtime.js` broker. Every network operation is declared in the
  descriptor and approved one at a time.
- **Key custody:** Android Keystore (`DriveVault.java`). The device keeps a wrapped key record in
  `noBackupFilesDir`.

What changed from Drive:

- The store is fixed to `https://yataverse.com`. Uploads use the Worker's Drive pack protocol
  (`/awai-drive/v1/packs/<sha256>`). The descriptor and CSP allow only that origin.
- The app id is `network.awai.yataverse`, the window title is Yataverse, and the copy follows the Figma
  proposal.
- Before the first save, a confirmation explains that the key exists only on this device and that losing it
  loses the data.
- Consent denial and connection errors have their own messages.

`vendor/awai-os/` holds the awai-os files that the Drive build took from outside `apps/drive`: the canonical
client runtime and consent CSS, `awai-shell/host.js`, and the `@awai/ui` package. Each file's SHA-256 at the
pinned revision is in `vendor/awai-os/PINS-AWAI-OS.json`, and `test/vendor.test.mjs` fails on drift.

The rebuilt `generated/core.js` is not byte-identical to Drive's committed artifact (the build paths differ).
On 2026-11-18 it was checked to interoperate both ways: each core opens packs sealed by the other. A live
round trip through yataverse.com also succeeded: seal, PUT, GET, then open, with identical bytes.

## Verification status

| Target | Status (2026-11-18) |
|---|---|
| Unit tests (`npm test`) | 10/10 pass |
| Android emulator (arm64, API 36, debug APK) | Verified: key warning, consent Deny sends nothing, save (upload and read-back consents), free up space, restore through yataverse.com |
| Android real device | Not checked yet |
| macOS / desktop | Not available: key custody adapter missing ([AWAI-3339](https://linear.app/kotobalabs/issue/AWAI-3339)) |
| Expired or tampered data, through the UI | Not checked yet (covered by core tests only) |

Tracking: [AWAI-3130](https://linear.app/kotobalabs/issue/AWAI-3130) (parent), [AWAI-3338](https://linear.app/kotobalabs/issue/AWAI-3338) (this α, done).

## Limits (α)

- **Android only for now.** Like Drive, the desktop target returns `android-adapter-required` because key
  custody is only implemented with Android Keystore. Desktop custody (macOS Keychain and others) is a
  follow-up.
- **Size:** encrypted snapshots are limited to 8 MiB / 1000 entries. Larger local files stay on the device.
- **Recovery:** there is no key recovery yet (AwaiFS owner enrollment). Uninstalling the app or clearing
  its data makes saved data unreadable.
- **No proof of retention yet.** yataverse.com currently stores packs in Backblaze B2. Proof-of-storage
  providers come later (ADR 0041, project milestone M2).

## Build and check

Use JDK 21 and an Android SDK/NDK. First build the vendored UI package once:

```sh
(cd vendor/awai-os/packages/awai-ui && npm ci && npm run build)
npm ci
npm run build          # Clojure CLI builds the core, then esbuild and the static artifact
npm test
npm run tauri -- android build --apk --target aarch64 --debug
```

`YATAVERSE_ORIGIN=https://<fixture>` overrides the store for local test fixtures only. Do not ship a
build with an override.
