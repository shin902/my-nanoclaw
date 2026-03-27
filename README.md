<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Docker コンテナ内で Claude Agent SDK を動かす、Discord 優先の軽量な個人向けアシスタントです。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

---

## 概要

NanoClaw は、Discord チャンネルごとに独立した Claude セッションを持つ個人用アシスタントです。

現在のコアは次の方針で構成されています。

- Discord 直結
- Docker 前提
- ストレージは SQLite ではなく JSON / JSONL
- グループごとのワークスペース分離
- 単一 Node.js プロセス
- 定期実行タスク対応

メッセージは `data/groups/{folder}/YYYY-MM-DD.jsonl` に保存され、グループ設定は `data/groups/{folder}/config.json` に保存されます。タスクは `data/tasks/active.json` と日次ログで管理されます。

## 特徴

- Discord チャンネルごとに独立した会話コンテキスト
- `/new` `/model` `/compact` のスラッシュコマンド
- グループごとのファイルワークスペース
- Docker コンテナ内での Claude Agent SDK 実行
- JSONL ベースの会話履歴
- ファイルベースの IPC
- 定期実行タスク

## 要件

- macOS / Linux / WSL
- Node.js 20 以上
- Docker
- Claude Code
- Discord Bot Token

## セットアップ

```bash
git clone https://github.com/shin902/nanoclaw.git
cd nanoclaw
npm install
npm run build
```

`.env` などで最低限次を設定してください。

```bash
DISCORD_BOT_TOKEN=...
ANTHROPIC_API_KEY=...
```

開発時は次を使います。

```bash
npm run dev
npm test
```

コンテナを更新する場合:

```bash
./container/build.sh
```

## 使い方

登録済みの Discord チャンネルで普通に話しかけるだけです。トリガーワードは不要です。

利用可能なスラッシュコマンド:

- `/new` 現在のチャンネルのセッションをリセット
- `/model` 現在のチャンネルで使うモデルを変更
- `/compact` 直近会話の要約イベントを書き込む

## アーキテクチャ

```text
Discord -> JSONL store -> Group queue -> Container -> Discord
```

主なファイル:

- `src/index.ts` オーケストレータ
- `src/store.ts` ファイルベースの設定・イベント・タスク保存
- `src/channels/discord.ts` Discord 連携
- `src/group-queue.ts` グループ単位の直列処理
- `src/container-runner.ts` コンテナ起動
- `src/ipc.ts` IPC 処理
- `src/task-scheduler.ts` 定期実行

## ディレクトリ構成

```text
data/
  groups/{folder}/
    config.json
    YYYY-MM-DD.jsonl
  tasks/
    active.json
    YYYY-MM-DD.jsonl
groups/
  {folder}/
    CLAUDE.md
```

## カスタマイズ

NanoClaw は設定画面ではなくコード変更を前提にしています。必要な挙動に合わせて、そのままコードを変える想定です。

## ライセンス

MIT
