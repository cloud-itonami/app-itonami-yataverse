# Read deny log

Every change to `READ_DENY_CIDS` (`worker/wrangler.jsonc`, see README "Read deny list") gets one
row here. Add a new row for a removal; do not edit or delete earlier rows. Times are UTC.

| Date (UTC) | Action | CID | Size | Decided by | Why | Evidence |
|---|---|---|---|---|---|---|
| 2026-11-22 | deny | `bafkreigyi4fpsxzufdfxwbr5zcw4wai5jnuwjpqbonsyfcvo6bsuvjsmke` | 315,765 B | Legal (conclusion), Decision (go-ahead to deploy), requested by the Yataverse bot | ISCO-08 (ILO) full classification: public redistribution of the complete set needs ILO's written permission, which we do not hold. | Legal memo `~/.orca/bots/legal/reports/awai-3629-isco08-license.md` (local, not in this repo); Linear AWAI-3629 |

The object stays in B2. To undo: remove the CID from `READ_DENY_CIDS`, deploy, and add a row here.
