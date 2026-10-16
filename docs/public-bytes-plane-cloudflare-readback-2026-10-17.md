# Yataverse bytes-plane Cloudflare readback — 2026-10-17

This read-only configuration snapshot supplements the public bytes-plane audit in
[the 2026-10-16 backfill record](legacy-did-backfill-2026-10-16.json).

## Expected CID host

The Itonami bytes-plane operator instructions use
`https://<CID>.ipfs.yataverse.com/` for CID-subdomain byte reads
([source skill](https://github.com/kotoba-lang/amu/blob/cd5d506be511febc4da2c8903ad1554d59986e8c/hermes/profiles/jvm-retire/skills/kotobase-bytes-plane/SKILL.md)).
This is configuration intent; it does not prove the hostname serves bytes.

## Cloudflare configuration observed

The active `yataverse.com` zone returned these readbacks:

- DNS has `*.ipfs.yataverse.com` as a proxied AAAA record with content
  `100::`.
- The matching Worker route list contains `wiki.yataverse.com/patents*`
  for `app-hyakka-patents`; it contains no CID wildcard route.
- The matching Worker custom-domain list contains enabled production
  `wiki.yataverse.com` for `app-hyakka`; it contains no CID host binding.
- No zone load-balancer entry matching `ipfs` or `yataverse` was returned.
- No zone entrypoint ruleset was found for the `http_request_origin` phase.
- The `ipfs-origin` Cloudflare Tunnel reported `down` and zero active
  connections. Its ingress hostnames are `ipfs.gftd.ai` and
  `ipfs-origin.gftd.ai`, followed by a catch-all `http_status:404`.
  Neither ingress hostname is under `ipfs.yataverse.com`. The internal
  service address is omitted from this public record.

These observations show that the inspected Cloudflare configuration does not
bind the CID host to the listed Worker or tunnel ingress. They do not by
themselves prove the behavior of every edge or origin path.

## Byte and hash status

The Cloudflare configuration pass did not retrieve a CID response body, so it
observed no HTTP status or payload and performed no SHA-256 comparison. The
earlier 2026-10-16 audit records DNS/TLS/client readback failures; those
transport failures are not an HTTP 404 and do not establish that the CID data
is absent.

A separate direct client probe on 2026-10-17 JST found that
`dig +short ipfs.yataverse.com` returned no addresses and
`curl https://ipfs.yataverse.com/` failed with `curl (6): Could not resolve
host`. The three inventory-root CID subdomains returned A answers
`104.21.58.150` and `172.67.204.228` from this resolver, but HTTPS requests
to their raw CID URLs failed during TLS negotiation with
`curl (35): SSL alert handshake failure`. No HTTP status, response bytes, or
SHA-256 was obtained.

| Epoch | Inventory root CID | Direct raw-read result |
|---|---|---|
| 3 | `bafkreigee73ngsuzj2fqlnzygqhz3mmvgk6xopsf4icyvdqvngrmdwycvq` | TLS handshake failed |
| 4 | `bafkreia7apwkvsjh5be5v3sonkkq3jq4hxiiooymk2arxu2x6tfvphuuwa` | TLS handshake failed |
| 6 | `bafkreiatoqsucmlvs3ktvtrmkglx6vlqauiodzj26mqwnt2flcpggmnce4` | TLS handshake failed |

These results describe this client's DNS and TLS path, not every edge or the
availability of the underlying bytes. They do not establish that any CID is
missing. The inventory report's local CID/hash checks remain local evidence;
remote readback is still unverified.

Manifest-root and model-catalog candidates remain unverified references. This
configuration record does not establish asset rights, contributors, or actual
training use, and does not make any candidate eligible for YATA rewards.

No DNS, Worker, tunnel, load-balancer, or origin setting was changed.
