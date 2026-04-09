# タスク: `.claude/` をグループごとに分離する

## 目的

`parent_folder` を持つグループ（Discord スレッドなどの子グループ）が、現在
コンテナ起動時に親グループと `/home/node/.claude` ディレクトリを共有している。
これにより、`settings.json` / セッション履歴 / スキルが複数グループで単一に
なっており、グループごとのエージェント設定を独立させることができない。

本タスクでは、各グループが `group.folder` の値を基に **独自の `.claude/`
ディレクトリ** を持つよう修正する。

## 維持すべき挙動

- `/workspace/group` マウントは引き続き `parent_folder` が存在する場合は親
  フォルダを参照する（スレッドが親の作業ファイルや CLAUDE.md を参照できる
  既存挙動を壊さない）。
- IPC ディレクトリ（`/workspace/ipc`）は `group.folder` ベースのまま維持する。
- agent-runner-src のコピー先は `group.folder` ベースのまま維持する。

## スコープ外（本タスクでは手を付けない）

- `AgentConfig` / `agent_config` カラムの DB 導入
- `allowedTools` / `mcpServers` のグループ別出し分け
- `thread_defaults.agent` 継承ロジック
- `/workspace/group` の分離（親フォルダ共有を解除しない）

---

## フェーズ構成

### Phase 1: 現状調査

- `src/container-runner.ts` のマウント構築ロジックを読む
- `src/container-runner.test.ts` の関連テストを読む
- `src/types.ts` の型定義を読む
- `.claude/` ディレクトリのパスが `parent_folder` を参照している箇所をすべて
  特定する
- 調査結果を実装前にまとめる（コメント等で）

### Phase 2: 実装

- `.claude/` 関連パスの算出を `parent_folder` ではなく `group.folder` に基づく
  よう変更する。対象は以下の要素：
  - グループセッションディレクトリのパス（`groupSessionsDir` 等）
  - `settings.json` の書き出し先
  - スキルのコピー先
  - `/home/node/.claude` マウントの hostPath
- `/workspace/group` マウント（`groupDir`）の解決ロジックは変更しない

### Phase 3: テスト更新

- `src/container-runner.test.ts` にある「`parent_folder` で `.claude` マウントを
  解決する」既存テストを、新仕様（`.claude` は `group.folder` ベース）に書き換える
- 親グループとスレッド（`parent_folder` を持つグループ）がそれぞれ別の
  `.claude/` を持つことを検証するテストケースを追加する
- `/workspace/group` は依然 `parent_folder` 由来のパスを指すことを確認する
  テストも維持する

### Phase 4: ドキュメント更新

- `docs/thread-based-architecture/channel-agent-isolation.md` に以下を追記する：
  - 「各グループが独自 `.claude/` を持つ」という設計が実装済みであること
  - 既存スレッドの `.claude/` は移行されず、次回起動時に空から再生成される
    ことと、その理由（個人プロジェクトのため後方互換性不要）

### Phase 5: ビルド・テスト検証

- `npm run build` を実行してビルドが通ることを確認する
- `npm test` を実行して全テストが通ることを確認する
- 失敗した場合は根本原因を修正し、再度通るまで繰り返す

### Phase 6: コミット

- 変更内容を Conventional Commits 形式でコミットする
- コミットメッセージは英語のタイプ・スコープ（例: `fix(container-runner):`）
  ＋ 日本語本文で、「なぜこの変更が必要か」を中心に記述する
- `git push` は行わない

---

## 各フェーズのエージェントへの指示

- すべてのフェーズで、まずコードベースを読んで現状を把握してから変更を行う
- テストとビルドは変更後に必ず実行し、グリーンになるまで修正を繰り返す
- 変更は最小限にとどめ、スコープ外の改善・リファクタリングは行わない
- コミットは各フェーズの作業完了後にまとめて一度作成する（フェーズ 6 で実施）
- `git push` は絶対に行わない
