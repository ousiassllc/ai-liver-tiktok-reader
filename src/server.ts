import { WebSocketServer } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import dotenv from 'dotenv';
import {
  setupWebSocketRoutes,
  handleWebSocketConnection,
  setConnectionManager,
  setWebSocketRateLimiter,
  setRenderTokenVerifier,
  resetRouterContext,
} from './routes';
import { DistributedLockService } from './services/distributed-lock-service';
import { PubSubService } from './services/pubsub-service';
import { ConnectionManager } from './services/connection-manager';
import { BackendApiService } from './services/backend-api-service';
import { loadConnectionLimitsFromEnv } from './services/connection-limits';
import {
  RateLimiterConfig,
  createRateLimiterFromEnv,
} from './services/rate-limiter';
import { HealthHandler } from './handlers/health-handler';
import { applyHttpRateLimit } from './handlers/rate-limit-middleware';
import { getInstanceId } from './utils/instance-id';
import { logger } from './utils/logger';

dotenv.config();

const PORT = parseInt(process.env.PORT || '8472');

/**
 * Issue #925: 従来モジュール直下の `let` で保持していた依存を 1 つの `AppContext` に集約する。
 * `initializeServices(env)` が新しい context を返し、`startServer(ctx)` に渡すことで
 * テストやホットリロード時に前回状態が漏れないようにする。
 */
export interface AppContext {
  instanceId: string;
  lockService: DistributedLockService;
  pubsubService: PubSubService;
  connectionManager: ConnectionManager;
  healthHandler: HealthHandler;
  rateLimiterConfig: RateLimiterConfig;
  isShuttingDown: boolean;
}

export async function initializeServices(): Promise<AppContext> {
  const instanceId = await getInstanceId();
  const projectId = process.env.GCP_PROJECT_ID || 'ai-liver-local';
  const lockCollection = process.env.FIRESTORE_LOCK_COLLECTION || 'ai-liver-local-tiktok-locks';

  logger.info('サービス初期化中...', { instanceId, projectId, lockCollection });

  // Issue #925: routes モジュールの内部状態も新しい context のためにリセットする。
  // 別プロセスで複数回 initializeServices() が呼ばれるケース（テスト・ホットリロード）で
  // 前回の verifier / rate limiter が漏れないようにする。
  resetRouterContext();

  const lockService = new DistributedLockService(projectId, lockCollection, instanceId);
  await lockService.waitForReady();

  const pubsubService = new PubSubService(projectId, instanceId);
  await pubsubService.initialize();

  // Issue #590: 同時接続数制限を環境変数から読み込む。0 は制限なし。
  const limits = loadConnectionLimitsFromEnv();
  logger.info('接続数制限設定', {
    maxTotalClients: limits.maxTotalClients || 'unlimited',
    maxClientsPerUser: limits.maxClientsPerUser || 'unlimited',
  });

  const connectionManager = new ConnectionManager(lockService, pubsubService, limits);
  setConnectionManager(connectionManager);

  const healthHandler = new HealthHandler({
    lockService,
    pubsubService,
    connectionManager,
    instanceId,
  });

  // Issue #825: render page (public バンドル) は shared secret を持てないため、
  // frontend が生成する render token を backend で検証する経路を用意する。
  // Issue #2782: backend 連携は BACKEND_API_URL を明示したときだけ有効。未設定なら
  // render token 検証は fail-closed、gift / comment / viewer-count の転送は行わない。
  const backendApi = new BackendApiService();
  setRenderTokenVerifier(backendApi);
  if (!backendApi.isConfigured()) {
    logger.info('BACKEND_API_URL 未設定: backend 連携（render token 認証・イベント転送）は無効');
  }

  // Issue #589: IP ベースのレート制限を初期化して HTTP / WS 両方に共有する。
  const rateLimiterConfig = createRateLimiterFromEnv();
  if (rateLimiterConfig.enabled && rateLimiterConfig.limiter) {
    rateLimiterConfig.limiter.startCleanupTimer();
    setWebSocketRateLimiter(
      rateLimiterConfig.limiter,
      rateLimiterConfig.trustProxy,
      rateLimiterConfig.trustedProxyHops
    );
    logger.info(
      `レート制限有効: max=${rateLimiterConfig.maxRequests}/${rateLimiterConfig.windowMs}ms trustProxy=${rateLimiterConfig.trustProxy} trustedProxyHops=${rateLimiterConfig.trustedProxyHops}`
    );
  } else {
    setWebSocketRateLimiter(
      null,
      rateLimiterConfig.trustProxy,
      rateLimiterConfig.trustedProxyHops
    );
    logger.info('レート制限: 無効化');
  }

  logger.info('サービス初期化完了');

  return {
    instanceId,
    lockService,
    pubsubService,
    connectionManager,
    healthHandler,
    rateLimiterConfig,
    isShuttingDown: false,
  };
}

export async function startServer(port: number = PORT): Promise<HttpServer> {
  const ctx = await initializeServices();

  const server = createServer((req, res) => {
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
      // Issue #589: 非 WebSocket リクエストに IP ベースのレート制限を適用。
      // health/ready 系は Cloud Run probe を落とさないため exempt。
      if (applyHttpRateLimit(req, res, ctx.rateLimiterConfig)) {
        return;
      }
      ctx.healthHandler.handleRequest(req, res);
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    setupWebSocketRoutes(wss, request, socket, head);
  });

  wss.on('connection', handleWebSocketConnection);

  server.listen(port, () => {
    logger.info(`TikTok Reader起動: ws://localhost:${port}/ws/events`);
    logger.info('HTTPエンドポイント: /health, /ready, /status');
    logger.info(`インスタンスID: ${ctx.instanceId}`);
  });

  const shutdown = async () => {
    if (ctx.isShuttingDown) return;
    ctx.isShuttingDown = true;

    logger.info('シャットダウン開始...');

    const forceExitTimeout = setTimeout(() => {
      logger.error('タイムアウト - 強制終了');
      process.exit(1);
    }, 10000);

    try {
      // サービスのクリーンアップ
      if (ctx.rateLimiterConfig.limiter) {
        try {
          ctx.rateLimiterConfig.limiter.stopCleanupTimer();
        } catch (error) {
          logger.error('RateLimiter停止エラー:', error);
        }
      }
      try {
        await ctx.connectionManager.closeAll();
      } catch (error) {
        logger.error('ConnectionManagerクローズエラー:', error);
      }
      try {
        await ctx.pubsubService.close();
      } catch (error) {
        logger.error('PubSubServiceクローズエラー:', error);
      }
      try {
        await ctx.lockService.close();
      } catch (error) {
        logger.error('LockServiceクローズエラー:', error);
      }

      // サーバーのクローズをPromiseでラップ
      await new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) {
            logger.error('HTTPサーバークローズエラー:', err);
          }
          wss.close((wsErr) => {
            if (wsErr) {
              logger.error('WebSocketサーバークローズエラー:', wsErr);
            }
            resolve();
          });
        });
      });

      clearTimeout(forceExitTimeout);
      logger.info('シャットダウン完了');
      process.exit(0);
    } catch (error) {
      logger.error('シャットダウンエラー:', error);
      clearTimeout(forceExitTimeout);
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

// Issue #925: エントリポイントとして直接起動されたときのみ startServer() を呼ぶ。
// テストからは startServer() を named import して個別の port で起動できる。
if (require.main === module) {
  startServer().catch((error) => {
    logger.error('サーバー起動エラー:', error);
    process.exit(1);
  });
}
