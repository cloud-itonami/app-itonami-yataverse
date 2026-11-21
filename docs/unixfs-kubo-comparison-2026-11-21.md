# UnixFS packer compared with Kubo (2026-11-21)

One local measurement, taken once by hand (JUN-1415). It is evidence about these inputs and this
Kubo version. It is not part of the tests, the CI or any runtime path, and it does not prove the
packer matches Kubo for other inputs.

## Tools

- `ipfs version 0.41.0` (Homebrew, `/opt/homebrew/bin/ipfs`), a fresh repo from `ipfs init --empty-repo`
  in a scratch directory (`IPFS_PATH`), default import settings. Nothing was added to a repo or sent
  to the network: `-n` only hashes.
- Node v26.0.0, `packFiles` from `src/unixfs.mjs` at the commit that adds this file.

## Input

A directory `site/` with nine files:

| Path | Content |
|---|---|
| `index.html` | `<h1>home</h1>` |
| `app.js` | `console.log(1)` |
| `empty.txt` | empty |
| `a b.txt` | `space` |
| `docs/index.html` | `docs` |
| `docs/deep/日本語.txt` | `x` |
| `assets/big.bin` | 600000 bytes, byte `i` = `(i*31+7) & 255` |
| `assets/exact.bin` | 262144 bytes of `0x01` (exactly one chunk) |
| `assets/plus1.bin` | 262145 bytes of `0x02` (one chunk and one byte) |

## Commands

```sh
ipfs add -r --cid-version=1 -n site
```

and `packFiles(files)` over the same files, then `resolvePath` for each file and directory.

## Result

Both gave the same CID for the root, the three subdirectories and all nine files (13 of 13).

| Path | CID (both) |
|---|---|
| `site/` (root) | `bafybeidmiarr2oge7nrk3wwz5qdtzyabrsk54d4mkolcb4qfqryckuehn4` |
| `a b.txt` | `bafkreib7jhn37ycrzmqmya4jenbe73py2gbqptealyksbzawr2jwbyxlha` |
| `app.js` | `bafkreiakfbujdqi4avxbvnn7yjn7lvvs6wyg2ohkyeeuj5ty7wfc44gdsm` |
| `assets/` | `bafybeianaltt5rbbzvcz7so3hkfvjvfluauzqywyqsuag6adgqjcgk45iy` |
| `assets/big.bin` | `bafybeidudknqwx4o547irvvb4yjeyfa5ndfno3g7ikcsr25a6k4tytdeqm` |
| `assets/exact.bin` | `bafkreihtc7oz225adrdf3axeytkv2aosodo2nhnuuangjrmhuvmtvrqiju` |
| `assets/plus1.bin` | `bafybeiaphjhnbfbaf2ueejyxekx3czoyt5lv336ftrxcxxidre4oircdza` |
| `docs/` | `bafybeieyedym57eh2prlcbtba5mcbxpo74e3kdjupu42gtesgjemwdhhyy` |
| `docs/deep/` | `bafybeibny3cwrx7alpqxsopq6du4atcpjhy7dbzb6tljubpahqp2rn4epu` |
| `docs/deep/日本語.txt` | `bafkreibnoelefnzgwbcacyt4vh52ymxvzbjq7mmqhtcnwarfq4lzegsiqe` |
| `docs/index.html` | `bafkreicgwqvuekonpi44kzhhqc5wmwul3zh564raa7ueopywp7st5vfzsu` |
| `empty.txt` | `bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku` |
| `index.html` | `bafkreifv6tvc4tpv5zvydm27f772sycw4l3sxwrr5thg35fycosahlsnca` |

## Not covered

- Files over 174 chunks (about 45 MiB): Kubo builds a second level of file nodes; `packFiles` refuses them.
- Directories large enough for Kubo to switch to HAMT sharding: the store refuses HAMT nodes.
- Other Kubo versions, other import profiles, and other packers (for example the earlier
  `pack-unixfs.cljk`). A site already published with another tool was not compared.
