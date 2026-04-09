# .claude ディレクトリ分離要件定義書

## 前提

この要件は、[channel-agent-isolation.md](channel-agent-isolation.md) に記載の「チャンネル別エージェント分離」スペックが実装済みであることを前提とする。

## 背景

GitHub Copilot レビュー ([PR #15](https://github.com/shin902/nanoclaw/pull/15)) にて、以下のセキュリティ懸念が指摘された：

> `groupSessionsDir` is now derived from `group.parent_folder ?? group.folder`, which makes multiple RegisteredGroup entries share the same mounted `/home/node/.claude` directory... potentially leaking privileged tool permissions between groups.

現状の実装では `/workspace/group` は `parent_folder` を優先して共有できる一方、`.claude` はグループごとに分離する。これにより異なる権限レベルのグループ間で設定が混在するリスクを避ける。

## 要件

### 基本方針

| グループタイプ | `.claude` ディレクトリ                             | 設定引き継ぎ                                     | 理由                                                 |
| -------------- | -------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| `main`         | **独立**（`sessions/{folder}/.claude`）            | なし（初期作成）                                 | 親が存在しないため自前で作成                         |
| `override`     | **独立**（`sessions/{folder}/.claude`）            | 親から `settings.json` を**コピー**              | 親と同じ権限レベルだが、並行アクセスによる競合を防止 |
| `chat`         | **独立**（`sessions/{folder}/.claude`）            | `agent_config` に基づき**動的生成**              | 親とは異なる `agent` 設定を持つため分離必須          |
| `thread`       | **独立**（`sessions/{folder}/.claude`）            | なし（将来: 親 `agent_config` 継承を検討）       | ワークスペース共有と設定分離を両立するため           |

### 詳細仕様

#### 1. main グループ

```
data/sessions/{group.folder}/
├── .claude/
│   └── settings.json      # 動的生成（agent_config またはデフォルト）
├── agent-runner-src/      # 独立
└── CLAUDE.md             # 独立
```

- `parent_folder` は設定不可
- `.claude` はコンテナ起動時に新規作成
- `settings.json` は `agent_config` があればそれに基づき生成、なければ main タイプのデフォルト

#### 2. override グループ

```
data/sessions/{group.folder}/
├── .claude/
│   └── settings.json      # 親からコピー後、agent_config で上書き
├── agent-runner-src/      # 独立
└── CLAUDE.md             # 親からコピー（現行通り）

data/sessions/{parent.folder}/  # 親（参照のみ、書き込みなし）
└── workspace/            # コード共有
```

- 初回起動時、親の `.claude/settings.json` をコピー
- その後、自身の `agent_config` で上書き・調整
- 以降は独立した `.claude` を使用（親への書き込みは行わない）

#### 3. chat グループ

```
data/sessions/{group.folder}/
├── .claude/
│   └── settings.json      # agent_config に基づき動的生成
├── agent-runner-src/      # 独立
└── CLAUDE.md             # 親からコピー（現行通り）
```

- `agent_config` によるツール制限が必須なため、独立した `.claude` を持つ
- `settings.json` は `agent.allowedTools`, `agent.mcpServers` を反映

#### 4. thread グループ

```
data/sessions/{parent.folder}/     # 親ワークスペース参照元
└── workspace/                     # 親と共有

data/sessions/{group.folder}/      # thread 固有
├── .claude/
│   └── settings.json              # thread 独立
└── CLAUDE.md                      # thread 固有のシステムプロンプト
```

- **`.claude` は常に group.folder 単位で独立**（`sessions/{group.folder}/.claude`）
- 現行実装では `thread_defaults.agent.inherit` は未実装（将来対応）
- 明示的に `agent` を指定した場合は、thread 側の `settings.json` に反映する

## 実装方針

### container-runner.ts の変更

```typescript
function buildVolumeMounts(group: RegisteredGroup): VolumeMounts {
  // ワークスペースのマウント先（parent_folder があればそちらを優先）
  const workspaceRoot = group.parent_folder ?? group.folder;

  // .claude ディレクトリの決定ロジック
  const claudeDir = resolveClaudeDir(group);

  return {
    workspace: `data/sessions/${workspaceRoot}`,
    claude: claudeDir,
    // ...
  };
}

function resolveClaudeDir(group: RegisteredGroup): string {
  // すべてのグループタイプで .claude は独立
  return `data/sessions/${group.folder}/.claude`;
}
```

### 初回起動時のコピー処理

```typescript
async function initializeClaudeDir(group: RegisteredGroup): Promise<void> {
  const claudeDir = `data/sessions/${group.folder}/.claude`;

  // 既に存在する場合はスキップ
  if (fs.existsSync(path.join(claudeDir, 'settings.json'))) {
    return;
  }

  // 親からコピー（main は親がいないのでスキップ）
  if (
    group.parent_folder &&
    (group.type === 'override' || group.type === 'chat')
  ) {
    const parentClaudeDir = `data/sessions/${group.parent_folder}/.claude`;
    if (fs.existsSync(parentClaudeDir)) {
      await copyClaudeSettings(parentClaudeDir, claudeDir);
    }
  }

  // agent_config に基づき settings.json を生成・上書き
  await generateSettingsJson(group, claudeDir);
}
```

### thread グループの agent 継承

```typescript
function resolveAgentConfig(group: RegisteredGroup): AgentConfig {
  if (group.type === 'thread') {
    // inherit: true の場合、親の agent_config を使用
    if (group.agent?.inherit) {
      const parent = getParentGroup(group.parent_folder!);
      return parent.agent_config ?? getDefaultAgentConfig('thread');
    }
    // 明示的な agent 指定がある場合
    if (group.agent) {
      return group.agent;
    }
  }

  // その他のタイプは自身の agent_config を使用
  return group.agent_config ?? getDefaultAgentConfig(group.type);
}
```

## セキュリティ考慮事項

### 権限分離の保証

- `override` と `thread` は同じ親を持つ場合があるが、`.claude` は常に分離される
- これにより `override`（高権限）の設定が `thread`（低権限）に漏れることはない

### thread 同士の分離

- 同じ親を持つ複数の `thread` でも `.claude` は共有しない
- 並行アクセス時も `settings.json` 競合を起こさない

### 設定の永続化

| 操作               | main     | override             | chat             | thread           |
| ------------------ | -------- | -------------------- | ---------------- | ---------------- |
| settings.json 生成 | 初回のみ | 初回（親からコピー） | 初回（動的生成） | 初回（動的生成） |
| settings.json 更新 | 可能     | 可能（独立）         | 可能（独立）     | 可能（独立）     |
| CLAUDE.md          | 独立     | 独立                 | 独立             | 独立             |

## Migration 計画

### 既存グループへの適用

1. **main グループ**: 変更なし（既に独立）
2. **override グループ**:
   - 初回起動時に親の `.claude` をコピー
   - 以降は独立
3. **chat グループ**:
   - `parent_folder` が設定されている場合、新規 `.claude` を作成
   - `agent_config` に基づき `settings.json` を生成
4. **thread グループ**:
   - `group.folder/.claude` を利用（常に独立）
   - `parent_folder` は `/workspace/group` の参照にのみ利用

## 関連スペック

- [channel-agent-isolation.md](channel-agent-isolation.md) - チャンネル別エージェント分離
- [group-type-spec.md](group-type-spec.md) - グループタイプ仕様
- [pr-15-review.md](../reviews/pr-15-review.md) - PR #15 レビュー対応
