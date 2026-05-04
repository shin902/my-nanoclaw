---
name: setup-feedcord
description: Set up Feedcord RSS-to-Discord integration with NanoClaw. Use when the user wants to connect RSS feeds to Discord channels so NanoClaw automatically summarizes and processes new articles via thread_per_message mode.
---

# Feedcord セットアップ

FeedcordのRSSフィード設定と、NanoclawのDiscordチャンネル登録を行う。
`.env` は Write ツールで読み書きしない — 追記が必要な場合は `echo "KEY=VALUE" >> .env` で末尾に追記する。

## 既知の挙動・ハマりポイント

| 項目 | 内容 |
|------|------|
| `YoutubeUrls` | `[]` は無効。使わない場合も `[""]` が必須（空配列はバリデーションエラー） |
| `trigger_pattern` | `registered_groups` テーブルで NOT NULL 制約あり。NULL ではなく `''` を指定する |
| 初回起動 | Feedcord は初回起動時に既存アイテムをベースラインとして記録するだけで投稿しない。次の新着が来て初めて投稿される |
| Webhook Author ID | `message.author.id` = Webhook ID（URL中の数値部分）と同じ。実際に投稿させなくても Webhook URL から取得できる |

## 事前確認

```bash
ls feedcord/ 2>/dev/null || echo "not found"
ls store/messages.db 2>/dev/null || echo "db not found"
```

- `store/messages.db` がなければ NanoClaw を一度起動してから再実行する

## Step 1 — ヒアリング

AskUserQuestion で以下を確認する：

1. **チャンネルID → RSSフィードの紐付け**（必須）
   - DiscordチャンネルIDと、そこに流したいRSSフィードURL（複数可）
   - 例: `1234567890123456` → `https://example.com/feed`

2. **グループ名**（任意、省略時はチャンネルIDをそのまま使用）
   - NanoClaw 側のグループ識別名。英数字とハイフンのみ推奨

3. **チェック間隔**（任意、デフォルト: 30分）

4. **要約の保存先**（任意）
   - 省略時: チャット返信のみ
   - 指定時: コンテナ内パス `/workspace/group/summaries/` に保存（ホスト上は `groups/discord_<グループ名>/summaries/`）

## Step 2 — feedcord/ を作成

```bash
mkdir -p feedcord
```

### feedcord/appsettings.json

```json
{
  "Instances": [
    {
      "Id": "<グループ名>",
      "RssUrls": ["<RSSフィードURL>"],
      "YoutubeUrls": [""],
      "DiscordWebhookUrl": "PASTE_WEBHOOK_URL_HERE",
      "RssCheckIntervalMinutes": 30,
      "DescriptionLimit": 500,
      "Forum": false,
      "MarkdownFormat": false,
      "PersistenceOnShutdown": true
    }
  ],
  "ConcurrentRequests": 10
}
```

**注意**: `YoutubeUrls` は `[]` ではなく `[""]` にすること（バリデーションエラー回避）。

複数インスタンスは `Instances` 配列に追加する。

### feedcord/docker-compose.yml

```yaml
services:
  feedcord:
    image: qolors/feedcord:latest
    container_name: feedcord
    restart: unless-stopped
    volumes:
      - ./appsettings.json:/app/config/appsettings.json
```

## Step 3 — NanoClaw グループ登録

```bash
sqlite3 store/messages.db "
INSERT INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main, group_type, channel_mode)
VALUES
  ('dc:<チャンネルID>', '<グループ名>', 'discord_<グループ名>', '', datetime('now'), 0, 0, 'chat', 'thread_per_message')
ON CONFLICT(jid) DO UPDATE SET
  name = '<グループ名>',
  folder = 'discord_<グループ名>',
  channel_mode = 'thread_per_message',
  requires_trigger = 0;
"
```

**注意**: `trigger_pattern` は `NULL` ではなく `''`（空文字）を指定すること（NOT NULL 制約）。

登録確認：

```bash
sqlite3 store/messages.db "SELECT jid, name, folder, channel_mode FROM registered_groups WHERE jid = 'dc:<チャンネルID>';"
```

## Step 4 — グループの CLAUDE.md 作成

```bash
mkdir -p groups/discord_<グループ名>/summaries
```

保存あり版（`/workspace/group/summaries/` に保存）：

```markdown
# URL Processor

このチャンネルはURLを自動処理する専用チャンネルです。

## タスク

メッセージにURLが含まれている場合：

1. URLの内容をfetchして本文を取得する（`curl` または `agent-browser` を使用）
2. 内容を日本語で要約する（タイトル・要点3〜5行・出典URL）
3. 要約をチャットに返信する
4. 以下の形式でMarkdownファイルとして保存する：
   - 保存先: `/workspace/group/summaries/YYYY-MM-DD-<スラッグ>.md`
   - スラッグ: タイトルから英数字とハイフンのみ（30文字以内）
   - 形式:
     ```
     # <タイトル>

     **日付**: YYYY-MM-DD
     **出典**: <URL>

     ## 要約

     <要約本文>
     ```

## 注意

- メッセージがURLを含まない場合は何もしない
- fetchに失敗した場合はその旨を返信してスキップする
- 同じURLが既に summaries/ に保存されている場合はスキップする（ファイル名で確認）
- YouTubeのURLは動画ページとして処理する（タイトル・概要・チャンネル名を取得）
```

チャット返信のみの場合はステップ4（ファイル保存）を省く。

## Step 5 — DISCORD_ALLOWED_BOT_IDS の設定と案内

Webhook URL の数値部分が Webhook の Author ID と同じ。

```
https://discord.com/api/webhooks/123456789012345678/xxxxx
                                  ↑ これが DISCORD_ALLOWED_BOT_IDS に設定する値
```

ユーザーが Webhook URL を教えてくれた場合は以下を実行する：

```bash
echo "DISCORD_ALLOWED_BOT_IDS=<WebhookのID部分>" >> .env
```

**まだ Webhook URL が未設定の場合**は以下を案内する：

---

**残りの手動作業**

**1. Webhook URL を設定**

Discord → チャンネル設定 → 連携サービス → ウェブフックを作成 → URL をコピーして  
`feedcord/appsettings.json` の `PASTE_WEBHOOK_URL_HERE` に貼り付ける。

Webhook URL の形式:
```
https://discord.com/api/webhooks/<WebhookID>/<Token>
```

`<WebhookID>` の部分を `.env` に追記するよう伝える（または URL を教えてもらいこちらで追記する）：

```bash
echo "DISCORD_ALLOWED_BOT_IDS=<WebhookID>" >> .env
```

**2. Feedcord を起動**

```bash
cd feedcord && docker compose up -d
```

初回起動では既存アイテムは投稿されない。次の新着記事・動画が来たときに初めて投稿される。

**3. NanoClaw を再起動**

```bash
systemctl --user restart nanoclaw
# macOS:
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

以上で設定完了。
