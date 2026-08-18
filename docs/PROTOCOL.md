# 通信仕様（引き継ぎ用）

拡張・保守を担当する開発者向けのメモです。

---

## 全体像

```
ブラウザ                         サーバ (Node.js)
────────                        ─────────────────
public/js/net.js  ──WebSocket──▶ server/ws.js
                                    │
                                 server/index.js  … メッセージの振り分け・権限確認
                                    │
                                 server/room.js   … 1ゲーム分の状態と進行
                                    │
                                 shared/engine.js … 計算（純粋関数）
                                    │
                                 config/rules.*.json … 数値と文章
```

**原則**: ブラウザから来るのは「どの選択肢を選んだか」だけ。
金額・点数・順位はすべてサーバが計算し、ブラウザは配られた状態を描画するだけです。

---

## 接続

- エンドポイント: `ws://<host>/ws`（HTTPSのときは `wss://`）
- サブプロトコル・拡張は使いません
- メッセージは1件＝1つのJSON。`{ "t": "<種類>", ... }`
- 上限 64KB／1メッセージ。5秒あたり60メッセージを超えると切断します
- サーバは25秒ごとに ping を送り、応答のない接続を切ります

---

## クライアント → サーバ

### 誰でも

| `t` | 内容 | 応答 |
|---|---|---|
| `ping` | 生存確認 | `pong` |
| `createRoom` | `{ ruleset, options: { maxPlayers, timerSec, demandMode } }` | `welcome`（role: teacher） |
| `joinRoom` | `{ code, name }` | `welcome`（role: player）／`error` |
| `resume` | `{ code, token }` 再接続 | `welcome`／`error` |

`ruleset` は `config/rules.<id>.json` の `<id>` かファイル名。既定は `mvp`。

### 生徒のみ

| `t` | 内容 |
|---|---|
| `draft` | `{ decision: { <key>: <optionId> } }` 途中の選択を保存（部分指定可） |
| `submit` | `{ decision? }` 決定。全項目がそろっていないとエラー |
| `unsubmit` | 決定を取り消す（締め切り前のみ） |
| `leave` | 退出する |

### 先生のみ

| `t` | 内容 |
|---|---|
| `start` | ゲーム開始（`minPlayers` 以上必要） |
| `forceResolve` | 締め切って結果を出す。未提出者はその時点の選択で計算（`auto: true` が付く） |
| `next` | 次へ（結果→次ラウンド、最終ラウンド→結果発表、発表の段階送り） |
| `back` | 結果発表の段階を1つ戻す |
| `addBot` | `{ strategy? }` 練習用AIを追加 |
| `removePlayer` | `{ playerId }` |
| `restart` | 同じメンバーで最初から（点数リセット・イベント引き直し） |
| `setOptions` | `{ timerSec, autoAdvance }` |
| `closeRoom` | ルームを終了 |

権限はサーバ側で必ず確認します。生徒が先生の操作を送っても実行されません。

---

## サーバ → クライアント

| `t` | 内容 |
|---|---|
| `welcome` | `{ role, token, playerId, rules, strategies, state }` 接続確立時に1度 |
| `state` | `{ state }` 状態が変わるたび。**常に全体のスナップショット**（差分ではない） |
| `error` | `{ code, message }` `message` はそのまま生徒に見せてよい日本語 |
| `kicked` / `left` / `roomClosed` / `replaced` | 退出・置き換えの通知 |
| `pong` | `ping` への応答 |

`token` はブラウザに保存し、再接続時に `resume` で送ります
（sessionStorage = タブ単位で自動復帰、localStorage = 「前回の続きから」ボタン用）。

`rules` は接続時に1度だけ送られます。画面はこれを見て選択肢を描画するので、
**config を変えれば画面も自動的に変わります**（コード変更不要）。

### エラーコード

`noRoom` `cannotJoin` `noSession` `notInRoom` `forbidden` `badRequest`
`badJson` `rateLimited` `startFailed` `resolveFailed` `submitFailed` `internal`

---

## state（スナップショット）の主な中身

```jsonc
{
  "code": "482913",
  "phase": "lobby" | "decision" | "result" | "final",
  "round": 3, "totalRounds": 5,
  "finalStage": "profit" | "total" | "reflect",
  "event": { "id", "name", "icon", "headline", "body", "learn" },  // decision/result のとき
  "players": [
    { "id", "name", "company", "color", "icon",
      "connected", "isBot", "submitted", "funds", "producer", "society" }
  ],
  "submittedCount": 3, "playerCount": 4,
  "rounds": [                       // 解決済みラウンドの記録
    { "round": 1, "eventId": "quiet", "closedBy": "all" | "teacher" | "time",
      "results": [
        { "playerId", "decision", "auto",
          "quantity", "unitPrice", "unitCost",
          "revenue", "materialCost", "adCost", "giveCost", "profit",
          "producerGain", "societyGain",
          "factors": { "price", "ad", "ethical", "event", "luck" } }
      ] }
  ],
  "standings": { "profit": [...], "producer": [...], "society": [...], "total": [...] },
  "insights": [ { "type", "text", "ask" } ],   // 最終画面での話題づくり
  "you": {                                     // 生徒にだけ入る
    "id", "name", "company", "score", "draft", "submitted", "requiredKeys"
  }
}
```

**他人が何を選んだかは、ラウンドが解決するまで配られません。**

---

## 進行（phase）

```
lobby ──start──▶ decision ──全員提出 or forceResolve──▶ result
                    ▲                                     │
                    └──────────── next（次の年へ）─────────┘
                                                          │ 最終ラウンドなら
                                                          ▼
                                    final: profit ──next──▶ total ──next──▶ reflect
```

---

## 計算の流れ（`shared/engine.js`）

```
販売数 = 基準 × (1+価格の影響) × (1+広告の影響) × (1+原料の評判)
              × Π(イベントの倍率) × (1 ± 運)

売上     = 販売価格 × 販売数
原料費   = (カカオ単価 + 砂糖単価) × 販売数        ※単価はイベントで変動
利益     = 売上 − 原料費 − 広告費 − 追加還元
資金    += 利益

生産者点 += カカオ.producer + 砂糖.producer + 還元.producer
社会点   += カカオ.society  + 砂糖.society  + 還元.society

総合得点 = 0.6×正規化(資金) + 0.25×正規化(生産者点) + 0.15×正規化(社会点)
           （正規化はルーム内の最小〜最大を 0〜100 に変換）
```

乱数は **シード固定**（`rngFor(seed, 'r', roundIndex, playerId)`）。
同じ入力からは必ず同じ結果になるので、サーバが再起動しても進行は変わらず、
テストとバランス検証も再現可能です。`Math.random()` はゲーム計算で使いません。

---

## 拡張するときの注意

- **数値を足したいだけなら `config/*.json` だけ**。`server/rules.js` の `validateRules()` が
  書式を検証し、誤りがあればサーバは起動しません
- 新しい決定項目を足すときは `kind` を `material` / `price` / `cost` から選びます。
  画面は `rules.decisions` を読んで自動生成されるので、UIの改修は不要です
- 新しいイベント効果を足すときは `shared/engine.js` の `matchesWhen()` と
  `unitCostWithEvent()` に条件を追加し、`validateRules()` の許可リストも更新してください
- `Room` の状態を増やしたら `toJSON()` / `fromJSON()` にも足してください（再起動時の復元に使われます）
