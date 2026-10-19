# TikTok Reader

TikTok Liveからコメント・ギフト等のイベントをリアルタイムで取得し、WebSocketで配信するサーバー。

**ライセンス: AGPL-3.0-only**（[`LICENSE`](LICENSE) / [`NOTICE`](NOTICE)）。ネットワーク越しに利用する人は、稼働版に対応するソースを無償で入手できます。入手方法は[対応ソース](#対応ソースagpl)を参照してください。

> このリポジトリは ai-liver の `tiktok-reader/` を独立して公開したものです。ai-liver 本体（backend / 管理画面 / AI 応答生成）は含まれず、reader の動作にも不要です。backend 連携は任意で、契約は[backend 連携の契約](#backend-連携の契約)に記載しています。

## 概要

TikTok Liveの視聴者アクションをリアルタイムで取得し、配信画面に表示するためのWebSocketサーバーです。

- **役割**: TikTok Liveからイベントを取得し、Frontend（配信画面）に配信
- **WebSocketエンドポイント**: `ws://localhost:8472/ws/events`
- **HTTPエンドポイント**: `/health`（`/healthz`）, `/ready`（`/readiness`）, `/status`, `/source`。それ以外の path は 404 です（`test-client.html` はサーバーが配信するものではなく、ファイルをブラウザで直接開く開発用ツールです）
- **ポート**: 8472（環境変数で変更可能）
- **技術スタック**: TypeScript + Node.js + WebSocket + TikTok-Live-Connector + Firestore + Pub/Sub

## 機能

### 対応イベント

- ✅ **コメント**（CHAT）- 視聴者のコメント
- ✅ **ギフト**（GIFT）- ギフト送信イベント
- ✅ **フォロー**（FOLLOW）- フォローイベント
- ✅ **シェア**（SHARE）- シェアイベント
- ✅ **サブスクライブ**（SUBSCRIBE）- サブスクライブ
- ✅ **メンバー**（MEMBER）- メンバー参加
- ✅ **ソーシャル**（SOCIAL）- その他のソーシャルアクション
- ✅ **配信終了**（STREAM_END）- 配信終了通知

### 特徴

- ✅ **マルチインスタンス対応**: Firestore分散ロック + Pub/Subによる水平スケーリング
- ✅ **複数クライアント対応**: 同一TikTok配信を複数クライアントで共有可能
- ✅ **型安全**: TypeScriptによる完全な型定義
- ✅ **テスト**: `npm run test:coverage`（Firestore エミュレータ必須）でファイル単位 50% 以上を CI のゲートにしています。カバレッジ・`npm audit` の結果は時点で変わるため数値は固定せず、CI の最新結果を参照してください
- ✅ **安定動作**: WebSocket状態管理・エラーハンドリング完備
- ✅ **グレースフルシャットダウン**: SIGTERM/SIGINTに対応
- ✅ **ヘルスチェック**: /health, /ready, /status, /source エンドポイント
- ✅ **保守性**: クリーンなコード、適切な責務分離

## セットアップ

### 1. 依存関係のインストール

`tiktok-reader` は **npm を採用** しています（`package-lock.json` で固定）。`admin-frontend` やルート workspace の bun と混在しないよう注意してください。

CI（`.github/workflows/ci.yml`）と Dockerfile はどちらも `npm ci` を使います。Node.js は `.nvmrc`（22）に合わせてください。手元でも同じ手順を使い、lockfile どおりの依存ツリーで動かしてください。

```bash
npm ci
```

ai-liver monorepo 内で install した場合は、`preinstall` フックが `bun install` / `yarn` / `pnpm` 経由の install を拒否します（このリポジトリ単独の checkout にはガードが無く、フックは何もせず成功します）。誤って `bun install` を実行すると、gitignore された `bun.lock` と不完全な `node_modules` が残るため、次で復旧してください:

```bash
rm -rf node_modules bun.lock
npm ci
```

`Dockerfile` の build context はこのディレクトリなので、イメージ内にガードは存在しません。`preinstall` はガードが見つからないときは何もせず成功するため、イメージビルドには影響しません。

**前提: bun 1.3.11 以上が必要です**（`package.json` の `engines.bun` に宣言）。テストは `bun test --isolate` で実行しますが、`--isolate` は bun 1.3.11 以降のフラグです。詳細は [テスト実行](#テスト実行) を参照してください。

```bash
# バージョン確認
bun --version

# 1.3.11 未満なら更新
bun upgrade
```

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` ファイルを編集:

```env
# Server Configuration
PORT=8472

# Google Cloud Project ID
GCP_PROJECT_ID=your-project-id

# Firestoreエミュレータ（ローカル開発用。本番では設定しない）
FIRESTORE_EMULATOR_HOST=localhost:8787
FIRESTORE_LOCK_COLLECTION=ai-liver-local-tiktok-locks

# Pub/Sub設定（オプション）
PUBSUB_TOPIC_NAME=tiktok-events
PUBSUB_SUBSCRIPTION_NAME=tiktok-events-sub

# TikTok API (Optional - for rate limit avoidance)
TIKTOK_EULER_API_KEY=

# Pub/Subエミュレータ（ローカル開発用）
# PUBSUB_EMULATOR_HOST=localhost:8085
```

**環境変数の説明:**

> 完了条件: このリストは `.env.example` に定義された全ての環境変数と1対1で一致していること。`.env.example` に変数を追加・削除した場合は、このリストも同時に更新すること。

- `PORT`: WebSocketサーバーのポート番号（デフォルト: 8472）
- `TIKTOK_EULER_API_KEY`: TikTokのレート制限を回避するためのAPIキー（オプション）
- `GCP_PROJECT_ID`: Google Cloud Project ID（Firestore / Pub/Sub用）
- `FIRESTORE_EMULATOR_HOST`: ローカル開発用Firestoreエミュレータのホスト（本番では未設定）
- `FIRESTORE_LOCK_COLLECTION`: 環境別の分散ロック用コレクション名
- `PUBSUB_EMULATOR_HOST`: ローカル開発用Pub/Subエミュレータのホスト
- `PUBSUB_TOPIC_NAME`: Pub/Subトピック名（デフォルト: tiktok-events）
- `PUBSUB_SUBSCRIPTION_NAME`: Pub/Subサブスクリプション名ベース
- `PUBSUB_DELETE_SUBSCRIPTION_ON_CLOSE`: `true` にすると、プロセス終了時にインスタンス固有のPub/Subサブスクリプションを削除する（デフォルト: `true`。`false`でも未使用サブスクリプションは下記TTL後に自動削除される）
- `PUBSUB_SUBSCRIPTION_EXPIRATION_TTL_SECONDS`: Pub/Subサブスクリプションの有効期限（秒、デフォルト: 86400）
- `INSTANCE_ID`: マルチインスタンス構成でのインスタンス識別子（オプション。未設定の場合は自動生成）
- `BACKEND_API_URL`: Backend REST の呼び出し先URL（`/api/v1` まで含める。例: `http://localhost:8471/api/v1`）。**既定値はなく、未設定なら backend 連携は無効**（render token 認証は常に拒否、gift / comment / viewer-count の転送は行いません）。shared secret 認証だけで単独利用する場合は未設定のままにします
- `BACKEND_INGRESS_TOKEN`: Backend イングレストークン（Issue #726）。`/api/v1/internal/tiktok-reader/*` を呼び出す際の `X-Ingress-Token` 値。未設定の場合はBackend側で401拒否される
- `BACKEND_RENDER_VERIFY_TIMEOUT_MS`: WebSocket接続時にBackendのRenderTokenVerifierを呼び出す際のタイムアウト（ミリ秒、オプション）
- `TIKTOK_READER_RATE_LIMIT_ENABLED`: 接続元IPごとのレート制限を有効にするか（Issue #589、デフォルト: `true`）
- `TIKTOK_READER_RATE_LIMIT_MAX`: レート制限のウィンドウあたり最大接続数（デフォルト: 60）
- `TIKTOK_READER_RATE_LIMIT_WINDOW_MS`: レート制限のウィンドウ幅（ミリ秒、デフォルト: 60000）
- `TIKTOK_READER_TRUST_PROXY`: レート制限のキー算出時にプロキシ経由の送信元IP（`X-Forwarded-For`等）を信頼するか（デフォルト: `true`）
- `TIKTOK_READER_TRUST_PROXY_HOPS`: 信頼するプロキシのホップ数。Cloud Run等に直結する場合は0、前段に信頼済みproxyを置く場合はそのhop数を指定する
- `TIKTOK_READER_MAX_TOTAL_CLIENTS`: 本インスタンスが保持する WebSocket クライアント総数の上限（Issue #590、`0` または未設定は制限なし）。超過した `connect` は `CONNECTION_LIMIT_EXCEEDED` で拒否し close code 1013 で切断します
- `TIKTOK_READER_MAX_CLIENTS_PER_USER`: 1 TikTok ユーザー（配信者）あたりの WebSocket クライアント数の上限（Issue #590、`0` または未設定は制限なし）
- `TIKTOK_READER_SOURCE_URL`: `GET /source` が返す、稼働版に対応する公開済みソースの URL。同名の Docker build arg で image の既定値を設定でき、実行時の環境変数が優先されます。未設定・空なら `null` です。改変版をネットワークサービスとして動かす場合は必ず設定してください
- `SOURCE_COMMIT`: 稼働版の識別子（`GET /source` の `version`）。Docker image では build arg `SOURCE_COMMIT` から設定されます
- `TIKTOK_READER_SHARED_SECRET`: WebSocket接続のshared secret認証用トークン（Issue #825 / #1437）。設定方法・使用方法は[使い方](#1-websocket接続)および[セキュリティ](#セキュリティ)を参照

## 開発

### 開発サーバー起動

```bash
npm run dev
```

Node.js 22 の組込み watch モードと `ts-node` で起動し、読み込まれたソースコードの変更時に自動的に再起動します。`tsconfig.json` や環境変数の設定を変更した場合は、開発サーバーを手動で再起動してください。

### テスト実行

**bun 1.3.11 以上が必須です。** テストは `bun test --isolate` で実行しますが、`--isolate` は bun 1.3.11 以降のフラグで、それ以前の bun はこのフラグをエラーにせず黙って無視します。すると `mock.module` の差し替えがテストファイル間に漏れ、コードが正しくても 10 件前後のテストが誤って fail します（Issue #1846）。CI は bun 1.3.14 を使うため、この誤検知はローカル環境だけで発生します。

`bunfig.toml` の `[test] preload` には `scripts/preload-bun-version.mjs`（バージョン検査）と `scripts/preload-test-timeout.mjs`（テストのデフォルトタイムアウト設定。Issue #1874）の 2 つを登録しています。前者がバージョンを検査し、下限未満なら理由を表示してテスト実行前に停止します。ガードが効くのは **`tiktok-reader/` を cwd にして実行した場合**です（`npm test` / `bun run test` / このディレクトリでの直接の `bun test` はいずれも効きます。Issue #1865）。`bunfig.toml` は cwd から解決されるため、**リポジトリルートを cwd にして `bun test tiktok-reader/...` を実行すると preload が読まれず、ガードは効きません**。この経路では `package.json` の `test` スクリプトも通らないため `--isolate` が失われ、上記 #1846 の偽 fail をガードのメッセージ無しで踏みます。**このパッケージのテストは必ず `tiktok-reader/` を cwd にして実行してください。**検査本体は同梱の `scripts/vendor/bun-version-guard.mjs`、タイムアウト設定は `scripts/vendor/bun-test-timeout.mjs` です（ai-liver monorepo の共有ツールの複製で、monorepo 側のテストが一致を検査します）。

```bash
# バージョン確認（1.3.11 未満なら bun upgrade で更新）
bun --version
bun upgrade
```

```bash
# 全テスト実行
npm test

# ウォッチモード
npm run test:watch

# カバレッジレポート生成
npm run test:coverage

# テスト名で絞り込み（-t は正規表現）
npm test -- -t BackendApiService
```

Firestore を使うテストは、Firestore エミュレータ（`FIRESTORE_EMULATOR_HOST`）が無いと skip ではなく失敗（カバレッジ割れ）になります。起動例は[単独での起動例](#単独での起動例)を参照してください。

#### 実 entrypoint の runtime smoke

Node 22 でビルド済み `dist/server.js` と同梱 mock backend を起動し、認証・入力拒否・単一sessionの follower 配送（Pub/Sub → WebSocket）・SIGTERM正常終了を検証します。通常のBunテストとcoverageには含めません。

Docker が使える環境では、reader を cwd にして次を Bash で実行できます。host の空きportに公開し、成功・失敗のどちらでもcontainerを停止します。

```bash
(
  set -euo pipefail
  smoke_name="reader-smoke-$$"
  trap 'docker rm -f "${smoke_name}-firestore" "${smoke_name}-pubsub" >/dev/null 2>&1 || true' EXIT
  emulator_image=gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators
  docker run -d --rm --name "${smoke_name}-firestore" -p 127.0.0.1::8080 "$emulator_image" \
    gcloud emulators firestore start --host-port=0.0.0.0:8080 --project=reader-smoke
  docker run -d --rm --name "${smoke_name}-pubsub" -p 127.0.0.1::8085 "$emulator_image" \
    gcloud beta emulators pubsub start --host-port=0.0.0.0:8085 --project=reader-smoke
  for endpoint in firestore:8080 pubsub:8085; do
    container="${smoke_name}-${endpoint%:*}"
    port="${endpoint#*:}"
    for attempt in {1..60}; do
      docker exec "$container" bash -c ": > /dev/tcp/127.0.0.1/$port" 2>/dev/null && break
      sleep 1
    done
    docker exec "$container" bash -c ": > /dev/tcp/127.0.0.1/$port"
  done
  export FIRESTORE_EMULATOR_HOST="$(docker port "${smoke_name}-firestore" 8080/tcp)"
  export PUBSUB_EMULATOR_HOST="$(docker port "${smoke_name}-pubsub" 8085/tcp)"
  npm run build
  npm run test:runtime
)
```

既存emulatorを使う場合は、両hostを設定して `npm run build && npm run test:runtime` を実行します。hostはloopbackの `host:port` が必須で、未設定・到達不能はskipせず失敗します。fixture名は実行ごとに確保し、終了時にprocess・lease・topic・subscriptionを片付けます。作業用の一時cwdと明示envを使うため、repoの `.env`・GCP資格情報は読みません。外部hostへの接続を拒否し、実TikTok配信は使いません。複数instanceのsession分離や本体への保存は検証対象外です。失敗時はreaderのstdout/stderrを表示します。

### Lint

```bash
# ESLint（Issue #2658）
npm run lint

# 自動修正可能な違反を修正
npm run lint:fix
```

### ビルド

```bash
npm run build
```

`dist/` ディレクトリにJavaScriptファイルが生成されます。

### 本番環境起動

```bash
npm start
```

### 単独での起動例

ai-liver 本体なしで、reader + Firestore / Pub/Sub エミュレータ + mock backend を起動できます（値は開発用のダミーです）。

```bash
docker compose -f examples/docker-compose.yml up --build
curl http://localhost:8472/ready      # 200
curl http://localhost:8472/source     # ライセンス・稼働版・ソース URL
# shared secret で接続: ws://localhost:8472/ws/events?secret=dev-shared-secret
# render token で接続   : ?session_id=dev-session + subprotocol ai-liver-render-v1, ai-liver-render-token.dev-render-token
```

mock backend（`examples/mock-backend.mjs`）は[backend 連携の契約](#backend-連携の契約)の 4 経路を実装し、受信したイベントを `GET http://localhost:8471/received` で確認できます。

## 使い方

### 1. WebSocket接続

`/ws/events` への接続には認証が必須です（詳細は[セキュリティ](#セキュリティ)を参照）。shared secret / render token のいずれかで認証できない接続は `401 Unauthorized` で拒否されます。ローカル開発・動作確認では shared secret 方式が簡単です。

**shared secret 認証（クエリパラメータ、ブラウザ向け）**

`.env` で `TIKTOK_READER_SHARED_SECRET` を設定したうえで接続します。ブラウザの `WebSocket` API はカスタムヘッダを送れないため、`?secret=` クエリパラメータを使います:

```javascript
const secret = 'your-shared-secret'; // TIKTOK_READER_SHARED_SECRETと同じ値
const ws = new WebSocket(`ws://localhost:8472/ws/events?secret=${encodeURIComponent(secret)}`);

ws.onopen = () => {
  console.log('WebSocket接続成功');
};

ws.onclose = (event) => {
  // 401の場合はTIKTOK_READER_SHARED_SECRETとsecretの値が一致しているか確認
  console.log('WebSocket接続終了', event.code, event.reason);
};
```

**shared secret 認証（ヘッダ、Node.jsクライアント向け）**

`ws` パッケージなどヘッダ送信に対応したクライアントでは `X-Reader-Secret` ヘッダを使えます（クエリよりアクセスログに残りにくいため推奨）:

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8472/ws/events', {
  headers: { 'X-Reader-Secret': 'your-shared-secret' },
});
```

**render token 認証（ブラウザの描画クライアント向け）**

backend が発行する短期トークンを `Sec-WebSocket-Protocol: ai-liver-render-v1, ai-liver-render-token.<token>` と `?session_id=<session_id>` で提示する方式です。reader は `BACKEND_API_URL` の backend に問い合わせてトークンを検証します（`BACKEND_API_URL` 未設定時は常に 401）。

```javascript
const ws = new WebSocket(
  `ws://localhost:8472/ws/events?session_id=${encodeURIComponent(sessionId)}`,
  ['ai-liver-render-v1', `ai-liver-render-token.${renderToken}`]
);
```

この方式で接続した WebSocket は、**認証に使った session と、その session の配信者にだけ** `connect` できます（[認証 session との結合](#認証-session-との結合)）。共有 secret 経路はサーバー間用途です。共有 secret を一般ブラウザへ配布しないでください。

### 2. TikTok Live接続リクエスト

```javascript
ws.send(JSON.stringify({
  type: 'connect',
  liveUrl: 'https://www.tiktok.com/@username/live',
  sessionId: 'your-session-id'
}));
```

`sessionId` は認証した session と一致している必要があります（render token 認証の場合）。`liveUrl` は 512 文字、`sessionId` は 128 文字までです。

**対応URL形式:**
- `https://www.tiktok.com/@username/live`
- `https://tiktok.com/@username/live`
- `@username`
- `username`

### 3. イベント受信

```javascript
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case 'comment':
      console.log(`${message.data.username}: ${message.data.text}`);
      break;
    case 'gift':
      console.log(`${message.data.username}がギフト「${message.data.giftType}」を送信`);
      break;
    case 'follow':
      console.log(`${message.data.username}がフォロー`);
      break;
    // ... その他のイベント
  }
};
```

## WebSocketメッセージ仕様

### クライアント → サーバー

#### 接続リクエスト

```json
{
  "type": "connect",
  "liveUrl": "https://www.tiktok.com/@username/live",
  "sessionId": "uuid-here"
}
```

### サーバー → クライアント

#### コメントイベント

```json
{
  "type": "comment",
  "data": {
    "id": "msg123",
    "tiktokUserId": "user123",
    "username": "UserName",
    "text": "こんにちは！",
    "timestamp": "2025-10-22T12:00:00.000Z"
  }
}
```

#### ギフトイベント

```json
{
  "type": "gift",
  "data": {
    "tiktokUserId": "user123",
    "username": "UserName",
    "giftType": "Rose",
    "giftAmount": 100,
    "giftCount": 5,
    "timestamp": "2025-10-22T12:00:00.000Z"
  }
}
```

#### シンプルイベント（follow, share, subscribe, member）

```json
{
  "type": "follow",
  "data": {
    "id": "event123",
    "tiktokUserId": "user123",
    "username": "UserName",
    "timestamp": "2025-10-22T12:00:00.000Z"
  }
}
```

#### ステータスイベント

```json
{
  "type": "status",
  "status": "connected",
  "message": "TikTok Liveに接続しました"
}
```

**status値:**
- `connected`: TikTok Liveに接続成功
- `disconnected`: TikTok Live配信終了

#### エラーイベント

```json
{
  "type": "error",
  "data": {
    "code": "INVALID_URL",
    "message": "エラーメッセージ"
  }
}
```

**エラーコード（`data.code`）:**
- `CONNECTION_FAILED`: TikTok Live接続失敗
- `INVALID_URL`: 不正なTikTok Live URL（文字列でない・512 文字超を含む）
- `INVALID_MESSAGE`: 不正なメッセージ形式（JSON でない・`sessionId` の型や長さが不正）
- `SESSION_MISMATCH`: 認証した session と `connect` の `sessionId` が一致しない（close code 1008）
- `STREAMER_NOT_ALLOWED`: 認証した session の配信者と `connect` の `liveUrl` が一致しない（close code 1008）
- `SESSION_CONFLICT`: 同じ配信者に別の session が接続中（close code 1008）
- `CONNECTION_LIMIT_EXCEEDED`: 同時接続数の上限（close code 1013）
- `INTERNAL_ERROR`: サーバー内部エラー

## テストクライアント

ブラウザで動作確認できるテストクライアントが付属しています。

### 起動方法

1. サーバーを起動
   ```bash
   npm run dev
   ```

2. ブラウザで`test-client.html`を開く

3. WebSocket URL・TikTok Live URL・session ID を入力して接続。認証情報（開発用の shared secret、または render token）は入力したときだけ送られます（既定は認証なしで、認証必須の reader では 401 になります）

## ディレクトリ構成

```
tiktok-reader/
├── src/
│   ├── server.ts                      # メインエントリーポイント
│   ├── routes/
│   │   ├── index.ts                   # WebSocketルーティング
│   │   └── auth.ts                    # WebSocket認証（shared secret / render token、Issue #825 / #1437）
│   ├── handlers/
│   │   ├── websocket-handler.ts       # WebSocket接続ハンドラー
│   │   ├── health-handler.ts          # ヘルスチェックハンドラー
│   │   └── rate-limit-middleware.ts   # IPベースのレート制限ミドルウェア（Issue #589）
│   ├── services/
│   │   ├── tiktok-service.ts          # TikTok Live接続・イベント処理
│   │   ├── tiktok-event-handlers.ts   # TikTokイベントごとのハンドラー
│   │   ├── connection-manager.ts      # 接続マネージャー（複数クライアント対応）
│   │   ├── connection-limits.ts       # 同時接続数の上限管理
│   │   ├── connection/
│   │   │   ├── connection-broadcaster.ts     # 接続イベント配信（同一プロセス内のサブスクライバ向け）
│   │   │   ├── connection-limits-guard.ts    # 接続上限チェック
│   │   │   ├── connection-lock-lifecycle.ts  # 分散ロックのライフサイクル管理
│   │   │   ├── connection-message-router.ts  # 接続ごとのメッセージルーティング
│   │   │   ├── connection-status-messages.ts # ステータスメッセージ組み立て
│   │   │   ├── connection-types.ts           # 接続マネージャーで共有する型定義
│   │   │   └── leader-watcher.ts             # 分散ロックのリーダー監視・フェイルオーバー
│   │   ├── distributed-lock-service.ts # 分散ロックサービス（Firestore）
│   │   ├── lock/
│   │   │   └── firestore-lock-store.ts # Firestore 分散ロックストア実装（Issue #1816、d3398a99b）
│   │   ├── pubsub-service.ts          # Pub/Subサービス（GCP）
│   │   ├── rate-limiter.ts            # IPベースのレート制限ロジック
│   │   ├── viewer-count-forwarder.ts  # 視聴者数を backend にフォワードする補助
│   │   └── backend-api-service.ts     # Backend API連携
│   ├── types/
│   │   ├── websocket/
│   │   │   └── index.ts               # WebSocketメッセージ型定義
│   │   ├── tiktok/
│   │   │   └── index.ts               # TikTokイベント型定義
│   │   └── api/
│   │       └── index.ts               # Backend API型定義
│   └── utils/
│       ├── logger.ts                  # ロギング
│       ├── url-parser.ts              # TikTok URL解析
│       ├── instance-id.ts             # インスタンスID取得
│       ├── hash-for-log.ts            # ログ出力用の安全なハッシュ
│       └── deterministic-id.ts        # 入力から決定論的にIDを生成
├── tests/                             # テストファイル
│   ├── services/
│   ├── handlers/
│   ├── routes/
│   ├── utils/
│   └── integration/
├── dist/                              # ビルド出力（.gitignore）
├── coverage/                          # カバレッジレポート（.gitignore）
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── .env.example
├── .gitignore / .dockerignore         # 秘密情報・生成物を Git / Docker context から除外
├── .nvmrc                             # Node.js のバージョン
├── Dockerfile
├── LICENSE / NOTICE / SOURCE.md       # AGPL-3.0-only・第三者表示・対応ソース案内
├── scripts/                           # bun preload ガード（vendor/ は同梱）・依存ライセンス表示の生成
├── examples/                          # 単独起動例（docker-compose.yml, mock-backend.mjs）
├── .github/workflows/ci.yml           # 公開向け CI（GitHub-hosted、secrets 不要）
├── test-client.html                   # ブラウザテストクライアント
└── README.md
```

## 技術仕様

### 使用ライブラリ

**本番依存:**
- `ws@^8.21.3` - WebSocketサーバー
- `tiktok-live-connector@2.1.0` - TikTok Live接続
- `@google-cloud/pubsub@^6.0.1` - インスタンス間イベント同期
- `@google-cloud/firestore@^9.0.0` - 分散ロック（Firestore）
- `axios@^1.19.0` - HTTPクライアント
- `dotenv@^16.4.0` - 環境変数管理

**開発依存:**
- `typescript@^5.5.0` - TypeScript
- `ts-node@^10.9.2` - TypeScript実行
- `@types/bun@^1.3.14` - Bun test / runtime型定義


## 注意事項

### TikTok-Live-Connector

- **非公式ライブラリ**: TikTokの仕様変更で動作しなくなる可能性があります
- **使用version**: 現在`tiktok-live-connector@2.1.0`を使用
- **固定の継続**: `2.4.0`では接続成功後にコメントイベントを受信できない事象をdev実配信で確認したため、本番で動作確認済みの`2.1.0`へ固定しています。この固定はIssue #2347の調査を経て継続と判断しました（下記2点の理由による）
- **`2.4.4`へ上げない理由1（ライセンス）**: `2.4.1`以降、connectorのライセンスが`MIT`から`AGPL-3.0-only`へ変更されました。追加許諾のSection 18は商用利用を許しますが、Section 19が「WebSocket relay service」を含む商用・クローズドソースのSaaSを明示的に除外します。tiktok-readerはCloud Run上でTikTokコメントをWebSocket配信するまさにその形態のため、採用には法務判断が必要です
- **`2.4.4`へ上げない理由2（回帰未修正）**: 上流の`v2.4.0..v2.4.4`のコミットはREADME / LICENSE / export修正と`WebcastLinkMicBattleItemCard`追加のみで、コメント受信経路には一切手が入っていません。`2.4.0`で確認した事象が解消している根拠がありません
- **`npm audit`の解消**: `2.1.0`は`package.json`で`protobufjs@^6.11.2`を宣言しますが、配布コードからは一度も`require`しません（実デコードは`@bufbuild/protobuf`）。この死んだ依存だけが`npm audit`のcritical 1 / high 1の原因だったため、`package.json`の`overrides`で`protobufjs@^7.6.5`へ寄せて解消しています（検証時点の`npm audit`では、この項目に由来する指摘は解消）。`7.6.5`は`@google-cloud/firestore` / `@google-cloud/pubsub`が既に解決している版のため、追加インストールは発生しません。overridesが外れると無言でauditが赤に戻るため、`tests/regression/protobufjs-advisory.test.ts`で固定しています
- **APIキー推奨**: レート制限回避のため`TIKTOK_EULER_API_KEY`の設定を推奨

### 制限事項

- **自動再接続なし**: TikTok接続が切れた場合、自動再接続しません（クライアントから再接続が必要）

### セキュリティ

WebSocket 接続は以下の多層防御で保護されています。

- **Shared secret 認証**: 環境変数 `TIKTOK_READER_SHARED_SECRET` を設定し、信頼済みクライアントは `X-Reader-Secret: <secret>` ヘッダ（推奨）または `?secret=<secret>` を付与して接続する（`src/routes/auth.ts`、Issue #1437）
- **Render token 認証**: 配信中の描画クライアントは、backend が検証する短期トークンを `Sec-WebSocket-Protocol: ai-liver-render-v1, ai-liver-render-token.<token>` と `?session_id=<session_id>` で提示する（`src/routes/auth.ts`、Issue #825）
- **Fail-closed**: Shared secret が未設定・不一致でも認証はスキップせず、render token 検証に成功しない接続は `401 Unauthorized` で拒否する。認証サービス（backend）が未設定・障害・`live_url` 欠落のときも拒否する
- **入力検証**: `connect` の `liveUrl` / `sessionId` の型と長さを検証する。WebSocket のメッセージサイズは `ws` の既定上限（100 MiB）が適用されるため、公開運用では前段 proxy でも上限を設ける
- **診断 API とログ**: 認証なしで公開される `/status` は配信者名を返さず、接続数・クライアント数・leader 数・上限値だけを返す。ログには配信者名・視聴者名を平文で出さず、ハッシュのみを記録する
- **TLS / proxy**: reader 自体は TLS を終端しない。TLS 終端する proxy の背後で動かし、`TIKTOK_READER_TRUST_PROXY` / `TIKTOK_READER_TRUST_PROXY_HOPS` を実際の hop 数に合わせる
- **IP ベースの Rate Limiting**: `src/routes/index.ts` で接続元 IP ごとの接続レートを制限する（Issue #589）
- **接続数制限**: `src/services/connection-limits.ts` で同時接続数の上限を管理する
- **本番運用**: TLS を必須とし、Shared secret 経路を使う場合は十分な長さの値を Secret Manager から注入してローテーションする

### 認証 session との結合

render token で認証した WebSocket 接続は、upgrade 時に確定した **session ID** と、bootstrap 応答の `live_url` から決まる **許可配信者** を保持します。`connect` 本文がこの範囲を外れる（別 session・別配信者・接続後の差し替え）と、上流の TikTok 接続や backend 転送より前に拒否します（[エラーコード](#エラーイベント)）。bootstrap に `live_url` が無い session は許可配信者を決められないため 401 です。shared secret 経路はサーバー間用途で、session / 配信者を制限しません。

**複数 session の契約**: 配信者ごとの TikTok 接続・分散ロック・backend の保存先 session は 1 つなので、「1 配信者 = 同時に 1 session」です。接続中の配信者に別 session から接続すると `SESSION_CONFLICT` で拒否します。同一 session の複数クライアントは相乗りできます。全クライアントが切断すると、別 session が接続できます。この判定は同一インスタンス内の接続状態に対するものです。

配信者名の大文字・小文字は区別しません。shared secret 経路で session を省略・空文字にした接続は、同じく session 未指定の接続とのみ共有できます。接続後に同じ WebSocket から別 session への差し替えを要求した場合も拒否し、元の接続を解放します。

### backend 連携の契約

`BACKEND_API_URL`（`/api/v1` まで含む）を設定したときだけ、reader は次の 4 経路を呼びます。

| 用途 | API | 認証 |
| --- | --- | --- |
| render token 検証 | `GET /render/sessions/:id/bootstrap` | `Authorization: Bearer <render token>`。200 かつ `platform=tiktok`。`live_url` で許可配信者を決定 |
| ギフト保存 | `POST /internal/tiktok-reader/gift` | `X-Ingress-Token: $BACKEND_INGRESS_TOKEN` |
| コメント保存 | `POST /internal/tiktok-reader/session/:id/comment` | 同上 |
| 視聴者数保存 | `POST /internal/tiktok-reader/session/:id/viewer-count` | 同上 |

転送の失敗は reader のログに残るだけで、WebSocket 配信は止まりません。reader が使う bootstrap 応答のフィールドは `platform` と `live_url` だけです。実装例は `examples/mock-backend.mjs` です。

## 対応ソース（AGPL）

reader は AGPL-3.0-only です。稼働中のインスタンスの `GET /source` が、ライセンス・稼働版（`version`）・対応ソースの URL（`sourceUrl`）を返します。リリースごとのソース・image・稼働版の対応付けと入手方法は [`SOURCE.md`](SOURCE.md)、第三者ソフトウェアの表示は [`NOTICE`](NOTICE) と `npm run notices`（Docker image には `/app/THIRD_PARTY_NOTICES.txt` として同梱）を参照してください。`npm run sbom` で SBOM（CycloneDX）を生成できます。

source URL は、対象 image のソースを認証なしで取得できる公開済み tag を確認して設定します。Cloud Build の `_TIKTOK_READER_SOURCE_URL` は空が既定で、公開ミラーの対象外である `develop` の URL を自動生成しません。既存の Cloud Run 環境変数は image の値を上書きするため、deploy・rollback 時は設定と `GET /source` の両方を確認してください。URL の設定だけではソース公開は完了しません。

`package.json` は `private: true` で、npm への誤 publish を防いでいます。npm パッケージは対応ソースの全体（lock・Dockerfile・LICENSE 等）を含まないため、ソース提供の手段として扱いません。

## トラブルシューティング

### TikTok Liveに接続できない

1. **URLの確認**
   - TikTok Live URLが正しい形式か確認
   - `@username`部分が正しいか確認

2. **配信状態の確認**
   - 実際にTikTok Liveが配信中か確認
   - 配信が終了していないか確認

3. **APIキーの確認**
   - `TIKTOK_EULER_API_KEY`が設定されているか確認
   - APIキーが有効か確認

4. **ログの確認**
   ```bash
   # エラーログを確認
   npm run dev
   ```

### WebSocket接続が切断される

1. **ネットワーク安定性**
   - ネットワーク接続が安定しているか確認

2. **TikTok接続エラー**
   - TikTok側でエラーが発生していないか確認
   - ログで`TikTok Live接続エラー`を確認

3. **サーバー負荷**
   - サーバーリソース（CPU、メモリ）を確認
