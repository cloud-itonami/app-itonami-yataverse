# yataverse

CLI and MCP server for the **yataverse** bytes plane (formerly kotobase): content-addressed
blocks, **verified on every read and after every write**. Zero dependencies, Node 18+.

A block is named by the sha2-256 of its bytes (CIDv1). `yataverse` never trusts the route or a
cache: it re-derives the CID from the bytes it actually received and refuses anything that does
not match.

```sh
yataverse cid file.bin                 # the CID a file would have (local)
yataverse get bafkrei... -o out.bin    # read, verified against the CID
yataverse verify bafkrei...            # present? and do the served bytes hash to it?
yataverse put file.bin                 # publish, then read back and verify
yataverse status                       # how this machine is configured (names only)
yataverse config init --tenant-id t_... --storage blocks --sa-token-stdin < secret
yataverse token                        # a fresh Authorization value, for another tool's auth-cmd
yataverse mcp                          # MCP server on stdio
```

## Reads and writes

- **Read**: `GET <readUrl>/ipfs/<cid>` (default `https://ipfs.yataverse.com`). The gateway answers
  with a `301` to a per-CID subdomain; that is followed (at most 3 hops) but **only inside the read
  host's own parent domain**, over https.
- **Write**: `PUT <url><prefix><cid>` (default `https://kotobase.net/ipfs/`, `application/vnd.ipld.raw`).
  A write **never follows a redirect**: the `Authorization` header must not travel to another host.
  Every write is read back and its CID recomputed.

## Authorisation

Writes need an `Authorization` value. In order:

1. **Your minter command** — `YATAVERSE_AUTH_CMD='["/path/to/mint","--aud","..."]'` (or `authCmd` in the
   config). Run as an argv array, **no shell**; stdout is the value. Runs before every write.
2. **A tenant service-account secret** (`kb_sa_...`, issued by a **tenant admin**) with `tenantId`
   (`t_...`) and optionally `storage`: exchanged at `https://auth.kotoba.cloud/v1/biscuit/token` for a
   15-minute Biscuit, cached until 60 s before expiry. The secret is only ever sent to an allow-listed
   Authn host over https.
3. **A static value** (`~/.config/yataverse/auth`, 0600), for a gateway that accepts one.

This tool **mints no credential**. A self-signed CACAO is refused by the plane (probed 2026-09-29),
and Authn issues a Biscuit only to a tenant member — so the secret has to come from a tenant admin.

Config lives in `~/.config/yataverse` (`$YATAVERSE_CONFIG_DIR`): `config.json` (non-secret) and
`sa-token` / `auth` (0600 — a secret file readable by group or other is **refused**).

## MCP

```sh
claude mcp add yataverse -- node /path/to/yataverse/bin/yataverse.mjs mcp
```

Tools: `yataverse_status`, `yataverse_cid`, `yataverse_get`, `yataverse_verify`, `yataverse_put`.
Credentials come from the operator's config and **never pass through a tool argument or result**:
any argument named like a credential is refused. `yataverse_put` requires `confirm: true` (it writes to a
shared plane and cannot be undone). Bytes returned by `yataverse_get` are untrusted data.

## Test

```sh
npm test        # 25 tests: CID vectors, redirect policy, Authn exchange/caching, config permissions, MCP
```

Apache-2.0.
