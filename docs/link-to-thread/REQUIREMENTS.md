# コンテンツトリガー → スレッド自動生成 要件定義

## 概要

特定チャンネルでコンテンツ（URL・Markdown・メール等）を検出したとき、Discord スレッドを自動作成し、要約を投稿したうえでそのスレッドをセッション継続可能な group として扱う機能。

## 用語

| 用語 | 意味 |
|------|------|
| **WatchChannel** | コンテンツトリガーを監視する登録済みチャンネル |
| **ContentTrigger** | スレッド作成の引き金となるコンテンツ種別（URL / Markdown / Email など） |
| **SpawnedThread** | トリガー検出時に自動作成される Discord スレッド |
| **ThreadGroup** | SpawnedThread に対応する NanoClaw の group エントリ |

---

## 機能要件

### FR-1: WatchChannel の登録

- 任意の Discord チャンネルを WatchChannel として登録できる
- WatchChannel には「どの ContentTrigger を監視するか」を設定する
- 登録は既存の `register_group` IPC に準ずるが、`type: 'watch_channel'` で区別する
- 通常の group と同様に DB に永続化する

### FR-2: ContentTrigger の検出

- WatchChannel に届いたメッセージを ContentTrigger ルールで評価する
- **初期実装（v1）**：メッセージ本文に HTTP/HTTPS URL が含まれる場合にトリガー
- トリガーが検出されなければ、メッセージは無視する（通常の group とは異なりエージェントを起動しない）

**将来拡張予定の trigger 種別（設計に含めるが実装しない）：**
- Markdown ファイル添付
- メール転送（Gmail チャンネル経由）

### FR-3: スレッドの自動作成

- トリガー検出時、元メッセージのあるチャンネルに Discord スレッドを作成する
- スレッド名は検出したコンテンツから自動生成する（例：URLのドメイン＋タイトル）
- スレッド作成に失敗した場合は元チャンネルにエラーを通知する

### FR-4: 初回要約の投稿

- スレッド作成後、コンテナエージェントを起動して要約を生成・投稿する
- エージェントへの初期プロンプトにはトリガーとなったコンテンツ（URL等）を渡す
- 要約完了まで Discord のタイピングインジケーターを表示する
- 失敗時はスレッド内にエラーメッセージを投稿する

### FR-5: ThreadGroup としてのセッション継続

- 作成されたスレッドは自動的に NanoClaw の group として登録される（`type: 'thread'`）
- セッションは ThreadGroup の `chat_jid`（= `dc:{threadId}`）に紐付く
- 以降のスレッド内メッセージは通常の group と同様にエージェントが処理する
- 親の WatchChannel のトリガー設定（`requiresTrigger` 等）を継承する

---

## 非機能要件

### 拡張性

- ContentTrigger はインターフェースとして定義し、URL 以外の trigger を後から追加できる構造にする
- WatchChannel は trigger の種別を配列で持ち、複数 trigger を同時に監視できる設計にする（v1 は URL 固定でよい）

### 重複防止

- 同一 URL に対してスレッドが二重に作成されないよう、元メッセージ ID をキーにした処理済みフラグを持つ

---

## データモデル（案）

### RegisteredGroup への追加

```ts
type WatchChannelConfig = {
  triggers: ContentTriggerConfig[];
};

// v1 の ContentTriggerConfig
type UrlTriggerConfig = {
  kind: 'url';
};

// 将来
// type MarkdownTriggerConfig = { kind: 'markdown' };
// type EmailTriggerConfig    = { kind: 'email'; ... };

type ContentTriggerConfig = UrlTriggerConfig; // 将来は union で拡張

// RegisteredGroup に追加
interface RegisteredGroup {
  // ...既存フィールド...
  watch_channel?: WatchChannelConfig; // これがある group が WatchChannel
}
```

### SpawnedThread の追跡（DB）

```sql
CREATE TABLE IF NOT EXISTS spawned_threads (
  source_message_id TEXT PRIMARY KEY,  -- トリガーになった元メッセージのID
  thread_jid        TEXT NOT NULL,     -- 作成されたスレッドの chat_jid
  trigger_kind      TEXT NOT NULL,     -- 'url' | 'markdown' | 'email'
  trigger_value     TEXT NOT NULL,     -- URL文字列など
  created_at        TEXT NOT NULL
);
```

---

## 処理フロー（v1: URL）

```
1. discord.ts: メッセージ受信
2.   → WatchChannel か判定（group.watch_channel が存在するか）
3.   → URL を抽出（なければ無視）
4.   → 重複チェック（source_message_id が spawned_threads に存在するか）
5. discord.ts or index.ts: Discord スレッド作成（channel.threads.create()）
6.   → spawned_threads に記録
7.   → ThreadGroup を registeredGroups に登録（type: 'thread'）
8. index.ts: コンテナエージェント起動（初期プロンプト = URL + 要約指示）
9.   → スレッドに要約を投稿
10.  → 以降はスレッド内の通常メッセージとして処理継続
```

---

## スコープ外（本フェーズで実装しない）

- Markdown 添付・メール trigger
- 複数 URL が含まれる場合の複数スレッド作成（v1 は最初の URL のみ）
- WatchChannel 内の通常会話への応答
- スレッド名の手動変更・更新
