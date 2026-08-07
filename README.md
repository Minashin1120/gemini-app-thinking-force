# Gemini 強化版思考モード Auto-On

[gemini.google.com](https://gemini.google.com/) にアクセスしたとき、モデルピッカー内の **強化版思考モード**（`THINKING_LEVEL_EXTENDED`）を自動的にオンにする Chrome 拡張機能です。

## インストール（開発者モード）

1. Chrome で `chrome://extensions` を開く
2. 右上の **デベロッパーモード** を有効化
3. **パッケージ化されていない拡張機能を読み込む**
4. このリポジトリの `extension/` フォルダを選択

## 動作概要

1. **設定の永続化**  
   Gemini 内部 RPC `L5adhe` でユーザー設定  
   `last_selected_thinking_level_on_web = 2`（強化版）を書き込みます。

2. **UI 同期**  
   モデルピッカー（`bard-mode-menu-button`）を開き、  
   `thinking-level-toggle` がオフならクリックしてオンにします。

3. **手動オフの尊重**  
   同一タブセッション中にユーザーがトグルをオフにした場合は、  
   そのセッションでは再有効化しません（次のアクセス／リロードで再度オンを試みます）。

## デバッグ

Gemini のページコンソールで:

```js
window.__geminiThinkingAuto.state
window.__geminiThinkingAuto.enable()
```

## リポジトリ構成

| パス | 内容 |
|------|------|
| `extension/` | Chrome 拡張（Manifest V3） |
| `AGENTS.md` | AI エージェント向け運用ルール |
| `docs/` | 技術調査メモ（追跡対象） |
| `.handoff/` | 引き継ぎ資料（**git 追跡外**） |
| `gemini.google.com.har` | 調査用 HAR（**git 追跡外**、ローカル保持） |

## 注意

- Gemini の UI / 内部 RPC は変更されやすいです。動作しなくなった場合は HAR を取り直して `docs/har-findings.md` と実装を更新してください。
- 非公式の自動化です。利用は自己責任でお願いします。
