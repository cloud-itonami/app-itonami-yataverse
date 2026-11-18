# 署名付き保存受領証（Yataverse storage receipt v1）の設計

- Status: **owner 決定済み**（2026-11-18。§10 の推奨案を採用）。実装は [AWAI-3268](https://linear.app/kotobalabs/issue/AWAI-3268)。
- Tracking: [AWAI-3261](https://linear.app/kotobalabs/issue/AWAI-3261)（親 [AWAI-3117](https://linear.app/kotobalabs/issue/AWAI-3117) の受入条件 3）。
- 位置づけ: [ADR 0041](https://github.com/network-awai/network-awai-apex/blob/main/docs/adr/0041-yataverse-proof-of-storage-network.md)（Proposed）の段階 **P0「署名つきの保存受領証と readback」** の具体化。P1（PDP 型 PoSt）以降へ同じ構造のまま拡張できるようにする。
- 前提にする既存の契約:
  - [ADR 0031](https://github.com/network-awai/network-awai-apex/blob/main/docs/adr/0031-itonami-resource-market-and-slashing.md) D9（accepted）: receipt は **EIP-712 の typed data** として定義し、native も同じ struct hash に署名する。Bot の Ed25519 session key は native の経路で使い、EVM では account の ERC-1271 で検証する。
  - [AwaiFS storage architecture](https://github.com/network-awai/network-awai-apex/blob/main/docs/awai-fs-storage-architecture.md) §3: `put-block(reservation, cid, bytes)` は **local durable receipt** を返し、それだけで分散保持の完了としない。`local durable` と `policy satisfied` を区別する。receipt は署名者の受領主張で、物理 fsync や継続保持の証明ではない。
  - [Protocol v0.1](https://github.com/network-awai/network-awai-apex/blob/main/docs/awai-network-protocol-v0.1.md) の `ServiceReceipt`: request・input・result の commitment、operation、予約と使用の資源、状態、policy revision、service の署名。同じ request の再送には同じ receipt を返す。
  - ADR 0041 D6: Cloudflare と B2 は「縁」であり、保持の正本にも証明の対象にも数えない。

## 1. 目的と非目的

受領証で、次の 1 文だけを検証可能にする。

> 鍵 `keyId`（epoch `keyEpoch`）を持つ Yataverse の入口は、`acceptedAt` に、request `requestId` として、内容 `contentDigest`（大きさ `size`）の `subject` を受け取り、`storeClass` の保存先に書き込み、読み戻して同じ bytes であることを確かめた。

受領証が**主張しないこと**:

- **期間の保持:** `retentionUntil` が 0 の受領証は、将来の保持を約束しない。
- **独立した複製や障害ドメイン:** これらは検証役（旧 Kura の役割、ADR 0041 D2）が複数の受領証と証明から判断する。
- **保存先の誠実さ:** 悪意ある node の物理的な永続化は証明しない。
- **内容について:** 内容の正当性、権利、平文の秘匿、最新版であることは扱わない。

## 2. 状態

`state` は storage architecture の状態に合わせる。P0 で入口が出せるのは 1 つだけ。

| 値 | 名前 | 意味 | P0 で出すか |
|---|---|---|---|
| 1 | `local-durable-readback` | 保存先に書き込み、全 bytes を読み戻して digest が一致した | 出す |
| 2 | `local-durable` | 書き込みの成功応答のみ（readback なし） | 出さない（予約） |
| 10 | `policy-satisfied` | 必要な独立保存先の受領証と証明が揃った | **入口は出さない。** 検証役だけが別の形式で出す |

入口が `policy-satisfied` を名乗ることを、検証の手順（§6）で拒否する。

## 3. EIP-712 の型

```
EIP712Domain(string name,string version)
  name    = "Awai Yataverse Storage Receipt"
  version = "1"
  chainId / verifyingContract: 当面は置かない（§10 の決定 2）

YataverseStorageReceipt(
  uint8   kind,
  bytes   subject,
  uint64  size,
  bytes32 contentDigest,
  bytes32 requestId,
  bytes32 requester,
  bytes32 reservationId,
  bytes32 leaseId,
  bytes32 pieceCommitment,
  bytes32 policyRevision,
  uint8   state,
  uint8   storeClass,
  uint64  acceptedAt,
  uint64  retentionUntil,
  bytes32 keyId,
  uint32  keyEpoch)
```

署名の対象は EIP-712 の digest、つまり `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(receipt))`。field の encoding は EIP-712 の規則に従う。`bytes` は keccak256 を取る。

### 3.1 field の意味（P0 での値）

| field | 意味 | block の PUT | CAR の POST | Drive pack の PUT |
|---|---|---|---|---|
| `kind` | 書込みの種類 | 1 | 2 | 3 |
| `subject` | 何を受け取ったか | CID の binary | 下記の roots commitment（32 bytes） | pack ID（32 bytes の sha256） |
| `size` | 受け取った bytes 数 | block の長さ | 保存した block の合計 | pack の長さ |
| `contentDigest` | 内容の digest | CID の sha2-256 digest | block set digest（下記） | pack の sha256 |
| `requestId` | 冪等性のキー（client が決める） | header `Yataverse-Request-Id`。なければ `contentDigest` | 同左 | 同左（Drive は送らないので `contentDigest`） |
| `requester` | 認可に使った資格の digest | 書込み token の SHA-256（Worker の設定と同じ値） | 同左 | 0（認証なし。owner 決定 2026-11-18） |
| `reservationId` | 容量予約 | 0（P0 に予約はない） | 0 | 0 |
| `leaseId` | ADR 0031 の `pin` lease | 0 | 0 | 0 |
| `pieceCommitment` | P1 の Merkle root（CommP 相当） | 0 | 0 | 0 |
| `policyRevision` | 判定に使った規則の版 | 下記 | 下記 | 下記 |
| `state` | §2 | 1 | 1 | 1 |
| `storeClass` | 保存先の種類 | 1 = `edge-gateway`（yataverse.com Worker と B2） | 1 | 1 |
| `acceptedAt` | 受理した時刻（Unix ミリ秒） | | | |
| `retentionUntil` | 保持を約束する期限 | 0 | 0 | 0 |
| `keyId` / `keyEpoch` | 署名鍵（§5） | | | |

- **roots commitment:** canonical DAG-CBOR の `{"roots": [CID link, …]}`（CAR header の roots と同じ順序）の sha256。
- **block set digest:** 保存した block と、external として既存を確認した block の両方の CID binary を bytewise に昇順で並べ、各要素を `varint(長さ) ‖ CID` として連結した列の sha256。
- **policyRevision:** canonical DAG-CBOR の `{"source": <Worker の source commit>, "limits": <有効な書込み制限の記述>, "store": <bucket と prefix>}` の sha256。版の中身は `/.well-known/yataverse-policy/<hex>.json` で公開する（§5）。

`storeClass` の値の定義:

| 値 | 名前 | 意味 |
|---|---|---|
| 1 | `edge-gateway` | yataverse.com の入口と B2。ADR 0041 D6 の「縁」なので、検証役は複製数に数えない |
| 2 | `provider-node` | P1 以降の provider node。piece commitment と組み合わせて使う |

## 4. 転送と保存の形式

- **JSON（応答に含める形式）:** 既存の応答に `receipt` field を追加する。各 field は 0x 付きの hex、署名は base64url。Drive の応答は既存の `{sha256, bytes}` に `receipt` を足すだけなので、Drive の今の検査（`sha256` と `bytes` の一致、2048 bytes 以下）は通る。試算では受領証は約 1 KB で、上限に収まる。
- **DAG-CBOR（記録用の形式）:** 同じ値を canonical DAG-CBOR の `{"v":1,"receipt":{…},"sig":{"alg":…,"key":…,"sig":…}}` にし、block（codec 0x71）として `ipld/receipts/` に保存する。受領証そのものが CID を持つので、検証役がまとめて扱える。
- **署名は encoding から独立している。** JSON でも DAG-CBOR でも、検証は §3 の EIP-712 digest に対して行う。

## 5. 鍵、公開、rotation

- **署名の方式（推奨）:** Ed25519 で EIP-712 digest に署名する。ADR 0031 D9 の「native は Ed25519 の session key、EVM は account の ERC-1271」の形に合わせる。Workers の WebCrypto は Ed25519 を持つので、依存を足さずに実装できる。EVM で直接 `ecrecover` したい場合は secp256k1 を選ぶ（§10 の決定 1）。
- **鍵の置き場所:** 署名鍵は Worker の secret（`RECEIPT_SIGNING_KEY`、PKCS#8）。値は表示も commit もしない。
- **`keyId`:** 公開鍵の multicodec（ed25519-pub）bytes の sha256。
- **公開:** `/.well-known/yataverse-receipt-keys.json` に、各鍵の `keyId`、`keyEpoch`、公開鍵、`notBefore`、`notAfter`、`revokedAt` を載せる。合わせて `did:web:yataverse.com` の DID document（`/.well-known/did.json`）に verificationMethod として載せる。
- **rotation:** 新しい鍵を追加して epoch を上げる。古い鍵は `notAfter` を設定して公開を続ける。
- **失効:** 失効した鍵は `revokedAt` を記録する。`revokedAt` 以降の時刻を名乗る受領証は無効とする（ADR 0031 D7 の手順 5 と同じ考え方）。
- **集約:** 鍵の一覧と policy の版の一覧も DAG-CBOR の block として保存し、その CID を受領証の検証記録に残せるようにする。

## 6. 検証の手順（client と検証役）

1. 鍵の一覧から `keyId` を引く。`keyEpoch` が一致し、`notBefore ≤ acceptedAt < notAfter` を満たし、`revokedAt` より前であることを確かめる。
2. §3 の EIP-712 digest を計算し、署名を検証する。
3. `subject`・`contentDigest`・`size` を、自分の手元の値（送った CID や bytes、CAR から計算した block set digest）と比べる。
4. `state` が 1 であること、`storeClass` が既知の値であることを確かめる。入口の受領証が `policy-satisfied` を名乗っていたら拒否する。
5. `policyRevision` の中身を取得し、期待した規則（書込みの制限、保存先）かを確かめる。
6. 検証役は、`storeClass = edge-gateway` の受領証を複製数に数えない（ADR 0041 D6）。

## 7. 冪等性と矛盾

- **同じ request の再送:** Worker は状態を持たない（KV・D1・DO・R2 は使わない。ADR 0031 D1）。そこで受領証の DAG-CBOR を B2 の `ipld/receipts/by-request/<requestId>` にも置き、同じ `requestId` と同じ `contentDigest` の再送には、保存済みの受領証をそのまま返す（Protocol v0.1 の T03）。
- **矛盾:** 同じ `requestId` で `contentDigest` が違う場合は 409 `request-id-conflict` とし、新しい受領証は出さない。
- **slashing の材料:** 同じ鍵が同じ `requestId` に対して異なる内容の受領証に署名していれば、ADR 0031 D7 の「矛盾する receipt」の証拠になる。鍵の管理を誤ると罰の対象になり得るので、`requestId` の衝突の扱いは実装の試験で必ず負例を置く。

## 8. 予約・quota・lease との境界

- **P0（現状）:** 予約はない。書込みの制限は WAF の rate limiting rule（IP ごとに 10 回／10 秒、AWAI-3242）だけで、受領証には `policyRevision` として記録する。`reservationId` は 0。
- **reserve を入れる段階:** storage architecture の `reserve(pool, request-id, quota, expiry)` を実装するときは、予約を受領証とは別の署名付き object（`YataverseReservation`）にし、受領証の `reservationId` はその hash を指す。予約の残量の会計は予約の発行者が持ち、受領証は「この予約から `size` を使った」ことだけを主張する。
- **lease を入れる段階（ADR 0031 / 0041 の P1）:** `leaseId` に `pin` lease を、`pieceCommitment` に P1 の Merkle root を入れる。`storeClass = provider-node` の受領証と PoSt の結果を検証役が集め、`policy-satisfied` を判断する。入口の受領証は、その入力の 1 つにとどまる。

## 9. 実装の順序（それぞれ別の issue と PR にする）

1. **署名と検証の core:** EIP-712 の digest の計算と Ed25519 の署名・検証、DAG-CBOR の encoding。依存を足さずに実装する。test vector として、参照実装（ethers または viem の `TypedDataEncoder`）で一度だけ照合し、その版と結果を記録する（oracle の規則）。
2. **鍵の公開:** `/.well-known/yataverse-receipt-keys.json`、DID document、policy の版の公開。鍵の生成と secret の投入は owner の承認後に行う。
3. **受領証の発行:** 3 種類の書込みで受領証を返す。受領証の保存と、再送への同じ受領証の返却（§7）。
4. **CLI での検証:** `yataverse put`・`car-put` で受領証を検証し、`yataverse verify-receipt` を追加する。
5. **Drive:** awai-os の Drive で受領証を検証するかは別に判断する（今の Drive は `sha256` と `bytes` だけを見る）。

各段階の受入条件: 正例に加えて、改ざん、別の鍵、失効後の時刻、`requestId` の衝突、`policy-satisfied` の自己申告の負例が拒否されること。本番での readback と検証まで確認すること。

## 10. owner の決定（2026-11-18: すべて推奨案）

| # | 決めること | 推奨 | 他の選択肢 |
|---|---|---|---|
| 1 | 署名の方式 | Ed25519 で EIP-712 digest に署名する（ADR 0031 D9 の native 経路。依存なし） | secp256k1。EVM で直接 `ecrecover` できるが、実装の依存が増える |
| 2 | EIP-712 domain の `chainId` | Awai L1 の chain ID が決まるまで domain に入れない（version で区別する） | 仮の値を入れる。後で変えると全受領証の digest が変わる |
| 3 | 署名者の identity | `did:web:yataverse.com` と公開した鍵の一覧 | Awai L1 の account（ADR 0029 決定 3）。L1 ができるまでは使えない |
| 4 | 受領証の保存 | B2 の `ipld/receipts/` に置く。再送に同じ受領証を返すため | 保存しない。その場合は再送のたびに `acceptedAt` が変わり、Protocol v0.1 の再送の規則を満たさない |
| 5 | Drive への受領証 | `receipt` field を足すだけで、Drive の変更は後回しにする | 今すぐ Drive に受領証の検証を入れる |
| 6 | `requester` の扱い | 認証つきは token の SHA-256、Drive は 0 | 接続元の IP の hash も入れる（濫用の追跡には役立つが、privacy に影響する） |

## 11. 実装の記録

- **段階 1（[AWAI-3304](https://linear.app/kotobalabs/issue/AWAI-3304)）:** `src/keccak.mjs`、`src/eip712.mjs`、`src/dag-cbor.mjs` の `encodeDagCbor`、`src/receipt.mjs`。依存は足していない。
- **JSON の整数:** `kind`・`size`・`state`・`storeClass`・`acceptedAt`・`retentionUntil`・`keyEpoch` は JSON の number にする（hex にしない）。P0 の値はすべて 2^53 未満で、超える値は拒否する。bytes の field だけを 0x 付きの hex にする。
- **署名鍵の secret:** `RECEIPT_SIGNING_KEY` は PKCS#8 ではなく Ed25519 の private JWK（`kty`・`crv`・`d`・`x`）にした。WebCrypto が private key から公開鍵を導けないため、`x` を併せて持ち、読み込み時に署名と検証を 1 回して `x` が `d` に対応することを確かめる。
- **oracle の照合（2026-11-18、一回限り、手元のみ）:** viem 2.21.0（npm、`.agent-output/oracle/` に入れ、repo には入れない）の `hashTypedData`・`hashDomain`・`keccak256` を、`test/fixtures/receipt-vector.json` に対して Node v26.0.0 で実行した。
  - 受領証の digest: `0x0e99111ec7716683f80460a9e79243824830ba37dbe3d2ee3b9a9d4b31c0e3a9`
  - 受領証の domain separator: `0x0a22e1d01718aac7aa4fa15a8ea92d916117fad7b833e886730786bedf6a6b97`
  - EIP-712 の例（Ether Mail）の domain separator: `0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f`
  - keccak256（`a` を 200 個、2 block）: `0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d`

  いずれも本実装の値と一致した。これは参照実装と同じ値になるという証拠で、本実装が正しいことの証明ではない。test はこの値を固定値として持ち、oracle を CI や実行経路には入れない。
- **段階 2・3（[AWAI-3305](https://linear.app/kotobalabs/issue/AWAI-3305)）:** `worker/src/receipts.mjs`。3 種類の書込みで受領証を返し、B2 の `ipld/receipts/by-request/<requestId>` に保存する。
  - 順序: 検査 → 署名鍵と既存の受領証の確認（衝突なら 409、bytes は保存しない）→ 保存と readback → 署名と受領証の保存。再送でも保存と readback はやり直し、受領証は保存済みのものを返す。
  - 衝突の判定: `kind`・`subject`・`size`・`contentDigest`・`requester` のどれかが違えば 409。
  - 署名鍵が無い、公開されていない、今有効でない場合は書込みを 503 にする（署名のない成功を返さない）。
  - policy の記録は dag-cbor の block として保存するので、`policyRevision` は block の CID の digest と同じになり、過去の版も `/ipfs/<cid>` で読める。WAF の rule は Worker の外の設定なので、policy には宣言として記録する（`EXTERNAL_WRITE_LIMITS`）。
  - 同じ `requestId` の新しい request が同時に 2 本来た場合、両方が新しい受領証を出し得る（内容は同じで `acceptedAt` だけが違う）。Worker は状態を持たないため防げない。内容が同じなので §7 の「矛盾する受領証」には当たらない。
  - 鍵（epoch 1、keyId `0xad062e68…eafc`）は 2026-11-18 に生成し、private JWK は手元に保存せず `wrangler secret put` に直接渡した。
- **段階 4（[AWAI-3268](https://linear.app/kotobalabs/issue/AWAI-3268)）:** `src/client.mjs` の `putBytes`・`putCar` と、`yataverse verify-receipt`（`src/verify-receipt.mjs`）。
  - client は書込みごとに乱数の `Yataverse-Request-Id` を送り、応答の受領証を §6 の手順で検証する。手元の値として、`subject`・`contentDigest`・`size`・`requestId` に加えて `requester`（送った bearer token の SHA-256）も照合する。別の request や別の requester の受領証を返す応答は拒否する。
  - 鍵は書込み先の `/.well-known/yataverse-receipt-keys.json` から取る（redirect は追わない）。`--keys <file>` で固定もできる。HTTPS の書込み先から鍵を取る場合、信頼の根は `did:web` と同じく、その host の TLS になる。
  - 受領証が無い応答: `https://yataverse.com` への書込みでは error にする。他の host では許すが、受領証があれば必ず検証する。
