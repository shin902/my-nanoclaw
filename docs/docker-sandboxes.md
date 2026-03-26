# Docker サンドボックスでの NanoClaw の実行 (手動セットアップ)

このガイドでは、[Docker サンドボックス](https://docs.docker.com/ai/sandboxes/) 内に NanoClaw をゼロからセットアップする手順を説明します。インストールスクリプトや作成済みのフォークは使用しません。アップストリームのリポジトリをクローンし、必要なパッチを適用して、ハイパーバイザーレベルで完全に隔離された環境でエージェントを実行します。

## アーキテクチャ

```
ホスト (macOS / Windows WSL)
└── Docker サンドボックス (隔離されたカーネルを持つマイクロ VM)
    ├── NanoClaw プロセス (Node.js)
    │   ├── チャネルアダプター (WhatsApp, Telegram など)
    │   └── コンテナ起動プロセス → 入れ子になった Docker デーモン
    └── Docker-in-Docker
        └── nanoclaw-agent コンテナ
            └── Claude Agent SDK
```

各エージェントは独自のコンテナ内で実行され、そのコンテナはホストから完全に隔離されたマイクロ VM 内にあります。エージェントごとのコンテナ + VM 境界という 2 層の隔離構造になっています。

サンドボックスは `host.docker.internal:3128` で MITM プロキシを提供し、ネットワークアクセスを処理し、Anthropic API キーを自動的に注入します。

> **注：** このガイドは、macOS (Apple Silicon) 上で WhatsApp を使用して検証されたセットアップに基づいています。他のチャネル（Telegram, Slack など）や環境（Windows WSL）では、それぞれの HTTP/WebSocket クライアントに対して追加のプロキシパッチが必要になる場合があります。コアとなるパッチ（コンテナランナー、認証情報プロキシ、Dockerfile）は共通して適用されますが、チャネル固有のプロキシ設定は異なります。

## 前提条件

- **Docker Desktop v4.40+** (サンドボックスサポート付き)
- **Anthropic API キー** (サンドボックスプロキシが注入を管理します)
- **Telegram** を使用する場合：[@BotFather](https://t.me/BotFather) から取得したボットトークンと、あなたのチャット ID
- **WhatsApp** を使用する場合：WhatsApp がインストールされたスマートフォン

サンドボックスのサポートを確認：
```bash
docker sandbox version
```

## ステップ 1: サンドボックスの作成

ホストマシン上で以下を実行します：

```bash
# ワークスペースディレクトリを作成
mkdir -p ~/nanoclaw-workspace

# ワークスペースをマウントしたシェルサンドボックスを作成
docker sandbox create shell ~/nanoclaw-workspace
```

WhatsApp を使用する場合は、WhatsApp の Noise プロトコルが MITM 検査されないように、プロキシバイパスを設定します：

```bash
docker sandbox network proxy shell-nanoclaw-workspace \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

Telegram ではプロキシバイパスは不要です。

サンドボックスに入ります：
```bash
docker sandbox run shell-nanoclaw-workspace
```

## ステップ 2: 前提条件のインストール

サンドボックス内で以下を実行します：

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
npm config set strict-ssl false
```

## ステップ 3: NanoClaw のクローンとインストール

Docker-in-Docker は共有ワークスペースパスからしかバインドマウントできないため、NanoClaw はワークスペースディレクトリ内に配置する必要があります。

```bash
# まずホームにクローンする (virtiofs ではクローン中に git パックファイルが破損することがあるため)
cd ~
git clone https://github.com/qwibitai/nanoclaw.git

# 自身のワークスペースパス（`docker sandbox create` に渡したホストパス）に置き換えてください
WORKSPACE=/Users/you/nanoclaw-workspace

# DinD マウントが機能するようにワークスペースに移動
mv nanoclaw "$WORKSPACE/nanoclaw"
cd "$WORKSPACE/nanoclaw"

# 依存関係をインストール
npm install
npm install https-proxy-agent
```

## ステップ 4: プロキシとサンドボックス用パッチの適用

Docker サンドボックス内で動作させるには、いくつかのパッチが必要です。これらはプロキシのルーティング、CA 証明書、および Docker-in-Docker のマウント制限を処理します。

### 4a. Dockerfile — コンテナイメージビルド用のプロキシ引数

サンドボックスの MITM プロキシが独自の証明書を提示するため、`docker build` 内の `npm install` が `SELF_SIGNED_CERT_IN_CHAIN` で失敗します。`container/Dockerfile` にプロキシビルド引数を追加します。

`FROM` 行の後に以下の行を追加します：

```dockerfile
# プロキシビルド引数を受け入れる
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NODE_EXTRA_CA_CERTS
ARG npm_config_strict_ssl=true
RUN npm config set strict-ssl ${npm_config_strict_ssl}
```

そして、`RUN npm install` 行の後に以下を追加します：

```dockerfile
RUN npm config set strict-ssl true
```

### 4b. ビルドスクリプト — プロキシ引数の転送

`container/build.sh` を修正して、プロキシ環境変数を `docker build` に渡すようにします。

`docker build` コマンドに以下の `--build-arg` フラグを追加します：

```bash
--build-arg http_proxy="${http_proxy:-$HTTP_PROXY}" \
--build-arg https_proxy="${https_proxy:-$HTTPS_PROXY}" \
--build-arg no_proxy="${no_proxy:-$NO_PROXY}" \
--build-arg npm_config_strict_ssl=false \
```

### 4c. コンテナランナー — プロキシ転送、CA 証明書マウント、/dev/null 修正

`src/container-runner.ts` に 3 つの変更を加えます：

**`/dev/null` シャドウマウントの置き換え。** サンドボックスは `/dev/null` のバインドマウントを拒否します。`.env` が `/dev/null` にシャドウマウントされている箇所を探し、空のファイルに置き換えます：

```typescript
// .env を隠すための空ファイルを作成 (Docker サンドボックスは /dev/null マウントを拒否するため)
const emptyEnvPath = path.join(DATA_DIR, 'empty-env');
if (!fs.existsSync(emptyEnvPath)) fs.writeFileSync(emptyEnvPath, '');
// マウント時に '/dev/null' の代わりに emptyEnvPath を使用
```

**プロキシ環境変数をエージェントコンテナに転送する。** 起動するコンテナに `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`（および小文字版）の `-e` フラグを追加します。

**CA 証明書のマウント。** `NODE_EXTRA_CA_CERTS` または `SSL_CERT_FILE` が設定されている場合、証明書をプロジェクトディレクトリにコピーし、エージェントコンテナにマウントします：

```typescript
const caCertSrc = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
if (caCertSrc) {
  const certDir = path.join(DATA_DIR, 'ca-cert');
  fs.mkdirSync(certDir, { recursive: true });
  fs.copyFileSync(caCertSrc, path.join(certDir, 'proxy-ca.crt'));
  // マウント: certDir -> /workspace/ca-cert (読み取り専用)
  // コンテナ内で NODE_EXTRA_CA_CERTS=/workspace/ca-cert/proxy-ca.crt を設定
}
```

### 4d. コンテナランタイム — 自己終了の防止

`src/container-runtime.ts` の `cleanupOrphans()` 関数は、`nanoclaw-` プレフィックスでコンテナを照合します。サンドボックス内では、サンドボックスコンテナ自体が一致してしまう可能性があります（例：`nanoclaw-docker-sandbox`）。現在のホスト名を除外するようにします：

```typescript
// cleanupOrphans() 内で、停止対象のコンテナリストから os.hostname() を除外する
```

### 4e. 認証情報プロキシ — MITM プロキシ経由のルーティング

`src/credential-proxy.ts` において、アップストリームの API リクエストはサンドボックスプロキシを経由する必要があります。外部へのリクエストに `HttpsProxyAgent` を追加します：

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const upstreamAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
// upstreamAgent を https.request() のオプションに渡す
```

### 4f. セットアップスクリプト — プロキシビルド引数

`setup/container.ts` を修正して、`build.sh` (ステップ 4b) と同じプロキシ `--build-arg` フラグを渡すようにします。

## ステップ 5: ビルド

```bash
npm run build
bash container/build.sh
```

## ステップ 6: チャネルの追加

### Telegram

```bash
# Telegram スキルを適用
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram

# スキル適用後に再ビルド
npm run build

# .env を設定
cat > .env << EOF
TELEGRAM_BOT_TOKEN=<BotFather から取得したトークン>
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

# チャットを登録
npx tsx setup/index.ts --step register \
  --jid "tg:<あなたのチャット ID>" \
  --name "My Chat" \
  --trigger "@nanoclaw" \
  --folder "telegram_main" \
  --channel telegram \
  --assistant-name "nanoclaw" \
  --is-main \
  --no-trigger-required
```

**チャット ID を確認する方法：** ボットにメッセージを送信し、以下を実行します：
```bash
curl -s --proxy $HTTPS_PROXY "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
```

**グループ内での Telegram：** @BotFather で Group Privacy を無効にし (`/mybots` > Bot Settings > Group Privacy > Turn off)、ボットを一度削除して追加し直してください。

**重要：** Telegram スキルによって `src/channels/telegram.ts` が作成された場合、プロキシをサポートするように修正する必要があります。`HttpsProxyAgent` を追加し、grammy の `Bot` コンストラクタの `baseFetchConfig.agent` に渡します。その後、再ビルドしてください。

### WhatsApp

まず [ステップ 1](#ステップ-1-サンドボックスの作成) でプロキシバイパスが設定されていることを確認してください。

```bash
# WhatsApp スキルを適用
npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp

# 再ビルド
npm run build

# .env を設定
cat > .env << EOF
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

# 認証 (いずれかを選択)：

# QR コード — WhatsApp のカメラでスキャン：
npx tsx src/whatsapp-auth.ts

# またはペアリングコード — WhatsApp > リンク済みデバイス > 電話番号でリンク でコードを入力：
npx tsx src/whatsapp-auth.ts --pairing-code --phone <電話番号 (先頭の + なし)>

# チャットを登録 (JID = 電話番号 + @s.whatsapp.net)
npx tsx setup/index.ts --step register \
  --jid "<電話番号>@s.whatsapp.net" \
  --name "My Chat" \
  --trigger "@nanoclaw" \
  --folder "whatsapp_main" \
  --channel whatsapp \
  --assistant-name "nanoclaw" \
  --is-main \
  --no-trigger-required
```

**重要：** WhatsApp スキルのファイル (`src/channels/whatsapp.ts` および `src/whatsapp-auth.ts`) にもプロキシ用の修正が必要です。WebSocket 接続用の `HttpsProxyAgent` と、プロキシ対応のバージョン取得処理を追加してください。その後、再ビルドしてください。

### 両方のチャネルを使用する場合

両方のスキルを適用し、両方にプロキシパッチを当て、`.env` 変数を統合して、各チャットを個別に登録します。

## ステップ 7: 実行

```bash
npm start
```

`ANTHROPIC_API_KEY` を手動で設定する必要はありません。サンドボックスプロキシがリクエストをインターセプトし、`proxy-managed` を本物のキーに自動的に置き換えます。

## ネットワークの詳細

### プロキシの仕組み

サンドボックスからのすべてのトラフィックは、ホストプロキシ `host.docker.internal:3128` を経由します：

```
エージェントコンテナ → DinD ブリッジ → サンドボックス VM → host.docker.internal:3128 → ホストプロキシ → api.anthropic.com
```

**「バイパス (Bypass)」はトラフィックがプロキシをスキップすることを意味しません。** プロキシが MITM 検査を行わずにトラフィックを通過させることを意味します。Node.js は `HTTP_PROXY` 環境変数を自動的には使用しないため、すべての HTTP/WebSocket クライアントで `HttpsProxyAgent` の明示的な設定が必要です。

### DinD マウント用の共有パス

Docker-in-Docker のバインドマウントには、ワークスペースディレクトリのみが使用可能です。ワークスペース外のパスは "path not shared" で失敗します：
- `/dev/null` → プロジェクトディレクトリ内の空ファイルに置き換え
- `/usr/local/share/ca-certificates/` → プロジェクトディレクトリに証明書をコピー
- `/home/agent/` → ワークスペース内にクローン

### git クローンと virtiofs

ワークスペースは virtiofs 経由でマウントされています。クローン中に virtiofs 上で git のパックファイル処理が破損することがあります。回避策として、まず `/home/agent` にクローンし、それからワークスペースに `mv` してください。

## トラブルシューティング

### npm install が SELF_SIGNED_CERT_IN_CHAIN で失敗する
```bash
npm config set strict-ssl false
```

### コンテナのビルドがプロキシエラーで失敗する
```bash
docker build \
  --build-arg http_proxy=$http_proxy \
  --build-arg https_proxy=$https_proxy \
  -t nanoclaw-agent:latest container/
```

### エージェントコンテナが "path not shared" で失敗する
すべてのバインドマウントパスはワークスペースディレクトリ配下である必要があります。以下を確認してください：
- NanoClaw はワークスペース内にクローンされていますか？ (`/home/agent/` ではなく)
- CA 証明書はプロジェクトルートにコピーされていますか？
- 空の `.env` シャドウファイルは作成されていますか？

### エージェントコンテナが Anthropic API に到達できない
プロキシ環境変数がエージェントコンテナに転送されているか確認してください。コンテナログに `HTTP_PROXY=http://host.docker.internal:3128` があるか確認します。

### WhatsApp エラー 405
バージョン取得処理が古いバージョンを返しています。プロキシ対応の `fetchWaVersionViaProxy` パッチが適用されているか確認してください。これは `HttpsProxyAgent` を介して `sw.js` を取得し、`client_revision` をパースします。

### WhatsApp が即座に "Connection failed" になる
プロキシバイパスが設定されていません。**ホスト**から以下を実行してください：
```bash
docker sandbox network proxy <サンドボックス名> \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

### Telegram ボットがメッセージを受信しない
1. grammy のプロキシパッチが適用されているか確認してください (`src/channels/telegram.ts` 内の `HttpsProxyAgent` を探してください)。
2. グループで使用している場合、@BotFather で Group Privacy が無効になっているか確認してください。

### git クローンが "inflate: data stream error" で失敗する
まずワークスペース以外のパスにクローンし、その後移動してください：
```bash
cd ~ && git clone https://github.com/qwibitai/nanoclaw.git && mv nanoclaw /path/to/workspace/nanoclaw
```

### WhatsApp の QR コードが表示されない
サンドボックス内で対話的に認証コマンドを実行してください (`docker sandbox exec` 経由のパイプではなく)：
```bash
docker sandbox run shell-nanoclaw-workspace
# その中で：
npx tsx src/whatsapp-auth.ts
```
