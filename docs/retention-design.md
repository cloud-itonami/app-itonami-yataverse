# 保持の設計: 分散型の provider node と B2

- Status: **owner 決定済み**（2026-11-21。§13 の 8 件すべて推奨案を採用）。この文書は設計で、実装、bucket の作成、鍵の発行、課金の変更は含まない。それぞれ §14 の段階ごとに別の承認を得る。
- Owner direction（2026-11-21）:「yataverse.com で保持設計を分散型 + b2 で設計して」。
- Tracking: [AWAI-3667](https://linear.app/kotobalabs/issue/AWAI-3667)（親 [AWAI-3618](https://linear.app/kotobalabs/issue/AWAI-3618)）。
- 位置づけ: [受領証の設計](storage-receipt-design.md) §8 の「lease を入れる段階」と、[ADR 0041](https://github.com/network-awai/network-awai-apex/blob/main/docs/adr/0041-yataverse-proof-of-storage-network.md)（Proposed）の P1 を、B2 を併用する移行期つきで具体化する。
- 既存文書との食い違いは §12 にまとめた。ADR 0041 D6 の改定は network-awai-apex の別の PR で行う。

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

### 3.1 B2 の bucket は 1 つ、lock はファイル単位

**改定（owner 決定 2026-11-21、[AWAI-3673](https://linear.app/kotobalabs/issue/AWAI-3673)）:** 保持用の bucket を新しく作らない。既存の `yataverse-blocks` で Object Lock を有効にし、lease のあるファイルにだけ lock をかける。当初の案（配信用と保持用の 2 つの bucket、§13 の決定 8）は、同じ bytes を二重に持つことになるので採らない。 この文書の他の節にある「保持用 bucket」は「`yataverse-blocks` のうち lock をかけたファイル」、「配信用 bucket」は「lock のないファイル」と読む。

| ファイルの状態 | 意味 | 数え方 |
|---|---|---|
| lock なし（今あるすべてのファイル） | 入口の保存先。運営者が消せる | 数えない（`storeClass 1`） |
| compliance の lock つき、期限は lease の `retentionUntil` 以上 | 期限まで誰も消せない | 運営者の保持コピー（`storeClass 3`） |

- 「運営者も消せない」を保証するのは compliance の lock で、bucket や鍵の分離ではない。master key でも削除、期限の短縮、mode の変更、lock の解除はできなかった（§16 の実測）。
- lock をかける権限（`writeFileRetentions`）は、入口の通常の書込みに使う鍵と分けることを推奨する。入口が侵害されても、勝手に長い lock をかけられないようにするため。
- bucket に既定の保持期間は設定しない。設定すると、lease のない書込みにも lock がかかる。
- B2 の仕様（2026-11-21 に公式文書で確認、§16 で実測）: compliance mode の lock は誰も外せず、期限の延長だけができる。Object Lock は一度有効にすると無効にできない。既存 bucket でも有効にでき、既存のファイルには lock がかからない。
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

## 13. owner の決定（2026-11-21: すべて推奨案）

決定 7 の機器（最初の 2 台の provider node）は未定で、S2 の着手前に owner が選ぶ。

| # | 決めること | 推奨 | 他の選択肢 |
|---|---|---|---|
| 1 | B2 の保持用 bucket を「運営者の保持コピー」として数えるか（ADR 0041 D6 の改定） | 数える。独立複製とは別の欄にし、R1 と R2 を移行期の等級とする | 数えない。保持の約束は provider node が揃うまで出さない（その間、実体は git に残す） |
| 2 | Object Lock の mode | compliance。運営者も消せないことが約束の根拠になる。期限を短くして renew する | governance。削除の要請に応じられるが、「運営者が消せない」とは言えなくなる |
| 3 | R3 の複製数 | 3（障害ドメインは別の主体・別の場所） | 2（storage architecture G2 と同じ。修復中は 1 複製になる） |
| 4 | git から実体を外してよい等級 | R2 以上。再取得できる公開統計も同じ扱い | 公開統計に限り R1 で外す（出典から取り直せるが、出典は改訂されるので同じ bytes は戻らない。AWAI-3640 で改訂を確認済み） |
| 5 | L1 ができるまでの challenge の乱数源 | 検証役の commitment の連鎖（外部への依存なし） | 公開の乱数 beacon（外部サービスへの依存が増える）。検証役が毎回選ぶだけ（provider と結託すると選び直せる） |
| 6 | 移行期（R1、R2）の終わり | 3 つの独立した provider node で R3 の受入（§14 の S3）が通った時点で、新しい lease の既定を R3 にする。R1 と R2 は選べるまま残す | 期日で終える。または終えない |
| 7 | 最初の provider node | 会社の管理する既知の 2 台（別の場所、別の回線）から始める。機器は owner が選ぶ | 最初から外部の参加者を入れる（Sybil と障害ドメインの確認が先に要る） |
| 8 | 保持用 bucket の置き場所 | ~~配信用と同じ account の別 bucket から始める~~ → **改定（2026-11-21）: 新しい bucket を作らず、既存の `yataverse-blocks` でファイル単位の lock を使う（§3.1）** | 別の bucket、または別の account・別の region（account の喪失に強くなるが、二重の保存と運用が増える） |

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

- ~~B2 の Object Lock を実際に操作していない。~~ 2026-11-21 に `yataverse-blocks` で確かめた（§16 の S1-2a）。
- B2 の費用、保持用 bucket への二重書きによる書込みの遅延、Worker の実行時間の上限への影響は測っていない。
- P1 の parameter（leaf の大きさなど）は案で、test vector がない。
- provider node の実装は存在しない。ADR 0041 は Proposed のままである。
- account の閉鎖や支払いの停止が lock 中の object に与える影響は不明。

## 16. 実装の記録

- **S1-1 型と検証（[AWAI-3670](https://linear.app/kotobalabs/issue/AWAI-3670)）:** `src/retention.mjs`（lease、状態、inventory、受領証を lease に数える判定）と、`src/receipt.mjs` の `storeClass 3` の規則。依存は足していない。store、bucket、network は使わない。Worker と CLI の command は変えていない。
  - **鍵の用途:** 公開する鍵の一覧の各 entry に `use`（文字列の配列）を足した。値は `gateway-receipt`、`provider-receipt`、`operator-archive-receipt`、`retention-verifier`。`use` のない entry は `gateway-receipt` だけとして扱う。今の鍵の一覧には `use` がないので、今の入口の鍵は保持の約束にも検証役にも使えない（fail closed）。
  - **受領証の規則（§5 の具体化）:** 入口（storeClass 1）は `retentionUntil` が 0 でなければ拒否する。storeClass 2 と 3 は `leaseId` が 0 でなく、`retentionUntil` が `acceptedAt` より後であること。storeClass 2 は `pieceCommitment` が必須、storeClass 3 は 0 であること。どの store class の受領証も `policy-satisfied` を名乗れない。
  - **lease の署名:** `requester` は要求者の Ed25519 公開鍵の keyId（受領証の `keyId` と同じ計算）。要求者の公開鍵は envelope に入れて運び、keyId が `requester` と一致することを確かめる。検証役の鍵は公開された一覧から引き、`retention-verifier` の用途を持ち、lease の `notBefore` の時点で有効であることを確かめる。lease は署名した時刻を持たないので、鍵の有効性は `notBefore` で判定する。
  - **`leaseId`:** `leaseId` を 0 にした struct の `hashStruct`。署名の対象は、`leaseId` を入れた struct の EIP-712 digest。他人の `leaseId` を持つ lease は署名も検証もしない。
  - **等級と条件:** R1 は `providerReplicas` 0 かつ `pieceCommitment` 0。R2 は `providerReplicas` 1 以上、R3 は 3 以上で、どちらも `pieceCommitment` が必須。
  - **状態の検証:** 状態の署名者は lease の `verifier` と同じ鍵であること。`validUntil − observedAt` は `challengePeriod` の 2 倍まで。読む側の時刻が `validUntil` 以降なら `status-stale` で拒否する（状態は不明）。`observedAt` は読む側の時刻より 5 分を超えて先であってはならない。`policy-satisfied` は、状態が持つ数が等級の条件を満たし、`observedAt` が lease の期間内のときだけ通す。provider node の数と運営者保持の数は合算しない。
  - **inventory:** canonical DAG-CBOR の `{"v": 1, "blocks": [CID link, …]}`（CID binary の昇順、重複なし）の sha256 を lease の `subject` にする。
  - **確認（2026-11-21）:** `npm test` は 126 件すべて通過（既存 113、追加 13）。変更前の `main`（`0fe6f74`）の code は、`storeClass 3` の受領証を `unknown-store-class` で拒否した（一回限りの確認）。検査 7 か所を 1 つずつ外すと、どれも test が失敗した。
  - **未実装:** 保持用 bucket、`storeClass 3` の受領証の発行、検証役の process、状態の公開、CLI の command、P1 の piece commitment と challenge。EIP-712 の digest を外部の参照実装と照合した test vector は、この 2 つの型にはまだない。
- **S1-3 検証役の最小実装（[AWAI-3671](https://linear.app/kotobalabs/issue/AWAI-3671)）:** `src/verifier.mjs`（1 回の実行: lease と受領証の検証、保持用 bucket の確認、判定、状態への署名、根拠の記録）、`src/archive-probe.mjs`（S3 互換 API の読み取りだけを行う probe）、command `yataverse retention-verify-once`。SigV4 の署名は `worker/src/sigv4.mjs` から `src/sigv4.mjs` に移し、Worker 側は再 export にした。依存は足していない。
  - **数え方:** 運営者の保持コピーは、lease のすべての block について「lease に数えられる `storeClass 3` の受領証」と「bucket の確認の合格」が揃ったときだけ 1 と数える。確認は、存在、大きさ（受領証の `size` と一致）、lock の mode が `COMPLIANCE`、lock の期限が lease の `retentionUntil` 以上。`--sample-read true` のときは全 bytes を読んで受領証の `contentDigest` と比べる。全読みをしない場合、根拠の記録に `read: false` と残る。
  - **provider node は数えない。** P1 の証明が未実装なので、provider の複製は常に 0 と数える。R2 と R3 の lease は、bucket の確認が通っても `degraded` になり、その理由が根拠の記録に残る。
  - **状態:** lease の期限以降は `expired`、開始前は `degraded`、それ以外は等級の条件で `policy-satisfied` か `degraded`。`validUntil` は `observedAt` から `challengePeriod` の 2 倍で、`policy-satisfied` のときは lease の期限を超えない。
  - **状態を出さない場合:** lease が検証を通らないとき、署名鍵が lease の `verifier` でないとき。数えられない受領証や bucket の確認の失敗では止まらず、`degraded` の状態と理由を出す。
  - **根拠の記録:** canonical DAG-CBOR の `{v, leaseId, observedAt, receipts: [受領証の record の CID], checks: [...], notes: [...]}`。状態の `evidenceRoot` はその sha256。
  - **鍵の扱い:** 署名鍵は file から読む。所有者以外が読める file は使わない。保持用 bucket の資格情報は環境変数（`YATAVERSE_ARCHIVE_KEY_ID`、`YATAVERSE_ARCHIVE_APP_KEY`）から読む。どちらも出力しない。probe は HEAD と GET だけを送る。
  - **確認（2026-11-21）:** `npm test` は 135 件すべて通過（既存 126、追加 9）。検査 8 か所を 1 つずつ外すと、どれも test が失敗した。
  - **未確認・未実装:** 本物の B2 bucket に対しては一度も実行していない。HEAD の応答に lock の header（`x-amz-object-lock-mode`、`x-amz-object-lock-retain-until-date`）が含まれるか、どの鍵の権限が要るかは、bucket を作ってから確かめる。状態と根拠の公開（§6 の endpoint）、定期実行、検証役を別の主体として動かす運用は未実装で、command は結果を出力するだけである。
- **S1-2a Object Lock の有効化と実測（[AWAI-3673](https://linear.app/kotobalabs/issue/AWAI-3673)、2026-11-21）:** owner の承認を得て、`yataverse-blocks` で Object Lock を有効にした（`b2_update_bucket` の `fileLockEnabled: true`、revision 2 → 3）。既定の保持期間は設定していない。この操作は戻せない。
  - **有効化の前後:** 複製の設定なし、lifecycle rule なし、暗号化 SSE-B2 は変わらない。有効化の後も、yataverse.com 経由の既存 block の読み出しと、既に書いた内容の再書き込みは成功した（受領証は従来どおり `storeClass 1`、`retentionUntil` 0）。
  - **試験ファイル:** `retention-test/bafkreifvebjgohuatxem7xjaczvxcrcr6zitxu3dohi6s6jgvbqdgaz3pa`（50 bytes）を compliance、期限 2026-11-22T06:21:50Z で置いた。期限まで消せないので、期限の後に消す。
  - **lock の実測（master key で実行）:** その version の削除は拒否された（`bypassGovernance` を付けても同じ）。期限の短縮、governance への変更、lock の解除も拒否された。期限の延長は成功した。
  - **version についての発見（設計に影響する）:**
    - 同じ名前に lock なしで書き直すと、lock のない新しい version ができ、名前での参照はその新しい version を返す。lock された古い version は残る。入口は再送のたびに保存をやり直すので、lock をかけた後に同じ block が書き直されると、名前で見た lock は「なし」になる。
    - 名前を隠す操作（S3 の version 指定なしの DELETE に当たる）は成功し、名前では見えなくなる。lock された version は残り、隠す印を消すと元に戻る。
    - したがって、**lock の確認は名前ではなく version を指して行う必要がある。** 受領証の発行（S1-2b）で、lock をかけた version の id を記録し、検証役がその version を確認する形にする。今の検証役は名前で見るので、上の 2 つの場合に `degraded` と判定する（安全側の誤りで、`policy-satisfied` を誤って出すことはない）。
  - **S3 互換 API の応答:** HEAD は `x-amz-object-lock-mode`（値は `COMPLIANCE`）、`x-amz-object-lock-retain-until-date`（ISO 8601）、`x-amz-version-id` を返した。lock のないファイルではこれらの lock の header がない。
  - **鍵:** 検証役用に、この bucket だけに絞った読み取り専用の application key `yataverse-retention-verifier-ro` を作った（権限は `readFiles` と `readFileRetentions`）。この 2 つで HEAD の lock の header と GET が読めた。存在しないファイルへの HEAD は 404 ではなく 403 になる（一覧の権限がないため）。検証役はこれを確認の失敗として扱い、`degraded` と判定する。
  - **検証役の実行（本物の B2、鍵と lease と受領証はその場かぎりの試験用）:** lease の期限が lock より前なら `policy-satisfied`（全読みの digest も一致）。lease の期限が lock より後なら `degraded`（`lock-ends-before-the-lease`）。lock のない本番の block は `degraded`（`not-locked`）。bucket にない block は `degraded`（`probe-failed:head-http-403`）。
  - **この段階で残っているもの:** Worker が lock をかける実装と `storeClass 3` の受領証の発行（S1-2b）、version を指した確認、入口の鍵の絞り込み（今この bucket に届く application key は、全 bucket 対象でほぼ全権限の 1 つだけ。Worker がどの鍵を使っているかは未確認）。
