# HAR 調査結果（gemini.google.com）

調査元: ローカルの `gemini.google.com.har`（git 追跡外・約 40MB）

## 用語対応

| UI（日本語） | 内部定数 | 数値 |
|--------------|----------|------|
| 標準 | `THINKING_LEVEL_STANDARD` | `1` |
| **強化版思考モード** | `THINKING_LEVEL_EXTENDED` | `2` |
| Deep Think | `THINKING_LEVEL_DEEP_THINK` | `3` |

モデル一覧（RPC `otAQ7b`）の例:

```text
[[1,"標準","ほとんどの質問に最適",...],
 [2,"強化版思考モード","複雑な問題の解決",...]]
```

## 設定キー

- 名前: `last_selected_thinking_level_on_web`
- フィールド ID: **265**
- 変換: `ftc("THINKING_LEVEL_EXTENDED") === 2`

関連コード（難読化 JS）:

```js
_.kJ = function(a, b) {
  var c = b !== a.Aa.value;
  a.Aa.next(b);
  c && a.Ga.ha.ha.setValue(265, _.ftc(b));
};
```

トグルハンドラ:

```js
zR(a) {
  var c = a.checked
    ? "THINKING_LEVEL_EXTENDED"
    : (this.pba() ?? "THINKING_LEVEL_STANDARD");
  // onSelect → thinkingLevelSelected
}
```

## 書き込み RPC: `L5adhe`

- URL: `POST https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=L5adhe&...`
- Content-Type: `application/x-www-form-urlencoded;charset=UTF-8`
- Body:
  - `f.req` = `[[["L5adhe", "<inner JSON string>", null, "generic"]]]`
  - `at` = CSRF トークン（他 batchexecute と共通）

### inner JSON

```json
[
  [null, null, /* ... index 0..263 は null ... */, 2],
  [["last_selected_thinking_level_on_web"]]
]
```

- 配列長 = **265**（フィールド ID）
- 値の位置 = **index 264**（`fieldId - 1`）
- 値 `2` = 強化版、`1` = 標準

HAR 上の実測:

| Entry | value | 意味 |
|-------|-------|------|
| 64, 157 | 1 | STANDARD |
| 142, 162 | 2 | EXTENDED |

## 読み取り RPC: `ESY5D`

大量の preference キーをまとめて取得。キー一覧に `last_selected_thinking_level_on_web` が含まれる。  
レスポンス配列とリクエストキーの単純 1:1 対応は崩れているため、**読み取りパッチより書き込み + DOM の方が安定**。

## DOM / test id

| 用途 | data-test-id |
|------|----------------|
| モデルメニューボタン | `bard-mode-menu-button` |
| 思考レベル容器 | `thinking-level-container` |
| **強化版トグル** | `thinking-level-toggle` |
| デスクトップピッカー | `thinking-level-picker-desktop` |
| 思考レベル選択肢 | `thinking-level-option` |

コンポーネント名: `thinking-level-picker`  
ラベル文言: `強化版思考モード` / 説明 `複雑なタスクに対して、より時間をかけて熟考`

## 拡張の戦略

1. `fetch` / `XHR` をフックして `at` / `bl` / `f.sid` を取得
2. `L5adhe` で preference を `2` に永続化
3. メニューを開き `thinking-level-toggle` をオンにして UI 状態を同期
4. 同一セッションでユーザーがオフにした場合は再強制しない
