# Name plane: deploy runbook

How to turn on the name plane (`{name}.itonami.app` served from this Worker) and how to turn it
off again. Tracking: JUN-1414 (decision and remaining work), JUN-1417 (this runbook).

**Nothing here has been run.** The name plane is in `main` but off: `NAME_PLANE_SUFFIXES` is empty
and no route for `itonami.app` hosts exists on this Worker. Turning it on is a production route
change and needs the owner's approval for that step. Approval to deploy another change to this
Worker does not cover it.

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

## 3. Before deploying

1. Owner approval for: the route `*.itonami.app/*`, the suffix `.itonami.app`, and shipping the
   commits listed in section 2.
2. Re-run the checks in section 2 (deployed source, commits ahead, DNS).
3. Choose the first name. It must not be a host that already works another way. `kaisya` cannot
   be first: its record is IPNS and the name plane answers `501` for IPNS.
4. Have a write token for `yataverse.com` configured for the `yataverse` CLI (`yataverse status`).

## 4. Publish the site's blocks (can be done before the deploy)

The store accepts UnixFS blocks as soon as a version containing #50 is deployed. Until then
`car-put` of a UnixFS CAR is refused (`put-codec-not-accepted`), so on the first rollout this step
comes after step 5.2.

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
change in that deploy too (see section 2).

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
