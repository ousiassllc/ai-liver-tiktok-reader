import { WebSocket } from 'ws';
import { ConnectionManager } from '../services/connection-manager';
import { ConnectionLimitError, SessionConflictError } from '../services/connection-limits';
import type { WebSocketAuthScope } from '../routes/auth';
import { ConnectMessage } from '../types/websocket';
import { extractUsername } from '../utils/url-parser';
import { logger } from '../utils/logger';
import { hashForLog } from '../utils/hash-for-log';

/**
 * Issue #590: 接続上限超過時に返す WebSocket close code。
 * 1013 (Try Again Later) は WebSocket 標準の「一時的な過負荷」用コードで、
 * クライアント側に「今は受け付けられないが後で再試行して良い」と伝える。
 */
const CLOSE_CODE_CONNECTION_LIMIT = 1013;

/**
 * Issue #2782: 認証済み scope と `connect` 本文が食い違った接続、および同一配信者への別 session
 * 接続を閉じる WebSocket close code。1008 (Policy Violation)。
 */
const CLOSE_CODE_POLICY_VIOLATION = 1008;

/** connect 本文の長さ上限。実在の TikTok URL / session ID より十分大きく、巨大入力を弾く値。 */
const MAX_LIVE_URL_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 128;

export class WebSocketHandler {
  private connectionManager: ConnectionManager;
  private currentUsername: string | null = null;

  private readonly scope: WebSocketAuthScope;

  /**
   * @param scope upgrade 時の認証で確定した、この接続が扱える session / 配信者
   *   （Issue #2782）。`connect` 本文はこの範囲に収まる場合だけ受理する。
   */
  constructor(connectionManager: ConnectionManager, scope: WebSocketAuthScope) {
    this.connectionManager = connectionManager;
    this.scope = scope;
  }

  private sendError(ws: WebSocket, code: string, message: string, extra: Record<string, unknown> = {}): void {
    // spec api.md: error メッセージは data: { code, message } のネスト形式
    this.safeSend(ws, JSON.stringify({ type: 'error', data: { code, message, ...extra } }));
  }

  /** エラーを返したうえで接続を閉じる。上流 TikTok 接続・backend 転送より前の拒否に使う。 */
  private rejectAndClose(ws: WebSocket, code: string, message: string, closeReason: string): void {
    this.sendError(ws, code, message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(CLOSE_CODE_POLICY_VIOLATION, closeReason);
    }
  }

  private safeSend(ws: WebSocket, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else {
      logger.warn('WebSocket is not open. Message not sent.', { readyState: ws.readyState });
    }
  }

  async handleMessage(ws: WebSocket, message: string): Promise<void> {
    try {
      const data = JSON.parse(message) as ConnectMessage | null;

      if (data === null || typeof data !== 'object') {
        this.sendError(ws, 'INVALID_MESSAGE', '不正なメッセージ形式です');
        return;
      }

      if (data.type === 'connect') {
        if (typeof data.liveUrl !== 'string' || data.liveUrl.length > MAX_LIVE_URL_LENGTH) {
          this.sendError(ws, 'INVALID_URL', '不正なTikTok Live URL');
          return;
        }
        if (
          data.sessionId !== undefined &&
          (typeof data.sessionId !== 'string' || data.sessionId.length > MAX_SESSION_ID_LENGTH)
        ) {
          this.sendError(ws, 'INVALID_MESSAGE', '不正なメッセージ形式です');
          return;
        }

        const username = extractUsername(data.liveUrl).toLowerCase();

        if (!username) {
          this.sendError(ws, 'INVALID_URL', '不正なTikTok Live URL');
          return;
        }

        // Issue #2782: 認証した session / 配信者と一致しない connect は、上流 TikTok 接続・
        // backend 転送・既存接続の差し替えより前に拒否する。
        if (this.scope.sessionId !== null && data.sessionId !== this.scope.sessionId) {
          logger.warn('認証済み session と connect 本文の session が不一致のため拒否');
          this.rejectAndClose(ws, 'SESSION_MISMATCH', '認証した session と一致しません', 'session mismatch');
          return;
        }
        if (this.scope.username !== null && username !== this.scope.username) {
          logger.warn('認証済み配信者と connect 本文の配信者が不一致のため拒否', {
            usernameHash: hashForLog(username),
          });
          this.rejectAndClose(ws, 'STREAMER_NOT_ALLOWED', '認証した session の配信者と一致しません', 'streamer not allowed');
          return;
        }

        // PII を平文ログに残さないため liveUrl / username は出力せずハッシュのみ記録する。
        logger.info('接続リクエスト受信:', {
          usernameHash: hashForLog(username),
          sessionId: data.sessionId
        });

        if (this.currentUsername && this.currentUsername !== username) {
          await this.connectionManager.removeClient(this.currentUsername, ws);
        }

        // addClient は TikTok SDK の接続完了まで待つ。待機中にクライアント側が切断すると
        // handleClose が先に呼ばれるため、await より前に username を保持しておく。
        // 従来は await 後に設定しており、接続中 close で removeClient が実行されず、
        // クライアント不在のTikTok接続と分散ロックが残留していた。
        const alreadyConnected = this.currentUsername === username;
        this.currentUsername = username;
        try {
          await this.connectionManager.addClient(username, ws, data.sessionId);
        } catch (err) {
          if (err instanceof SessionConflictError) {
            // 同じ WS からの差し替えでは先行登録が残っているため、close 前に解放する。
            if (alreadyConnected) await this.handleClose(ws);
            else this.currentUsername = null;
            logger.warn('同一配信者に別 session が接続中のため接続を拒否', {
              usernameHash: hashForLog(username),
            });
            this.rejectAndClose(ws, 'SESSION_CONFLICT', 'この配信者には別の session が接続中です', 'session conflict');
            return;
          }
          if (err instanceof ConnectionLimitError) {
            // enforceConnectionLimits は client 登録前に拒否するため removeClient は不要。
            this.currentUsername = null;
            logger.warn('接続数上限に達したため接続を拒否', {
              usernameHash: hashForLog(username),
              reason: err.reason,
              limit: err.limit,
              current: err.current,
            });
            this.safeSend(ws, JSON.stringify({
              type: 'error',
              data: {
                code: 'CONNECTION_LIMIT_EXCEEDED',
                message: '同時接続数の上限に達しました。しばらくしてから再度お試しください。',
                reason: err.reason,
              },
            }));
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(CLOSE_CODE_CONNECTION_LIMIT, 'connection limit exceeded');
            }
            return;
          }
          if (this.currentUsername === username) {
            try {
              await this.connectionManager.removeClient(username, ws);
            } catch (cleanupError) {
              logger.error('接続失敗後のクライアント削除エラー:', cleanupError);
            } finally {
              this.currentUsername = null;
            }
          }
          throw err;
        }
      }
    } catch (error) {
      const isJsonError = error instanceof SyntaxError;
      logger.error('メッセージ処理エラー:', error);
      // refine-sweep iter-5 backend MAJOR:
      // 旧実装は error.message をそのままクライアントに返しており、内部実装の
      // スタック情報・ライブラリ名・DB エラー詳細等が漏洩する経路になっていた。
      // クライアントに返す message はコード分類に応じた汎用文言に丸め、詳細は
      // 上の logger.error にのみ残す。
      // spec api.md: error メッセージは data: { code, message } のネスト形式
      const clientMessage = isJsonError
        ? '不正なメッセージ形式です'
        : 'internal error';
      this.safeSend(ws, JSON.stringify({
        type: 'error',
        data: {
          code: isJsonError ? 'INVALID_MESSAGE' : 'INTERNAL_ERROR',
          message: clientMessage
        }
      }));
    }
  }

  async handleClose(ws: WebSocket): Promise<void> {
    if (this.currentUsername) {
      try {
        await this.connectionManager.removeClient(this.currentUsername, ws);
      } catch (error) {
        logger.error('クライアント削除エラー:', error);
      } finally {
        this.currentUsername = null;
        logger.info('クライアント切断処理完了');
      }
    }
  }
}
