# 保持の設計: 分散型の provider node と B2（案）

- Status: **案（Proposed）**。owner の決定待ち（§13）。実装、bucket の作成、鍵の発行、課金の変更は含まない。
- Owner direction（2026-11-21）:「yataverse.com で保持設計を分散型 + b2 で設計して」。
- Tracking: [AWAI-3667](https://linear.app/kotobalabs/issue/AWAI-3667)（親 [AWAI-3618](https://linear.app/kotobalabs/issue/AWAI-3618)）。
- 位置づけ: [受領証の設計](storage-receipt-design.md) §8 の「lease を入れる段階」と、[ADR 0041](https://github.com/network-awai/network-awai-apex/blob/main/docs/adr/0041-yataverse-proof-of-storage-network.md)（Proposed）の P1 を、B2 を併用する移行期つきで具体化する。
- 既存文書との食い違いは §12 にまとめた。この文書は既存の ADR を書き換えない。

## 1. 背景

2026-11-21 時点で確かめたこと:

- **保持の約束がない。** yataverse.com の受領証は全件 `state 1`、`storeClass 1`（`edge-gateway`）、`retentionUntil 0`、`leaseId 0`。保存先は B2 の 1 bucket だけで、検証役は複製数に数えない（受領証の設計 §1、§3.1）。
- **書いて読み戻すことはできる。** オントロジーの 138 ファイル（energy 5、legislation 55、出典 3 repo 78）を書き、全件を読み戻して照合した（AWAI-3623、AWAI-3624、AWAI-3665）。
- **参照だけを git に置く形は動く。** git-annex の key（SHA256E）に `https://yataverse.com/ipfs/<cid>` を登録し、別の clone から検証つきで取得できた（AWAI-3666）。
- **だから実体を git から外せない。** 約束のない 1 か所が唯一のコピーになるため。

この設計の目的は、利用者が「この CID はいつまで、どこに、何個あるか」を検証できるようにし、その条件を満たしたデータについては、git などの手元のコピーを外せるようにすることである。

## 2. 目的と非目的

**目的:**

1. 保持の約束の単位（lease）、期限、保存先の数え方を定義する。
2. B2 と provider node の役割を分け、それぞれが何を約束し、何を証明するかを定義する。
3. 受領証の既存の型（v1）を変えずに、各 field の値を段階ごとに定める。
4. 障害時の扱いと、誰が何を確かめるかを定める。
5. 分散型だけで成り立つ状態（ADR 0041 の目標）へ、B2 を足場にして移る順序を定める。

**非目的:**

- 決済（EN）、担保（YATA）、slashing。ADR 0031 / 0041 の条件が揃うまで無効のまま。
- PoRep（ADR 0041 の P2）。
- private データの取得 capability（ADR 0041 実装順 4）。この設計は暗号文か公開データの bytes だけを扱う。
- 内容の正当性、権利、最新版の判断。

## 3. 保存先の種類と数え方

保存先を 3 種類に分ける。**種類ごとに別々に数え、合算しない。**

| `storeClass` | 名前 | 実体 | 約束するもの | 証明 | 数え方 |
|---|---|---|---|---|---|
| 1 | `edge-gateway` | yataverse.com の Worker と B2 の配信用 bucket（既存） | なし（受理と 1 回の読み戻しだけ） | なし | **数えない**（既存どおり） |
| 2 | `provider-node` | 参加者が動かす node（ADR 0041 D2） | lease の期限まで piece を保持する | P1 の PoSt（§7） | **独立複製**として数える。障害ドメインごとに 1 |
| 3（新設） | `operator-archive` | B2 の保持用 bucket。Object Lock をかける | 運営者が、lock の期限まで削除も上書きもできない | bucket の lock 設定の読み戻しと、抜き取りの全読み（§8） | **運営者の保持コピー**として数える。独立複製には数えない |

`operator-archive` を独立複製に数えない理由:

- 運営者 1 者と B2 の 1 account に依存する。分散の条件（別の主体、別の障害ドメイン）を満たさない。
- [storage architecture](https://github.com/network-awai/network-awai-apex/blob/main/docs/awai-fs-storage-architecture.md) §8 は、既存の B2 運用の資格を独立ノード耐久性の証明に流用しないと定めている。

それでも種類を分けて数える理由: Object Lock は「運営者自身も消せない」という、`edge-gateway` にはない性質を持つ。これは約束として名乗ってよく、利用者が検査できる。

### 3.1 B2 の 2 つの bucket

| bucket | 用途 | Object Lock | 削除 |
|---|---|---|---|
| 配信用（既存の `yataverse-blocks`） | 書込みの受理、読み出し、受領証の保存 | かけない | 運営者が消せる |
| 保持用（新設） | lease のある block と piece の保持コピー | **compliance mode**、期限は lease の `retentionUntil` | 期限まで誰も消せない |

- 保持用 bucket に書く鍵は、配信用の鍵と分ける。Worker には、保持用 bucket への書込みと lock の読み取りだけを許す鍵を渡し、lock を短くする権限や削除の権限は渡さない。
- B2 の仕様（2026-11-21 に公式文書で確認）: compliance mode の lock は誰も外せず、期限の延長だけができる。Object Lock は一度有効にすると無効にできない。期限は 1〜3,000 日。既存 bucket でも有効にできる。
- **未確認:** account の閉鎖や支払いの停止が lock 中のファイルに与える影響は、公式文書に記載がなかった。運営者の約束の限界として policy に明記する（§9）。

### 3.2 保持の等級

lease は等級を 1 つ指定する。検証役は、等級の条件を満たしたときだけ `policy-satisfied` を出す。

| 等級 | 条件 | 耐えられる障害 | 耐えられない障害 |
|---|---|---|---|
| R0 | なし（現状） | なし | すべて |
| R1 運営者保持 | `operator-archive` 1 | 配信用 bucket の誤削除、運営者の操作ミス | B2 の account 喪失、運営者の支払い停止 |
| R2 混成 | `operator-archive` 1 と、`provider-node` 1 以上 | 上記に加え、B2 の喪失**または** node 1 台の喪失 | B2 と node の同時喪失 |
| R3 分散 | `provider-node` を独立した障害ドメインに 3 以上。`operator-archive` は任意 | node 1 台の喪失（修復の間も 2 複製が残る）、B2 の喪失 | 2 台を超える同時喪失 |

- R3 が ADR 0041 の目標に当たる。R1 と R2 は移行期の等級で、B2 を足場として使う。
- R3 の複製数 3 は推奨値で、owner の決定事項（§13 の 3）。storage architecture の G2 は独立 2 ノード、G4 は 3 以上の障害ドメインを受入の単位にしている。
- 条件を満たさない間は `degraded` と返す。成功条件を黙って緩めない（storage architecture §3）。

## 4. lease

保持の約束の単位。ADR 0031 の `pin` lease と同じ役割で、L1 ができるまでは署名つきの object として扱う。

```
YataverseRetentionLease(
  bytes32 leaseId,          // 下記
  bytes   subject,          // 単一 block は CID の binary、複数は inventory の commitment（32 bytes）
  uint64  size,             // 対象の bytes 数の合計
  bytes32 pieceCommitment,  // §7 の Merkle root。R1 だけの lease は 0
  uint8   grade,            // 1 = R1、2 = R2、3 = R3
  uint8   providerReplicas, // 要求する provider-node の数
  bytes32 domainPolicy,     // 障害ドメインの条件の版（policy の CID の digest）
  uint64  notBefore,        // 開始（Unix ミリ秒）
  uint64  retentionUntil,   // 期限（Unix ミリ秒）
  uint32  challengePeriod,  // challenge の間隔（秒）
  bytes32 requester,        // 要求者の鍵の digest
  bytes32 verifier,         // この lease を検証する検証役の keyId
  bytes32 policyRevision)   // 判定規則の版
```

- **型:** 受領証と同じく EIP-712 の typed data とし、Ed25519 で digest に署名する（ADR 0031 D9、受領証の設計 §10 の決定 1）。domain は `name = "Awai Yataverse Retention Lease"`、`version = "1"`。
- **`leaseId`:** `leaseId` を 0 にした struct の hash。同じ内容の lease は同じ id になり、再送で二重に作られない。
- **署名者:** 要求者と検証役の両方。provider は lease ではなく、自分の受領証（§5）で引き受けを表す。
- **inventory:** 複数の block を 1 つの lease にまとめるときは、受領証の設計 §3.1 の block set digest と同じ並べ方（CID binary の昇順）の一覧を canonical DAG-CBOR にし、その sha256 を `subject` にする。private なデータでは、client が列挙して署名する（ADR 0041 D4）。
- **保存:** lease と inventory は DAG-CBOR の block として保存し、CID で読める。検証役は自分の保存先にも持つ（§6）。
- **期限:** 期限内だけを約束する。期限前の renew と、失敗の通知が要る（§10）。

## 5. 受領証の値（v1 の型は変えない）

受領証の型（`YataverseStorageReceipt`）は変えない。変わるのは値だけで、`storeClass` に 3 を足す。

| field | 入口（storeClass 1） | 運営者保持（storeClass 3） | provider node（storeClass 2） |
|---|---|---|---|
| 署名者 | 入口の鍵（既存） | **保持用の鍵**（入口の鍵と分ける） | その node の鍵 |
| `state` | 1 | 1 | 1 |
| `leaseId` | 0（既存どおり） | lease の id | lease の id |
| `pieceCommitment` | 0 | 0 | §7 の root |
| `retentionUntil` | **0 のまま** | Object Lock の期限 | lease の `retentionUntil` |
| `reservationId` | 0 | 0 | 予約を入れた段階でその hash |
| 読み戻し | 全 bytes | 全 bytes と、lock の mode・期限 | 全 bytes |

- **入口の受領証は今と同じ。** 既存の client と、保存済みの受領証はそのまま有効で、意味も変わらない。
- **`retentionUntil` が 0 でない受領証は、署名者自身の約束である。** 運営者保持では「lock の期限まで消せない」、provider では「lease の期限まで保持し、challenge に答える」。
- **`policy-satisfied`（state 10）は誰の受領証にも入れない。** 検証役が別の型で出す（§6）。入口や provider が名乗ったら拒否する（受領証の設計 §6 の 4）。
- **互換:** 今の `verify-receipt` は未知の `storeClass` を拒否する。3 を知らない古い client は、運営者保持の受領証を拒否する（fail closed）。入口の受領証の検証には影響しない。

## 6. 検証役と保持の状態

検証役は、provider と入口のどちらとも別の主体、別の process、別の鍵で動かす（ADR 0041 D2）。

**検証役の仕事:**

1. lease に署名し、記録する。
2. 受領証（storeClass 2 と 3）を集め、署名、`leaseId`、`subject`、`size`、期限を確かめる。
3. challenge を出し、応答を検証する（§7、§8）。
4. 等級の条件を満たすかを判定し、状態を署名して公開する。
5. 条件を割ったら、修復を指示する（§9）。

**状態の記録（検証役だけが出す）:**

```
YataverseRetentionStatus(
  bytes32 leaseId,
  bytes   subject,
  uint8   grade,
  uint8   status,           // 10 = policy-satisfied、20 = degraded、21 = repairing、30 = expired、31 = released
  uint8   providerReplicas, // 直近の窓で証明に成功した provider-node の数
  uint8   operatorCopies,   // lock を確認できた operator-archive の数
  bytes32 evidenceRoot,     // 根拠にした受領証と証明の CID の一覧の digest
  uint64  observedAt,
  uint64  validUntil,       // この記録を信じてよい期限。challengePeriod の 2 倍を上限にする
  bytes32 keyId, uint32 keyEpoch)
```

- **短い有効期限:** `validUntil` を過ぎた記録は「不明」として扱う。検証役が止まると、状態は自動的に「不明」になり、`policy-satisfied` のまま残らない。
- **読み方:** `GET /.well-known/yataverse-retention/<leaseId>` と、CID から lease を引く `GET /retention/<cid>`。入口は検証役の署名つきの記録を配るだけで、判定はしない（ADR 0031 D1 の「状態を持たない補助」）。
- **根拠の公開:** `evidenceRoot` の一覧と各根拠は block として読める。第三者が同じ判定をやり直せる。
- **初期の検証役:** pool ごとに 1 つの認可された coordinator とする（storage architecture §4「MON に相当する管理の扱い」）。検証役の高可用化は別の段階とし、この設計では「検証役が止まると状態が不明になる」ことだけを保証する。

## 7. provider node の証明（P1、PDP 型）

ADR 0041 D3 の P1 と ADR 0031 D7 の storage の確かめ方に従う。

- **piece commitment:** 対象の bytes を 4,096 bytes の leaf に分け、最後の leaf は 0 で埋める。leaf の hash は `sha256(0x00 ‖ leaf)`、節は `sha256(0x01 ‖ left ‖ right)`、葉の数が 2 の冪でないときは 0 の leaf の hash で埋める。複数 block の lease では、inventory の順に block ごとの root を葉にした木の root を `pieceCommitment` にする。
- **challenge:** 検証役が `challengePeriod` ごとに、乱数から（block の番号、leaf の番号）を選ぶ。provider は leaf と Merkle path を期限内に返す。
- **乱数源:** L1 ができるまでは、検証役が事前に公開した commitment の連鎖（`r_n = sha256(r_{n+1})` を逆順に開示）を使う。provider は次の challenge を予測できず、検証役も後から選び直せない。L1 ができたら L1 の乱数に替える（ADR 0031 D7）。他の選択肢は §13 の 5。
- **1 回の失敗では不合格にしない。** 決めた窓の中で連続して落としたときに、その複製を数から外す（ADR 0031 D7）。窓と回数は policy の版で固定する。
- **P1 の限界:** 証明の時点で bytes を持つことだけを示す。同じ主体が複数の node を名乗ることは防げない。初期は既知の pool と、障害ドメインの申告とその根拠の記録で補う（ADR 0041 D3、storage architecture §4）。
- **parameter は試作で確定する。** leaf の大きさ、domain separation、埋め方は上記を案とし、ADR 0041 実装順 2 の試作で test vector と負の対照（leaf の欠落、改ざん、別の piece での応答、期限後の応答）を置いてから固定する。

## 8. 運営者保持（B2）の確かめ方

B2 は challenge に答える主体ではないので、PoSt は使わない。検証役が次を行う。

| 確認 | 方法 | 頻度 |
|---|---|---|
| 存在と大きさ | 保持用 bucket への読み取り専用の鍵で、object の存在と長さを読む | lease ごとに `challengePeriod` |
| lock | object の retention を読み、mode が compliance で、期限が lease の `retentionUntil` 以上であることを確かめる | 同上 |
| 内容 | 全 bytes を読み、sha256 を CID と比べる | 抜き取り。割合は費用を測って決める |

- 検証役の鍵は読み取り専用にする。書込みと lock の延長は Worker の鍵だけができる。
- **この確認が示すこと:** その時点で、lock つきの object が運営者の account にあること。
- **示さないこと:** B2 の内部の複製数、account が将来も有効であること。これらは運営者の約束として policy に書き、証明とは呼ばない。
- 費用（保存、読み出し、API 呼び出し）は実測する。この設計では見積もっていない。

## 9. 障害と対処

| 障害 | 検知 | 対処 | 等級への影響 |
|---|---|---|---|
| 配信用 bucket から block が消えた | 読み出しの失敗 | provider node、次に保持用 bucket から読み、CID を検証して配信用に戻す | なし（数えていない） |
| 保持用 bucket の object がない、lock が短い | §8 の確認 | 残っている複製から書き直す。できなければ `degraded` | R1 は不成立、R2 は `degraded` |
| B2 の account が使えない | §8 の確認がすべて失敗 | R2 は provider node の複製を増やす lease の変更を要求者に通知する | R1 は不成立、R2 は `degraded`、R3 は影響なし |
| provider node が challenge を落とし続ける、離脱する | §7 の窓 | 別の障害ドメインの node に複製を作り、新しい受領証と証明を確かめてから数に入れる。旧複製の解放はその後（storage architecture §4） | 修復の間は `repairing` |
| すべての provider node が離脱 | 同上 | R2 は保持用 bucket から新しい node へ複製する。R3 で保持用 bucket がなければ、要求者の手元のコピーが最後の手段 | R3 は不成立 |
| 検証役が止まる | `validUntil` の超過 | 状態は「不明」になる。読み出しは続く。新しい lease、renew、release は受けない | 不明 |
| Cloudflare が止まる | 入口に届かない | provider node へ直接読みに行く（lease の記録に node の接続先の hint を持つ）。B2 の保持用 bucket は運営者だけが読める | なし |
| lease が renew されない | 期限 | `expired`。provider は解放してよい。保持用 bucket は lock が切れた後、他の lease が同じ CID を指していなければ消す | 期限後は約束なし |
| 署名鍵の漏洩 | 鍵の失効の記録 | 失効後の時刻を名乗る受領証と状態の記録を無効にする（受領証の設計 §5） | 根拠から外して再判定 |
| 削除の要請（権利侵害、違法な内容、誤って書いた個人情報） | 運営者への申し立て | 配信を止める（入口で拒否）。compliance mode の object は期限まで消せない | 下記 |

**削除できないことについて。** compliance mode は運営者も消せない。これは保持の約束の根拠であり、同時に、消すべきものを消せない危険でもある。対処:

- 保持用 bucket に入れる前に、lease の要求者を認証し、内容の種類を lease に記録する。
- 最初の対象は公開統計などの公開データと、client が暗号化した暗号文に限る（暗号文は鍵を捨てれば読めなくなる）。
- lock の期限を短くし（例: 90 日）、renew で延ばす。誤って入れたものが残る期間を限る。
- governance mode（権限のある鍵で外せる）を選ぶ案は §13 の 2。

## 10. lease の一生

```
要求 → 受領証の収集 → policy-satisfied ⇄ degraded / repairing
                              ↓ renew（期限の延長）
                              ↓ release または期限
                        released / expired → 解放
```

- **作成:** 要求者が lease を作って署名し、bytes を入口に書く（既存の PUT / CAR）。入口は等級に応じて保持用 bucket と provider node に渡す。検証役が受領証を集め、条件を満たした時点で `policy-satisfied` を出す。それまでは `degraded`（未達）と返す。
- **renew:** 期限の前に、要求者が新しい `retentionUntil` の lease を出す。運営者保持は lock の期限を延ばし（B2 は延長だけができる）、provider は新しい期限の受領証を出す。
- **release:** 要求者が署名した解放。provider は解放してよい。保持用 bucket の lock は短くできないので、release は「以後 renew しない」ことを意味し、object は lock の期限まで残る。
- **解放の条件:** 同じ CID を指す有効な lease が他にないことを確かめてから消す（storage architecture §3 の `renew / release`）。
- **冪等性:** lease、renew、release は `leaseId` と request id で重複を判定し、再送で二重の予約や不正な解放が起きないようにする（storage architecture §3）。

## 11. 利用者から見た使い方

- **書く:** `yataverse put <file> --lease-grade R2 --until <date>`（案）。応答は入口の受領証と `leaseId`。
- **確かめる:** `yataverse retention-status <cid|leaseId>`（案）。検証役の署名、`validUntil`、等級、数を検査し、根拠の受領証と証明も検証できる。
- **git-annex / datalad:** 参照先の URL は今と同じ `https://yataverse.com/ipfs/<cid>`（AWAI-3666 で実証）。repo には CID の一覧に加えて `leaseId` を記録する。
- **git から実体を外してよい条件（推奨）:**
  1. その CID の lease が R2 以上で、`retentionUntil` が外す時点から十分先にある。
  2. 検証役の状態が `policy-satisfied` で、`validUntil` が切れていない。
  3. 別の clone から `datalad get` で取得し、内容を照合した記録がある。
  4. renew の担当と期限の前の確認の手順が決まっている。
  
  再取得できる公開統計に限り R1 で外してよいとする案は §13 の 4。

## 12. 既存文書との食い違い（報告）

| 文書 | 記述 | この設計での扱い |
|---|---|---|
| ADR 0041 D6（Proposed） | Cloudflare と B2 は「縁」で、保持の正本にせず、証明の対象にも数えない | 配信用 bucket はそのとおり数えない。保持用 bucket は「運営者の保持コピー」として**別の欄で数える**。独立複製には数えず、PoSt の対象にもしない。R1 と R2 の間は、B2 が事実上の保持コピーになる。D6 の文言の改定が要る |
| ADR 0041「採らなかった案」 | B2 などの集中保存を正本として続ける案は採らない | 目標（R3）では B2 は任意で、正本ではない。R1 と R2 は移行期の等級として期限つきで置く。移行期をいつ終えるかは owner の決定（§13 の 6） |
| ADR 0031 D1（accepted） | Cloudflare に正本を置かない。Workers は状態を持たない補助に限る | 変えない。入口は検証役の署名つきの記録を配るだけで、lease の状態を持たない。B2 は Cloudflare の製品ではない |
| 受領証の設計 §3.1 | `storeClass` は 1 と 2 | 3（`operator-archive`）を足す。型は変えない |
| storage architecture §3 | 構成要素に「Kura」の行がある | ADR 0041 D2（案 B）に従い「保存層の検証役」と読む。改定は ADR 0041 の改定表のとおりで、まだ反映されていない |
| storage architecture §8 | 既存の B2 運用の資格を独立ノード耐久性の証明に流用しない | 守る。B2 の確認（§8）は独立複製の証明と呼ばない |

## 13. owner の決定事項

| # | 決めること | 推奨 | 他の選択肢 |
|---|---|---|---|
| 1 | B2 の保持用 bucket を「運営者の保持コピー」として数えるか（ADR 0041 D6 の改定） | 数える。独立複製とは別の欄にし、R1 と R2 を移行期の等級とする | 数えない。保持の約束は provider node が揃うまで出さない（その間、実体は git に残す） |
| 2 | Object Lock の mode | compliance。運営者も消せないことが約束の根拠になる。期限を短くして renew する | governance。削除の要請に応じられるが、「運営者が消せない」とは言えなくなる |
| 3 | R3 の複製数 | 3（障害ドメインは別の主体・別の場所） | 2（storage architecture G2 と同じ。修復中は 1 複製になる） |
| 4 | git から実体を外してよい等級 | R2 以上。再取得できる公開統計も同じ扱い | 公開統計に限り R1 で外す（出典から取り直せるが、出典は改訂されるので同じ bytes は戻らない。AWAI-3640 で改訂を確認済み） |
| 5 | L1 ができるまでの challenge の乱数源 | 検証役の commitment の連鎖（外部への依存なし） | 公開の乱数 beacon（外部サービスへの依存が増える）。検証役が毎回選ぶだけ（provider と結託すると選び直せる） |
| 6 | 移行期（R1、R2）の終わり | 3 つの独立した provider node で R3 の受入（§14 の S3）が通った時点で、新しい lease の既定を R3 にする。R1 と R2 は選べるまま残す | 期日で終える。または終えない |
| 7 | 最初の provider node | 会社の管理する既知の 2 台（別の場所、別の回線）から始める。機器は owner が選ぶ | 最初から外部の参加者を入れる（Sybil と障害ドメインの確認が先に要る） |
| 8 | 保持用 bucket の置き場所 | 配信用と同じ account の別 bucket から始める | 別の account・別の region（B2 の複製は region が違うと別 account が要る。account の喪失に強くなるが、運用が増える） |

## 14. 段階と受入

| 段階 | 内容 | 完了と数える証拠 | この段階でできること |
|---|---|---|---|
| S0（現状） | 入口と配信用 bucket | 済み（受領証 v1） | R0。git が永続コピー |
| S1 | 保持用 bucket、Object Lock、`storeClass 3` の受領証、lease の型と署名、検証役の最小実装（§8 の確認と状態の公開） | lock の期限前の削除と上書きが失敗すること。lock の期限が lease より短い object を検証役が不合格にすること。検証役を止めると状態が「不明」になること。古い client が `storeClass 3` を拒否すること | R1 |
| S2 | 既知の独立 2 ノード、P1 の試作と検証（ADR 0041 実装順 2・3、storage architecture G2） | 負の対照（leaf の欠落、改ざん、別の piece での応答、期限後の応答）がすべて失敗すること。片側の node を止めると `degraded` になり、修復後に戻ること。B2 を読めなくしても R2 が `degraded` で読み出しは続くこと | R2。**git から実体を外す判断はここから**（§13 の 4） |
| S3 | 3 以上の障害ドメイン、修復と再配置、解放（storage architecture G4） | node 1 台の喪失からの修復。保持用 bucket なしで R3 が成り立つこと。stale な配置 epoch の拒否 | R3。B2 は任意 |
| S4 | L1 の lease、EN の決済、YATA の担保 | ADR 0031 / 0041 の条件 | 市場 |

各段階は別の issue と PR にする。本番の bucket、鍵、deploy は、段階ごとに owner の承認を得てから行う。

## 15. この設計で確かめていないこと

- B2 の Object Lock を実際に操作していない。§3.1 の仕様は公式文書の記述による。S3 互換 API での lock の header と、必要な鍵の権限の名前は S1 で確かめる。
- B2 の費用、保持用 bucket への二重書きによる書込みの遅延、Worker の実行時間の上限への影響は測っていない。
- P1 の parameter（leaf の大きさなど）は案で、test vector がない。
- provider node の実装は存在しない。ADR 0041 は Proposed のままである。
- account の閉鎖や支払いの停止が lock 中の object に与える影響は不明。
