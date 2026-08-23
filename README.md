# Gemini 強化版思考モード Auto-On

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-green.svg)](extension/manifest.json)

[gemini.google.com](https://gemini.google.com/) を開いたとき、モデルピッカー内の **強化版思考モード**（`THINKING_LEVEL_EXTENDED`）を自動でオンにする Chrome 拡張機能です。

> **非公式**の個人向けツールです。Google / Gemini とは無関係です。利用は自己責任でお願いします。

## 機能

- ページ読み込み時に強化版思考モードを自動有効化
- 設定の永続化（Gemini 内部 RPC `L5adhe` で preference を書き込み）
- UI 同期（モデルチップに「拡張」が付くまで有効化を試行）
- 既に強化版になっている場合は余計な操作をしない
- 同一タブ内でユーザーがオフにした場合は、そのセッションでは再有効化しない
- プロンプト入力中（IME 変換中）は有効化を待機し、入力を阻害しない（有効化後はプロンプトバーへカーソルを戻す）
- 拡張アイコンのポップアップから状態確認・ログの JSON ダウンロード

## インストール（開発者モード）

Chrome ウェブストアには未公開です。ローカルから読み込んで使います。

1. このリポジトリを clone する

   ```bash
   git clone https://github.com/Minashin1120/gemini-app-thinking-force.git
   ```

2. Chrome で `chrome://extensions` を開く
3. 右上の **デベロッパーモード** をオンにする
4. **パッケージ化されていない拡張機能を読み込む** をクリック
5. リポジトリ内の **`extension/`** フォルダを選択する
6. [gemini.google.com](https://gemini.google.com/) を開き、モデルチップが `〜拡張`（例: `Flash-Lite拡張`）になるか確認する

更新後は `chrome://extensions` で拡張を再読み込みし、Gemini をハードリロード（Ctrl+Shift+R）してください。

## 使い方

普段どおり Gemini を使うだけで動作します。

| 操作 | 説明 |
|------|------|
| 自動オン | アクセス時に強化版思考を有効化を試行 |
| 拡張アイコン | 接続状態・チップ表示・設定書き込み結果・ログを表示 |
| ログ DL | ポップアップから JSON をダウンロード（不具合調査用） |
| 今すぐ有効化 | ポップアップから手動で再試行 |

ログ取得には **gemini.google.com のタブが開いていること** が必要です。

### 開発者向けコンソール API

Gemini のページコンソールで:

```js
window.__geminiThinkingAuto.state      // 現在の状態
window.__geminiThinkingAuto.isExtended() // 強化版かどうか
window.__geminiThinkingAuto.enable()     // 有効化を再試行
window.__geminiThinkingAuto.dump()       // ログ付きで状態を出力
window.__geminiThinkingAuto.tryNg()      // Angular 経由の有効化を試行
```

## 動作の仕組み（概要）

1. **設定の永続化**  
   RPC `L5adhe` で `last_selected_thinking_level_on_web = 2`（強化版）を書き込みます。

2. **UI 同期**  
   モデルピッカーを開き、Angular コンテキスト経由または DOM 操作で強化版オプションを選択します。  
   成功判定はモデルチップ文言に **「拡張」** が含まれることです。

3. **手動オフの尊重**  
   同一タブセッション中にユーザーがオフにした場合、そのセッションでは再オンしません（リロード後に再度試行）。

技術調査の詳細は [`docs/har-findings.md`](docs/har-findings.md) を参照してください。

## リポジトリ構成

```text
.
├── extension/          # Chrome 拡張本体（Manifest V3）← 読み込むフォルダ
│   ├── manifest.json
│   ├── page-hook.js    # MAIN world: fetch フック + UI 操作
│   ├── content.js      # isolated world: ポップアップとの橋渡し
│   ├── popup.*         # 拡張アイコンの UI
│   └── icons/
├── docs/               # HAR 調査メモなど
├── tools/              # 調査用スクリプト
└── README.md
```

## 注意・制限

- Gemini の UI や内部 RPC は変更されやすいです。動かなくなった場合は再調査が必要です
- Cookie / トークン / 個人チャットを含む HAR は **リポジトリに含めない** でください
- 本拡張は Gemini の利用規約の解釈によっては問題になる可能性があります。自己責任でご利用ください
- 公式サポートはありません

## プライバシー

- 外部サーバーへの通信は行いません（操作対象は `gemini.google.com` のみ）
- アカウント情報やチャット内容を収集・送信しません
- ポップアップのログはブラウザ内に一時保持され、ユーザーが明示的にダウンロードしたときだけファイルになります

## ライセンス

[MIT License](LICENSE)

## 免責

本ソフトウェアは「現状有姿（AS IS）」で提供されます。Google / Gemini の仕様変更、アカウント制限、データ損失など、利用に伴う一切の損害について作者は責任を負いません。
