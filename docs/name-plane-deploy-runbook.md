# Name plane: deploy runbook

How to turn on the name plane (`{name}.itonami.app` served from this Worker) and how to turn it
off again. Tracking: JUN-1414 (decision and remaining work), JUN-1417 (this runbook).

**The name plane is on since 2026-11-21** (section 2b, JUN-1425): the route `*.itonami.app/*` is
on this Worker and `NAME_PLANE_SUFFIXES` is `.itonami.app`. No site is published yet: no name has
a `_dnslink` record whose blocks are in the store. Sections 2 and 2a describe the state before
that; sections 3 to 5 are kept as the record of the steps and for a later re-enable.

## 1. What turning it on changes

| | Before | After |
|---|---|---|
| `{name}.itonami.app` with a proxied DNS record and no more specific route | Cloudflare answers 522 (no origin) | this Worker serves the site its `_dnslink` names |
| `{name}.itonami.app` with a DNS-only record (pointing at a node) | reaches the node | unchanged: it never reaches the Worker |
| `itonami.app` itself, `a.b.itonami.app` | 522 or unchanged | `404 not-a-name-host` if the route catches them |
| `yataverse.com` | bytes-plane API | unchanged |

A name host answers `GET` and `HEAD` only. A more specific Worker route for one host (for example
an app's own Worker on `foo.itonami.app/*`) takes precedence over the wildcard route.

## 2. State on 2026-11-21 (read-only checks)

- **Deployed version.** `https://yataverse.com/.well-known/yataverse-policy/current.json` reports
  source `54cab52138b396fe3c4d679a180ebe5cd8d1f0d3`; the last deployment is dated 2026-11-19.
- **`main` is ahead of it by 10 commits.** Besides the name plane (#50) they include the
  retention work (#43, #44, #45, #46, #48, #49: AWAI-3670 to AWAI-3680), which is **not deployed**.
  `wrangler deploy` from `main` ships all of it. Confirm with the owner of that work that it may go
  out, and check whether it needs secrets or settings that are not provisioned yet, before
  deploying for the name plane.
- **Account.** The Worker `yataverse-bytes` is in the Cloudflare account `cloud-kotoba`. The owner
  says the `itonami.app` zone is in the same account. This was not confirmed through the API
  (the zone list could not be read with the local token).
- **DNS.** Measured earlier the same day: `*.itonami.app` resolves through Cloudflare and answers
  522; `_dnslink.tsukuru.itonami.app` holds a CID; `_dnslink.kaisya.itonami.app` holds an IPNS
  name. A second look while writing this failed (no DNS answer from the machine used), so re-check.
- **Build.** `wrangler deploy --dry-run` from `worker/` builds the bundle (wrangler 4.103.0).
- **Tests.** `npm test` passes on Node 24.20.0 and 26.0.0. This repository's CI has not run since
  2026-10-16, so Node 18, 20 and 22 are not verified.
- **Workers plan.** Not checked. Each block read is one subrequest. On the Free plan a request may
  make 50, which limits a served file to roughly 40 chunks (about 10 MiB) and fails beyond that;
  the default limit in the code (`NAME_PLANE_MAX_FILE_BLOCKS` = 128) assumes a paid plan. If the
  account is on Free, set that var to 40 in the enabling change.

## 2a. Deploy of `main` on 2026-11-21 (name plane off)

Owner approval 2026-11-21: deploy `main` including the retention work. Tracking: JUN-1418.

- Deployed `79241d81f28cc6f5cd2d86b759a3848e925cc494` from a clean checkout of `main`, with
  `NAME_PLANE_SUFFIXES` empty and only the `yataverse.com` route. Version
  `33945e82-1bf4-49f8-876f-28c1ae1919cc`; the version before it is
  `7d411f55-2c3a-4ae4-bace-8aca4bafe2aa` (source `54cab52`).
- This supersedes the "deployed version" and "`main` is ahead" items in section 2.
- **Retention is deployed but dormant.** Its secrets (`B2_LOCK_KEY_ID`, `B2_LOCK_APP_KEY`,
  `ARCHIVE_RECEIPT_SIGNING_KEY`) are not provisioned, so a write that carries a lease is refused
  (`503`) and ordinary writes are unchanged. Provisioning them is that work's own step.
- Checked after the deploy: `/health` 200; `current.json` reports the new source; the receipt key
  set is served; a raw block write returned a verified receipt and read back; a two-file UnixFS
  probe site (`yataverse site-pack` then `car-put`) was stored with a verified receipt and read
  back, root `bafybeie5ud226hhxyopmltfus7tajhhn7xl7ypbtk3ql4gv4ycc4qi3sim`, the same root
  `ipfs add -r --cid-version=1 -n` (0.41.0) gives for that directory; its CAR export works;
  `x-probe.itonami.app` still answers 522 (no route was added).
- Not checked: leased writes, Drive packs, service-auth writes, CORS answers. Reading a block
  that is not in the store takes about 15 s and ends in `504 read-fallback-unreachable`, because
  `READ_FALLBACK_URL` (`ipfs.yataverse.com`) does not answer; that was already so before.

## 2b. Name plane turned on, 2026-11-21

Owner approval 2026-11-21 for the route and the suffix. Tracking: JUN-1425 (parent JUN-1414).

- **Change.** Pull request #52, merge commit `3f495682d24b26d470baf6060a8cfa97589c4982`
  (2026-11-21T14:03:11Z): the route, `NAME_PLANE_SUFFIXES: ".itonami.app"` and
  `NAME_PLANE_MAX_FILE_BLOCKS: "40"`.
- **Deploy.** From a clean checkout of that commit, in `worker/`, account `cloud-kotoba`:
  `wrangler deploy --var SOURCE_COMMIT:<commit>` (wrangler 4.103.0). Version
  `fae5293f-57f8-4590-b95a-7204d806902e`. The version before it, with the name plane off, is
  `33945e82-1bf4-49f8-876f-28c1ae1919cc`.
- **Zone account.** The zone list could not be read through the API (authentication error with
  the local token). The deploy attached `*.itonami.app/*` with `zone_name: itonami.app` in
  `cloud-kotoba`, which it can only do for a zone in that account.
- **Workers plan.** Could not be read (same error). The 40-block cap is set for that reason: a
  served file is limited to about 10 MiB. On a paid plan, remove the var.
- **Checked at 14:03Z, before the deploy.** `x-probe`, `www` and `tsukuru` `.itonami.app`: 522.
  `kaisya.itonami.app`: a DNS-only A record, no answer from that address. `itonami.app`: no A record.
- **Checked at 14:03:51Z, after the deploy.**

  | Request | Answer |
  |---|---|
  | `GET https://yataverse.com/health` | 200 `{"ok":true,"service":"yataverse-bytes"}` |
  | `current.json` | source `3f495682…` |
  | `GET https://yataverse.com/ipfs/<a stored raw block>`, receipt keys | 200, 200 |
  | `GET https://x-probe.itonami.app/`, `https://www.itonami.app/` | 404 `name-not-published` |
  | `PUT https://x-probe.itonami.app/ipfs/x` | 405 |
  | `GET https://x-probe.itonami.app/health` | 404 (no bytes-plane API on a name host) |
  | `GET https://tsukuru.itonami.app/` | 504 `read-fallback-unreachable` after 15.6 s |
  | `GET https://kaisya.itonami.app/` | no answer, as before (does not reach the Worker) |
  | `https://itonami.app/`, `https://a.b.itonami.app/` | no connection, as before (no record, or no certificate for two labels) |

- **`tsukuru.itonami.app`.** Its `_dnslink` record already existed and names
  `bafkreiau4wb3mxom2pqtl3aqpvtxqb4hfxr3cv5mfgygvcrseq57wbmrue`, a raw block that is not in the
  store. The host answered 522 before and answers 504 after 15 s now. To serve it, write that
  block (and the site it belongs to) to the store, or point the record at a stored site.
- **Not checked.** A published site end to end on a real `itonami.app` name (needs a `_dnslink`
  record, a DNS change in the dashboard); `HEAD`; files near the 40-block cap. The serving path
  itself is covered by `test/worker-names.test.mjs` only.
- **To publish the first site:** section 4, then steps 5 and 6 of section 5, then section 6.

## 3. Before deploying

1. Owner approval for the route `*.itonami.app/*` and the suffix `.itonami.app`. (Shipping the
   commits listed in section 2 was approved and done, section 2a.)
2. Re-run the checks in section 2 (deployed source, commits ahead, DNS).
3. Choose the first name. It must not be a host that already works another way. `kaisya` cannot
   be first: its record is IPNS and the name plane answers `501` for IPNS.
4. Have a write token for `yataverse.com` configured for the `yataverse` CLI (`yataverse status`).

## 4. Publish the site's blocks (can be done before the deploy)

The deployed version accepts UnixFS blocks (section 2a), so this can be done before turning the
name plane on.

```sh
yataverse site-pack ./site -o ./site-cars        # prints root, dnslink value and the CAR files
yataverse car-put ./site-cars/site-001.car       # then 002, 003, ... in order
```

`site-pack` is local and sends nothing. Like `ipfs add -r`, it leaves out names starting with `.`
and lists them as `skippedHidden`; a site that serves `.well-known/` needs `--hidden true` (then
remove `.git`, `.DS_Store` and the like from the directory first, because everything is included). `car-put` verifies the signed receipt and reads the blocks
back. Keep the printed `root`. Check one block: `yataverse verify <root>`.

## 5. Turn it on

1. Merge the enabling pull request (`NAME_PLANE_SUFFIXES: ".itonami.app"` and the route
   `{ "pattern": "*.itonami.app/*", "zone_name": "itonami.app" }` in `worker/wrangler.jsonc`).
2. Deploy from the merged `main`, in `worker/`:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<cloud-kotoba account id> wrangler deploy --var SOURCE_COMMIT:<merged main commit>
   ```

3. Check the bytes plane first: `curl -s https://yataverse.com/health` gives
   `{"ok":true,"service":"yataverse-bytes"}`, and `current.json` reports the new source commit.
4. Write the site's blocks (section 4) if they are not there yet.
5. Set the TXT record `_dnslink.<name>.itonami.app` to `dnslink=/ipfs/<root>`, exactly one such
   record. This is a DNS change in the Cloudflare dashboard (the local wrangler login has no DNS
   edit scope).
6. Make sure `<name>.itonami.app` has no DNS-only record of its own, so it falls to the proxied
   wildcard.

## 6. Check

```sh
curl -sI https://<name>.itonami.app/                 # 200, x-ipfs-roots: <root>
curl -s  https://<name>.itonami.app/ | shasum -a 256 # equals shasum of ./site/index.html
curl -s -o /dev/null -w '%{http_code}\n' -X PUT https://<name>.itonami.app/ipfs/x   # 405
curl -s -o /dev/null -w '%{http_code}\n' https://itonami.app/health                 # 404 if routed
curl -s https://yataverse.com/health                 # unchanged
```

Compare a few more files by digest. A name without a record gives `404 name-not-published`; that is
the expected answer for every other `*.itonami.app` host that falls to the wildcard.

## 7. Turn it off

Fastest: remove the route for `*.itonami.app/*` from the Worker in the Cloudflare dashboard. The
hosts go back to 522; `yataverse.com` is unaffected. Then set `NAME_PLANE_SUFFIXES` back to `""`,
remove the route from `wrangler.jsonc` and deploy, so the next deploy does not bring it back.

`wrangler rollback` to the previous version also turns it off, but it rolls back every other
change in that deploy too.

DNS records and stored blocks can stay; with the route gone they have no effect.

## 8. Node as the main origin, this Worker as the spare

Owner decision 2026-11-21: nodes stay the main origin; this is the spare.

- To serve a name from a node: add a DNS-only A record for `<name>.itonami.app` pointing at the
  node. A specific record wins over the wildcard, so the Worker stops seeing that host.
- To fall back to the spare: remove that record. The name falls to the proxied wildcard and this
  Worker answers from the same `_dnslink`.
- Both must hold the same blocks. Pin the root on the node and import the same CARs here; the
  root CID is the same on both (see `docs/unixfs-kubo-comparison-2026-11-21.md` for what was
  compared).

DNS changes take up to the record's TTL to be seen. Who switches, and on what signal, is not
decided.

## 9. Limits to know

- IPNS targets are not resolved (`501`).
- No directory listing, no single-page-app fallback to `index.html`, no custom 404 page.
- A DNSLink answer is cached for 60 s per isolate, and responses carry `max-age=300`: after a
  record changes, the old site can be served for a few minutes.
- A file needs at most `NAME_PLANE_MAX_FILE_BLOCKS` blocks (128, about 33 MiB) and
  `NAME_PLANE_MAX_FILE_BYTES` (32 MiB). `site-pack` refuses files over 174 chunks (about 45 MiB).
- A block missing from the store is first looked for at `READ_FALLBACK_URL`; if that host is
  down the request waits for its timeout before failing.
