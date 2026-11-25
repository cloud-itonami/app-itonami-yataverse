# 充足一覧: 保持の設計 (retention-design) × 現物実装 (item 216)

- 対象設計: [retention-design.md](retention-design.md)（owner 決定 2026-11-21）。本書は設計の充足を「設計が求めるもの / 現物で確かめた実装の有無 (commit/file:line) / 不足 / 段階ごとに要る owner 承認」として表にする。
- 照合した現物: `main` の `3665a52`（2026-11-25 時点）。数値は設計と `src/retention.mjs` / `worker/src/index.mjs` の常量を引用する。
- tracking: Organizer item 216「契約台帳の原本を E2EE で分散保存」(Yataverse 側)。本書は docs のみで、bucket・鍵の新規作成、Object Lock の有効化、deploy はしない（§14 の段階ごとに別承認）。
- 推測は「未確認」と明示する。

## 0. 要旨

- R1 の型と判定は実装済み。R1 の本番経路（Worker の lease つき書込み・受領証・検証役の巡回）は code までで、deploy と本番鍵の公開は未実施（設計 §16 S1-2b/S1-5 記載）。
- provider node の実装は存在しない。R2/R3 の lease は型として通るが、`providerReplicas` は検証役が常に 0 と数えるため `policy-satisfied` にはならない（`src/verifier.mjs:118,134`）。
- PoSt の piece commitment 計算・challenge・provider 側の保持が未実装。修復（`repairing`）は状態値の定義だけで、発行も再配置もない。
- 本 PR で足したのは、drive-pack の個人データ分離原案（`/awai-drive/v1/e2ee-packs/<sha256>`、tenant Bearer 必須、別 namespace、code + stub test まで）だけである。

## 1. 等級ごとの充足一覧

| 等級 | 設計が求めるもの (§3.2) | 現物で確かめた実装 (file:line) | 不足 | 段階で要る owner 承認 |
|---|---|---|---|---|
| R0 | なし（現状）。受領証は `state 1 / storeClass 1 / retentionUntil 0` | `src/receipt.mjs:29` `STORE_CLASS.edgeGateway = 1`。入口の受領証が `retentionUntil` 0 でないと拒否される規則 `src/receipt.mjs:181-186` | なし（定義どおり） | なし |
| R1 運営者保持 | `operator-archive` 1。lease の期限まで削除も上書きもできない | lease の型・署名・検証 `src/retention.mjs:132-205`。`gradeSatisfied` R1 は `operatorCopies >= 1` `src/retention.mjs:287`。lease つき書込み（compliance lock・90 日上限）`worker/src/index.mjs:383-427`（上限 `worker/src/index.mjs:373` `DEFAULT_ARCHIVE_MAX_LOCK_DAYS = 90`）。bucket 確認 `src/archive-probe.mjs:24-63`、検証役の 1 回実行 `src/verifier.mjs:89-158`、状態の公開・取得 `worker/src/index.mjs:446-505`、CLI `src/cli.mjs:364-438`（`lease-new` は R1 のみ、`src/cli.mjs:374`） | Worker の deploy（B2_LOCK 鍵・保持用署名鍵・検証役鍵の公開）は未実施（設計 §16 S1-2b「deploy の前に要るもの」）。検証役を入口と別主体で動かす運用は未設置（設計 §16 S1-5「未実装・未決定」）。複数 block の lease の書込みは未対応（worker は単一 block の subject のみ、`worker/src/index.mjs:393`） | S1: lock 用 application key、保持用の署名鍵と公開、検証役の鍵の公開、Worker の deploy（それぞれ owner 承認。設計 §16 S1-2b） |
| R2 混成 | `operator-archive` 1 と `provider-node` 1 以上。B2 喪失または node 1 台の喪失に耐える | lease の型は R2 を受ける（`providerReplicas >= 1`、piece commitment 必須 `src/retention.mjs:147`）。`gradeSatisfied` R2 `src/retention.mjs:288`。provider 受領証の数え方 `src/retention.mjs:362-375` | provider node の実装が存在しない（`grep -rn provider src/ worker/src/` で保持側の実装は無し）。検証役は provider の複製を数えない（`src/verifier.mjs:118,134`）ので R2 は常に `degraded`。provider 用の鍵の用途 `provider-receipt` の公開鍵は未確認 | S2: 既知の独立 2 ノードの選定（機器は owner が選ぶ。設計 §13 決定 7）、P1 の試作と test vector、負の対照（leaf 欠落・改ざん・別 piece・期限後応答）の受入 |
| R3 分散 | `provider-node` を独立した障害ドメインに 3 以上（最小 3。`src/retention.mjs:43` `R3_MIN_PROVIDER_REPLICAS = 3`、設計 §3.2・§13 決定 3）。`operator-archive` は任意 | 同上。R3 の型と `gradeSatisfied`（`src/retention.mjs:289`、`max(R3_MIN_PROVIDER_REPLICAS, lease.providerReplicas)`） | R2 の不足に加え、障害ドメインの記録（`domainPolicy` の運用）の実装なし。修復・再配置・解放（§9・§10）の実装なし（下表） | S3: 3 以上の障害ドメインの選定と根拠の記録、修復と再配置、解放手順、stale epoch 拒否の受入。新しい lease の既定を R3 にするかは §13 決定 6 の owner 決定 |

## 2. 構成要素ごとの充足一覧

| 要素 | 設計が求めるもの | 現物で確かめた実装 (file:line) | 不足 | 段階で要る owner 承認 |
|---|---|---|---|---|
| lease | §4 の型。EIP-712 + Ed25519、要求者と検証役の 2 署名、`leaseId` は 0 を入れた struct の hash | `src/retention.mjs:20-28`（型・domain）、`:132-205`（判定・署名・検証）、`:153-161`（`leaseIdFor`） | EIP-712 digest の外部参照実装との test vector は無い（設計 §16 S1-1「未実装」） | S1 の deploy 時（検証役の鍵の公開と一体） |
| provider-node | §3 の `storeClass 2`。node が lease の期限まで piece を保持し、受領証で引き受ける | 受領証の規則だけ：`src/receipt.mjs:187`（provider は `pieceCommitment` 必須）。`receiptCountsFor` の provider 分 `src/retention.mjs:369-373` | node の実装そのものが存在しない。保持・受領証の発行・接続先 hint（§9 Cloudflare 停止時）なし | S2（2 台の選定）、S3（3 台以上）。機器選定は owner（§13 決定 7） |
| 検証役 | §6。provider と入口のどちらとも別主体・別 process・別鍵。lease への署名、受領証の収集、challenge、状態の署名と公開、修復の指示 | 最小実装だけ：`src/verifier.mjs:89-158`（1 回の実行）。状態の publish/serve `worker/src/index.mjs:446-505`。巡回 `src/cli.mjs:437-`（`retention-verify-sweep`） | 別の主体として動かす運用は未設置（設計 §16 S1-5）。状態の有効期限は `challengePeriod` の 2 倍まで（`src/retention.mjs:45` `STATUS_MAX_VALIDITY_PERIODS = 2`、設計 §6）。高可用化は未着手 | S1: 検証役をどの機器で動かすか（owner が決める。設計 §16 S1-5）。巡回登録の手順 |
| PoSt (P1) | §7。piece commitment（4,096 bytes leaf、Merkle root）、`challengePeriod` ごとの乱数 challenge、応答検証、窓の中の連続失敗で数から外す | なし。`pieceCommitment` は lease・受領証の field として型だけ存在（`src/retention.mjs:22`）。leaf の大きさ・domain separation を試作する code は存在しない（repo 全体を `grep` し、該当する PoSt 実装は無し） | 計算、challenge、乱数源（commitment 連鎖。設計 §13 決定 5）、test vector と負の対照、すべて未実装 | S2: parameter の確定は試作の後（設計 §7）。実装順 2・3 |
| 修復 | §9。challenge を落とし続ける node から別の障害ドメインへ複製を作り、新しい受領証と証明を確かめてから数をに入れ、旧複製の解放はその後。修復の間は `repairing` | 状態値の定義だけ：`src/retention.mjs:41` `STATUS.repairing = 21`。検証役が `repairing` / `released` を出す経路は存在しない（`grep -n repairing src/verifier.mjs` は 0 件。`expires` のみ判定 `src/verifier.mjs:138`） | 修復の指示、再配置、解放（renew/release の実行）の実装なし | S3: 修復と再配置、解放の受入（§14 S3） |

## 3. provider node 候補（障害ドメインごと）

### 3.1 既存 fleet は独立複製として数えられない

既存 fleet（jacob + mini 201–210）は同一 LAN・同一主体である。設計定義では数えられない：

- §3.2 の R3 は「独立した障害ドメインに 3 以上」。§13 決定 3 は「障害ドメインは別の主体・別の場所」。
- §7 の P1 の限界：「同じ主体が複数の node を名乗ることは防げない。初期は既知の pool と、障害ドメインの申告とその根拠の記録で補う」。
- §3 の数え方：「種類ごとに別々に数え、合算しない」。同一主体・同一場所の複製は 1 障害ドメインとして数える対象になる。

したがって現 fleet だけで R2 の「provider-node 1 以上」を満たしたことにはならない。

### 3.2 数えるための条件（根拠として記録する）

障害ドメインを 1 つとして数えるには、少なくとも次を記録し、検証役が `domainPolicy`（lease の field、`src/retention.mjs:23`）の版に照らして確かめる：

1. 別主体 — 運営主体（アカウント・鍵の管理者）が別であること。同一主体の複数名乗りは P1 で防げないため（§7）。
2. 別場所 — 建物・サイトが別であること（火災・停電・入室の障害が別）。
3. 別回線 — アクセス回線（プロバイダ・入口）が別であること。
4. 別電源 — 電源系（ブレーカー・UPS・発電）が別であること（回線と同条件の根拠として記録）。
5. 上記の申告と根拠（契約・回線契約・設置場所の記録）を lease の `domainPolicy` の版に紐付け、検証役の根拠の記録（`src/verifier.mjs:143-145` の evidence）に残すこと。

### 3.3 候補の有無

- **候補は無い。** 設計 §13 決定 7 は「最初の provider node」を「会社の管理する既知の 2 台（別の場所、別の回線）から」とし、「機器は owner が選ぶ（未定）」としている。2026-11-25 時点で選定の記録は無い。
- 最初から外部の参加者を入れる選択肢（§13 決定 7 の別案）は未着手。Sybil と障害ドメインの確認が先に要る。
- 本 PR では候補を選ばない。S2 の開始前に owner が選ぶ（§14 S2 の受入条件）。

## 4. drive-pack の個人データ分離原案（本 PR の実装）

方針：「E2EE pack だけを認証必須に分離し、2026-11-18 の認証なし決定は平文 pack には残す」。

| 項目 | 内容 |
|---|---|
| 新経路 | `PUT/GET/HEAD/OPTIONS /awai-drive/v1/e2ee-packs/<sha256>`。平文経路 `/awai-drive/v1/packs/<sha256>` は変更しない（`worker/src/drive-packs.mjs` の既存 handler は無改変。追加だけ） |
| 認証 | tenant Bearer。`DRIVE_E2EE_TOKEN_SHA256`（SHA-256 hex のカンマ区切り。`WRITE_TOKEN_SHA256` と同形）。未設定は 503 `e2ee-packs-not-configured`（黙って開放しない）。OPTIONS は CORS 交渉のため無認証（平文経路と同じ） |
| 分離 | store の namespace が別：平文 `drive-packs/<sha256>`、E2EE `e2ee-packs/<sha256>`（`worker/src/index.mjs` `getE2eePack`/`putE2eePack`）。どちらで書かれた pack が他方に答えることはない |
| 鍵 | サーバ側に置かない。Drive の ciphertext は E2EE 前提で、サーバは pack の shape（CAR として well-formed か）だけを確かめる（`worker/src/drive-packs.mjs` の既存 handler を再利用） |
| test | `test/drive-packs.test.mjs` に stub（in-memory fakeStore、ネットワークなし）5 件：無認証・誤トークンは 401、未設定は 503、トークンで往復し `ipld/e2ee-packs/<id>` に保存され平文経路からは 404、CORS preflight は無認証 204、不正な id は 404。`npm test` 230 件すべて通過（既存 225 + 新 5） |
| 未設定 | client 側（`src/drive-packs.mjs`）は本 PR では変更しない。client に tenant token を持たせるかは別 PR とする。本番の `DRIVE_E2EE_TOKEN_SHA256` 設定と deploy は本 PR に含まない |

## 5. Object Lock compliance の不利と費用見積書（設定はしない）

### 5.1 不利（設計 §9・§3.1・§16 の裏取り）

1. **消せない。** compliance mode は期限まで誰も消せない。master key でも削除・期限短縮・mode 変更・解除は拒否される（設計 §16 S1-2a 実測）。同じ名前に lock なしで書き直すと lock のない新 version ができ、名前で見た lock は「なし」になる（同）ため、確認は version を指して行う。
2. **鍵漏洩で過去分まで復号可。** lock は ciphertext を期限まで保持する。鍵を後で漏らした・奪われた場合、lock 期間中のすべての版が復号対象になる。平文で lock したら即座に問題だが、暗号文でも「鍵を捨てれば読めなくなる」（設計 §9）は、鍵を保持し続ける限り成り立たない。lock の候補は公開データと、client が暗号化した暗号文に限る（設計 §9）が、暗号文の場合も鍵の管理が前提である。
3. **削除要求に応じられない。** 権利侵害・違法な内容・誤って書いた個人情報の削除要請が来ても、lock 期限まで消せない。対処は設計 §9 のとおり：入口で配信を止める、期限を短くして renew で延ばす（既定 90 日。`worker/src/index.mjs:373`）、入れる前に要求者を認証し内容の種類を lease に記録する。
4. **release は「以後 renew しない」** ことを意味するだけで、object は lock の期限まで残る（設計 §10）。
5. **account の閉鎖・支払い停止が lock 中のファイルに与える影響は未確認**（設計 §3.1・§15）。

### 5.2 費用見積書（2026-11-25 時点の公式 pricing 参照。設計 §15 では「見積もっていない」としていたもの）

前提（Backblaze 公式 pricing、2026 年改定後）：pay-as-you-go は **$6.95/TB/30 日（約 $0.00695/GB/月）**、先頭 10 GB まで無料。Class A/B/C の API 呼び出しは無料、Class D は 1 日 2,500 件まで無料・以降 $0.004/10,000 件。送信（upload）は無料、egress は月平均保存量の 3 倍まで無料・超過は $0.01/GB。Object Lock 自体の追加課金の記載は公式 pricing に未確認（2026-11-25 参照時点）。

| 規模 | 月額（保存のみ） | 備考 |
|---|---|---|
| 10 GB まで | $0（無料枠内） | 先頭 10 GB は無料 |
| 100 GB | 約 $0.70 | `(100 − 10) × 0.00695` |
| 1 TB | 約 $6.95 | |
| drive-pack 最大 12 MiB × 1,000 個（約 12 GB） | 約 $0.02〜0.14 | 書込み・読み戻しは Class B/C で無料のはず。実測は未確認 |

- 検証役の読み取り（§8 の定期確認・抜き取り全読み）は Class B/C の範囲で追加課金は小さい見込みだが、実測していない（設計 §15）。
- 二重書き（lock 付き + 通常の書込み）による遅延は未測（設計 §15）。

## 6. E2EE でも外から見える情報

E2EE は平文を隠すが、次は隠れない。個人データ分離の評価ではこれらを前提にすること：

| 外から見えるもの | 見える範囲（現物の出所） |
|---|---|
| pack の sha256（id） | URL の path、ETag、PUT 応答の `sha256`、受領証の subject/contentDigest（`worker/src/drive-packs.mjs` の既存 handler） |
| size | `Content-Length`、PUT 応答の `bytes`、受領証の `size` |
| block / CID | pack は CAR なので、サーバは各 block が CID に一致することを確かめる（`worker/src/drive-packs.mjs:66` 相当）。block の CID 一覧はサーバ側で読める |
| B2 の object key / version / mod time | key は `<prefix>e2ee-packs/<sha256>`。version id（lock 付き書込みの場合）と更新時刻は B2 の account から読める（設計 §16 の version 発見） |
| Lease の field（lease つき書込みの場合） | subject、size、grade、providerReplicas、domainPolicy、pieceCommitment、retentionUntil、challengePeriod、requester/verifier の keyId（`src/retention.mjs:21-26`）。個人データの lease では、subject が単一 block の CID を指すなど、対象の特定につながり得る |
| 転送サイズ・時刻 | Cloudflare の access log（時刻・サイズ・送信元 IP）で観測可能。Worker のログは `yataverse-write` イベントで size と requester の先頭 12 hex を出す（`worker/src/index.mjs:303-306`。token・DID・CID・body は出さない） |
| 受領証・状態の記録 | 受領証の内容（subject の CID / digest、size、時刻、policy revision）と、保持の状態記録（leaseId、grade、status、数、observedAt/validUntil。`src/retention.mjs:31-35`）は公開 endpoint から読める（`worker/src/index.mjs:446-505`） |

隠れるもの：平文そのもの、復号鍵（サーバ側に置かない）、ファイル名や契約の内容（ciphertext 内）。

## 7. 本 PR でやらなかったこと

- bucket / 鍵の新規作成、Object Lock の有効化、deploy、課金の変更（設計 §14 で段階ごとに別承認）。
- provider node の選定・実装、PoSt、修復（§1・§2・§3 の不足として記録したもの）。
- client 側（`src/drive-packs.mjs`）への tenant token の持たせ方。本番の `DRIVE_E2EE_TOKEN_SHA256` 設定。
