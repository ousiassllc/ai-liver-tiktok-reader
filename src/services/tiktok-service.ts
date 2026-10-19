import { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } from 'tiktok-live-connector';
import { WebSocket } from 'ws';
import {
  TikTokCommentData,
  TikTokGiftData,
  TikTokRoomUserData,
  TikTokSimpleEventData,
  TikTokSocialData,
} from '../types/tiktok';
import { logger } from '../utils/logger';
import { hashForLog } from '../utils/hash-for-log';
import { BackendApiService } from './backend-api-service';
import { ViewerCountForwarder } from './viewer-count-forwarder';
import {
  handleCommentEvent,
  handleGiftEvent,
  handleSimpleEventPayload,
  resolveSubscribeEventName,
} from './tiktok-event-handlers';

/**
 * TikTok Live との接続と受信イベントの WebSocket 配信を担う。
 * Issue #773: 376 行の実装をイベントハンドラ (`tiktok-event-handlers.ts`) と分離した。
 */
export class TikTokService {
  private connection: TikTokLiveConnection | null = null;
  private ws: WebSocket | null = null;
  private broadcastCallback: ((message: string) => void) | null = null;
  private sessionId: string | null = null;
  private readonly backendApi: BackendApiService;
  // Issue #615: WebcastEvent.ROOM_USER → backend への転送は 300 行制限を守るため
  // 別モジュール ViewerCountForwarder に切り出している。
  private readonly viewerCountForwarder: ViewerCountForwarder;

  constructor(backendApi?: BackendApiService) {
    // refine-sweep iter-3 backend MAJOR: 以前は BackendApiService の import が完全に
    // コメントアウトされており、TikTok から受信したギフトが backend DB に一切保存
    // されず管理画面のギフト累計が常に 0 のままだった。DI 可能にしつつデフォルトで
    // BackendApiService を起動時に構築することで、ギフト受信 → backend 保存を復活させる。
    this.backendApi = backendApi ?? new BackendApiService();
    this.viewerCountForwarder = new ViewerCountForwarder(this.backendApi);
  }

  /**
   * ブロードキャストコールバックを設定（マルチインスタンス対応）
   * 設定されている場合、WebSocket直接送信の代わりにコールバックを使用
   */
  setBroadcastCallback(callback: (message: string) => void): void {
    this.broadcastCallback = callback;
  }

  private safeSend(message: string): void {
    // ブロードキャストコールバックが設定されている場合はそちらを使用
    if (this.broadcastCallback) {
      this.broadcastCallback(message);
      return;
    }

    // 従来のWebSocket直接送信
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    } else {
      logger.warn('WebSocket is not open', { readyState: this.ws?.readyState });
    }
  }

  private safeClose(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }
  }

  /**
   * TikTok Liveに接続
   * @param username TikTok配信者のユーザー名
   * @param sessionId セッションID
  * @param ws WebSocketクライアント（オプション、マルチインスタンス時は不要）
  */
  async connect(username: string, sessionId: string, ws?: WebSocket): Promise<void> {
    let connection: TikTokLiveConnection | null = null;
    try {
      this.ws = ws || null;
      // refine-sweep iter-3 backend MAJOR: sessionId を保持して handleGift から
      // BackendApiService.sendGift の session_id フィールドに渡す。
      this.sessionId = sessionId;

      // refine-sweep iter-8 tiktok-reader MINOR: connect パスで残っていた平文 TikTok username を
      // handleComment/Gift/SimpleEvent と同じく hashForLog で SHA-256(先頭16文字) 化する。
      logger.info(`TikTok Live接続試行: ${hashForLog(username)}`);

      if (process.env.TIKTOK_EULER_API_KEY) {
        SignConfig.apiKey = process.env.TIKTOK_EULER_API_KEY;
        logger.info('TikTok Euler APIキー設定済み');
      } else {
        logger.warn('TIKTOK_EULER_API_KEY未設定。レート制限に注意。');
      }

      connection = new TikTokLiveConnection(username, {
        signApiKey: process.env.TIKTOK_EULER_API_KEY || undefined,
        enableExtendedGiftInfo: true,
        processInitialData: false,
      });
      this.connection = connection;

      this.registerEventHandlers(connection);

      await connection.connect();
      if (this.connection !== connection) {
        connection.removeAllListeners();
        try {
          await connection.disconnect();
        } catch (error) {
          logger.error('キャンセル済みTikTok Live接続の切断エラー:', error);
        }
        throw new Error('TikTok Live connection cancelled');
      }

      logger.info(`TikTok Live接続完了: ${hashForLog(username)}`);

      // spec 3-3-5-3-4: status / message は data フィールド配下にネスト
      this.safeSend(JSON.stringify({
        type: 'status',
        data: {
          status: 'connected',
          message: 'TikTok Liveに接続しました',
        },
      }));
    } catch (error) {
      logger.error('TikTok Live接続エラー:', error);
      if (connection && this.connection === connection) {
        connection.removeAllListeners();
        this.connection = null;
      }
      throw error;
    }
  }

  /**
   * TikTokLiveConnection への各種 WebcastEvent / ControlEvent リスナ登録。
   * connect() から抜き出すことで責務を分離し、行数超過も回避する。
   */
  private registerEventHandlers(connection: TikTokLiveConnection): void {
    const send = (m: string) => this.safeSend(m);

    connection.on(WebcastEvent.CHAT, (data: TikTokCommentData) =>
      // Issue #2154: sessionId を渡してコメントを backend の session_comments へ転送する。
      handleCommentEvent(data, send, this.backendApi, this.sessionId),
    );
    connection.on(WebcastEvent.GIFT, (data: TikTokGiftData) =>
      handleGiftEvent(data, send, this.backendApi, this.sessionId),
    );
    // Issue #615: WebcastEvent.ROOM_USER を購読して viewerCount を render client と backend に転送する。
    connection.on(WebcastEvent.ROOM_USER, (data: TikTokRoomUserData) =>
      this.viewerCountForwarder.handle(data, this.sessionId, send),
    );

    const simpleEvents: Array<{ event: WebcastEvent; type: 'follow' | 'share' | 'member' | 'subscribe' }> = [
      { event: WebcastEvent.FOLLOW, type: 'follow' },
      { event: WebcastEvent.SHARE, type: 'share' },
      { event: WebcastEvent.MEMBER, type: 'member' },
      // refine-sweep iter-3 backend MAJOR: (WebcastEvent as any).SUBSCRIBE を廃止し、
      // resolveSubscribeEventName() で SDK 追加値と 'subscribe' 文字列フォールバックを両立する。
      { event: resolveSubscribeEventName(), type: 'subscribe' },
    ];
    simpleEvents.forEach(({ event, type }) => {
      connection.on(event, (data: TikTokSimpleEventData) =>
        handleSimpleEventPayload(type, data, send),
      );
    });

    // refine-sweep iter-4 tiktok-reader MINOR #4: SOCIAL アクション種別は
    // 1=follow, 2=share, 3=subscribe が SDK ドキュメントで確認できる既知値。
    // 従来は「1/2 以外はすべて subscribe」というフォールバックで、SDK に新規
    // アクションが追加された際に誤って subscribe として render client / backend に
    // 転送してしまう問題があった。明示的な既知値のみをマッピングし、未知値は
    // skip して debug ログに残す（後で SDK 差分を検知できるようにする）。
    connection.on(WebcastEvent.SOCIAL, (data: TikTokSocialData) => {
      const eventType =
        data.action === 1 ? 'follow' :
        data.action === 2 ? 'share' :
        data.action === 3 ? 'subscribe' : null;
      if (eventType === null) {
        logger.debug('SOCIAL: 未知のアクション種別のためスキップ', { action: data.action });
        return;
      }
      handleSimpleEventPayload(eventType, data, send);
    });

    // tiktok-live-connector は HTML から Room ID を取得できなかった場合など、後続の
    // API / Euler fallback を継続する途中経過にも ControlEvent.ERROR を発火する。
    // このイベントを CONNECTION_FAILED に変換すると、connect() が最終的に成功しても
    // render client を先に切断してしまう。接続失敗の確定は connect() の reject に一本化し、
    // ここでは診断ログだけを残す。
    connection.on(ControlEvent.ERROR, (diagnostic: unknown) => {
      if (!connection.isConnected) {
        // SDK は connect() の最終 reject 直前にも ERROR を発火する。
        // 未接続中の通知はここから送らず、ConnectionManager の reject 処理に一本化する。
        logger.warn('TikTok Live connector未接続時診断:', diagnostic);
        return;
      }

      // 接続完了後の transport error は従来どおりクライアントへ通知して切断する。
      logger.error('TikTok Live接続エラー:', diagnostic);
      const message = connectorErrorMessage(diagnostic);
      this.safeSend(JSON.stringify({
        type: 'error',
        data: {
          code: 'CONNECTION_FAILED',
          message,
        },
      }));
      this.safeClose();
    });

    connection.on(WebcastEvent.STREAM_END, () => {
      logger.info('TikTok Live配信終了');
      // spec 3-3-5-3-4: status / message は data フィールド配下にネスト
      this.safeSend(JSON.stringify({
        type: 'status',
        data: {
          status: 'disconnected',
          message: 'TikTok Live配信が終了しました',
        },
      }));
    });
  }

  // 以下は既存テスト (`(service as any).handleXxx(...)` 形式) との互換のため残す薄いラッパ。
  // 実ロジックは tiktok-event-handlers.ts に集約されている。

  private handleComment(data: TikTokCommentData): void {
    handleCommentEvent(data, (m) => this.safeSend(m), this.backendApi, this.sessionId);
  }

  private handleGift(data: TikTokGiftData): void {
    handleGiftEvent(data, (m) => this.safeSend(m), this.backendApi, this.sessionId);
  }

  private handleRoomUser(data: TikTokRoomUserData): void {
    this.viewerCountForwarder.handle(data, this.sessionId, (m) => this.safeSend(m));
  }

  private handleSimpleEvent(type: 'follow' | 'share' | 'member' | 'subscribe', data: TikTokSimpleEventData): void {
    handleSimpleEventPayload(type, data, (m) => this.safeSend(m));
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    if (connection) {
      // connect()完了後に古い接続が復活しないよう、awaitより先に無効化する。
      this.connection = null;
      try {
        connection.removeAllListeners();
        await connection.disconnect();
      } catch (error) {
        logger.error('TikTok Live切断エラー:', error);
      } finally {
        this.ws = null;
        this.broadcastCallback = null;
        this.sessionId = null;
        // Issue #615: 再接続時に throttle が「直前送信あり」状態から始まらないようリセットする。
        this.viewerCountForwarder.reset();
        logger.info('TikTok Live切断');
      }
    }
  }
}

const connectorErrorMessage = (diagnostic: unknown): string => {
  if (diagnostic instanceof Error) return diagnostic.message;
  if (!diagnostic || typeof diagnostic !== 'object') {
    return 'TikTok Liveへの接続に失敗しました';
  }
  const value = diagnostic as { message?: unknown; exception?: unknown };
  if (typeof value.message === 'string' && value.message) return value.message;
  if (value.exception instanceof Error) return value.exception.message;
  return 'TikTok Liveへの接続に失敗しました';
};
