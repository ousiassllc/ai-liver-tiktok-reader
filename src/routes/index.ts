import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketHandler } from '../handlers/websocket-handler';
import { ConnectionManager } from '../services/connection-manager';
import { RateLimiter, extractClientIp } from '../services/rate-limiter';
import { logger } from '../utils/logger';
import {
  authorizeRenderToken,
  UNRESTRICTED_SCOPE,
  isSharedSecretAuthorized,
  type RenderTokenVerifier,
  type WebSocketAuthScope,
} from './auth';

// Issue #825: `RenderTokenVerifier` は auth.ts の canonical 定義を再エクスポートする
// (既存 consumer との後方互換のため)。
export type { RenderTokenVerifier } from './auth';

/**
 * Issue #925: 従来モジュール直下の `let` で保持していた router 依存を 1 つのオブジェクトに
 * 集約する。setter は同じインスタンスを書き換えるだけなので既存呼び出しの挙動は変わらないが、
 * `resetRouterContext()` で明示的に初期化できるため Jest 等でモジュールを reset せずに
 * テスト独立性を確保できる。
 */
export interface RouterContext {
  connectionManager: ConnectionManager | null;
  wsRateLimiter: RateLimiter | null;
  wsRateLimiterTrustProxy: boolean;
  wsRateLimiterTrustedProxyHops: number;
  renderTokenVerifier: RenderTokenVerifier | null;
}

function createDefaultRouterContext(): RouterContext {
  return {
    connectionManager: null,
    wsRateLimiter: null,
    wsRateLimiterTrustProxy: true,
    wsRateLimiterTrustedProxyHops: 0,
    renderTokenVerifier: null,
  };
}

const routerContext: RouterContext = createDefaultRouterContext();

export function setConnectionManager(manager: ConnectionManager): void {
  routerContext.connectionManager = manager;
}

/**
 * Issue #825: render token を検証するためのバックエンドクライアントを差し込む。
 * `null` を渡すと render token 経路の認証は無効化される (shared secret のみ有効)。
 */
export function setRenderTokenVerifier(verifier: RenderTokenVerifier | null): void {
  routerContext.renderTokenVerifier = verifier;
}

/**
 * WebSocket upgrade レイヤ用のレート制限を注入する。
 *
 * Issue #589: /ws/events の接続を IP ベースで制限する。
 * limiter=null を渡すと制限を無効化する（テストや後方互換用）。
 */
export function setWebSocketRateLimiter(
  limiter: RateLimiter | null,
  trustProxy = true,
  trustedProxyHops = 0
): void {
  routerContext.wsRateLimiter = limiter;
  routerContext.wsRateLimiterTrustProxy = trustProxy;
  routerContext.wsRateLimiterTrustedProxyHops = trustedProxyHops;
}

/**
 * Issue #925: テスト間で router 依存を確実に初期化するためのヘルパ。
 * 本番コードからも呼び出せるが基本的にはユニットテスト向け。
 */
export function resetRouterContext(): void {
  const fresh = createDefaultRouterContext();
  routerContext.connectionManager = fresh.connectionManager;
  routerContext.wsRateLimiter = fresh.wsRateLimiter;
  routerContext.wsRateLimiterTrustProxy = fresh.wsRateLimiterTrustProxy;
  routerContext.wsRateLimiterTrustedProxyHops = fresh.wsRateLimiterTrustedProxyHops;
  routerContext.renderTokenVerifier = fresh.renderTokenVerifier;
}

/**
 * Issue #925: 現在の router 依存状態を読み取るための test helper。
 * 本番コードからは呼び出さない。
 */
export function getRouterContext(): Readonly<RouterContext> {
  return routerContext;
}

/**
 * Issue #1437: /ws/events 認証前のレート制限判定を切り出したヘルパ。
 * `true` を返した場合は 429 応答済みなので caller は早期 return する。
 */
function rejectIfRateLimited(request: IncomingMessage, socket: Duplex): boolean {
  if (!routerContext.wsRateLimiter) return false;
  const clientIp = extractClientIp(
    request,
    routerContext.wsRateLimiterTrustProxy,
    routerContext.wsRateLimiterTrustedProxyHops
  );
  const result = routerContext.wsRateLimiter.check(clientIp);
  if (result.allowed) return false;
  logger.warn(
    `WebSocket レート制限超過: /ws/events ip=${clientIp} retryAfter=${result.retryAfterSeconds}s`
  );
  const body = JSON.stringify({
    error: 'Too Many Requests',
    retryAfter: result.retryAfterSeconds,
  });
  const bodyLength = Buffer.byteLength(body, 'utf8');
  socket.write(
    `HTTP/1.1 429 Too Many Requests\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${bodyLength}\r\n` +
      `Retry-After: ${result.retryAfterSeconds}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      body
  );
  socket.destroy();
  return true;
}

/**
 * Issue #1437: render token 検証経路を切り出したヘルパ。
 * shared secret NG かつ verifier が設定されている場合の 401 応答も本関数内で処理する。
 */
function handleRenderTokenUpgrade(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL
): void {
  // render token 経路: backend への非同期問い合わせで検証する。
  // 例外は fail-closed で 401 に丸める。例外時は sentinel(null) を返して
  // 通常 false と区別し、ログメッセージが誤解を招かないようにする。
  // Issue #2782: 認可成功時は認証した session / 配信者の scope を接続へ引き継ぐ。
  void authorizeRenderToken(request, url, routerContext.renderTokenVerifier)
    .then<WebSocketAuthScope | null | undefined>((scope) => scope)
    .catch((err) => {
      logger.error('WebSocket 認可判定で予期しないエラー:', err);
      return undefined;
    })
    .then((result) => {
      if (result) {
        wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          wss.emit('connection', ws, request, result);
        });
        return;
      }
      if (result === undefined) {
        logger.warn('WebSocket 認証失敗: /ws/events (render token 検証で例外)');
      } else {
        logger.warn('WebSocket 認証失敗: /ws/events (render token 検証不成立)');
      }
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      } catch {
        // socket が既に destroy 済みなら書き込みは失敗する。無視して destroy を試みる。
      }
      socket.destroy();
    });
}

export function setupWebSocketRoutes(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  if (!request.url) {
    logger.error('リクエストURLが不正です');
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // routingにHostは不要。外部入力のHostをbase URLへ使うと不正値でURL constructorが
  // throwし、upgrade handler全体を落とせるため固定の安全なbaseを使う。
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname !== '/ws/events') {
    logger.error(`不正なWebSocketパス: ${pathname}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Issue #589: 認証前に IP レート制限を適用する。
  // 認証チェックを先に走らせると 429 と 401 の判別ができなくなり、
  // 攻撃者に「シークレット無しの試行回数」で疎通確認されてしまうため。
  if (rejectIfRateLimited(request, socket)) return;

  // Issue #825: 認可判定は「shared secret（同期）」→「render token（backend への非同期問い合わせ）」の
  // 2 系統に拡張された。shared secret が通れば従来通り同期で handleUpgrade へ進むため、
  // 既存の admin ブラウザ経路の挙動は変わらない（レイテンシ増もない）。
  // shared secret が失敗した場合のみ render token 検証を試みる。
  if (isSharedSecretAuthorized(request, url)) {
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, request, UNRESTRICTED_SCOPE);
    });
    return;
  }

  // shared secret NG かつ render token verifier 未設定 → 即 401（既存挙動と同等）
  if (!routerContext.renderTokenVerifier) {
    logger.warn('WebSocket 認証失敗: /ws/events (shared secret 不一致 / render token 検証未設定)');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  handleRenderTokenUpgrade(wss, request, socket, head, url);
}

// scope が無い接続は何にも connect させない（空文字の配信者・session は一致し得ない）。
const DENY_ALL_SCOPE: WebSocketAuthScope = Object.freeze({ sessionId: '', username: '' });

/**
 * `wss.on('connection', handleWebSocketConnection)` で登録する。
 * `scope` は `setupWebSocketRoutes` が upgrade 時の認証結果から 3 番目の引数として渡す
 * （Issue #2782）。渡されない接続は認証経路を経ていないため、全 connect を拒否する。
 */
export function handleWebSocketConnection(
  ws: WebSocket,
  _request?: IncomingMessage,
  scope?: WebSocketAuthScope
): void {
  const manager = routerContext.connectionManager;
  if (!manager) {
    logger.error('ConnectionManagerが未初期化');
    ws.close(1011, 'Server not ready');
    return;
  }

  logger.info('クライアント接続: /ws/events');

  const handler = new WebSocketHandler(manager, scope ?? DENY_ALL_SCOPE);

  ws.on('message', (data: Buffer) => {
    handler.handleMessage(ws, data.toString()).catch((err) => {
      logger.error('メッセージ処理エラー:', err);
    });
  });

  ws.on('close', () => {
    logger.info('クライアント切断');
    handler.handleClose(ws).catch((err) => {
      logger.error('切断処理エラー:', err);
    });
  });

  ws.on('error', (error) => {
    logger.error('WebSocketエラー:', error);
    handler.handleClose(ws).catch((err) => {
      logger.error('エラー処理後の切断エラー:', err);
    });
  });
}
