import { ViewerCountEvent } from '../types/websocket';
import { TikTokRoomUserData } from '../types/tiktok';
import { logger } from '../utils/logger';
import { BackendApiService } from './backend-api-service';

/**
 * Issue #615: WebcastEvent.ROOM_USER から backend への viewer_count push を絞り込む最小間隔（ミリ秒）。
 *
 * TikTok Live は ROOM_USER を毎秒〜数秒ごとに emit するため、そのまま POST すると
 * backend の /session/{id}/viewer-count が同一値で連打される。仕様上「最大 30 秒前まで」の
 * キャッシュを見せれば十分なので 10 秒間隔で throttle し、backend の書き込み負荷を抑える。
 * ただし WebSocket 経由の viewer_count イベントは render client の即時反映用途で throttle しない。
 */
export const VIEWER_COUNT_BACKEND_MIN_INTERVAL_MS = 10_000;

/**
 * TikTok Live の WebcastEvent.ROOM_USER を admin render WebSocket と backend API に転送するヘルパー。
 *
 * 状態（最後の backend push 時刻）を保持するため class として実装する。
 * TikTokService からセッションごとに 1 インスタンスを生成して利用する。
 */
export class ViewerCountForwarder {
  private lastBackendPushAt = 0;

  constructor(
    private readonly backendApi: BackendApiService,
    private readonly minBackendIntervalMs: number = VIEWER_COUNT_BACKEND_MIN_INTERVAL_MS
  ) {}

  /**
   * 内部状態を初期状態に戻す。TikTokService.disconnect() で呼び出し、
   * 再接続時に throttle が「直前送信あり」状態から始まらないようにする。
   */
  reset(): void {
    this.lastBackendPushAt = 0;
  }

  /**
   * WebcastEvent.ROOM_USER の viewerCount を処理する。
   *
   * - `wsSend`: 受信のたびに admin render runtime に viewer_count イベントを送出する（即時反映用途）。
   * - Backend: `sessionId` が非 null かつ最短 `minBackendIntervalMs` を超過している場合のみ
   *   POST /session/{id}/viewer-count を叩く。
   *
   * viewerCount が undefined / 負値 / 非有限数の場合はイベント自体を無視する。
   */
  handle(data: TikTokRoomUserData, sessionId: string | null, wsSend: (message: string) => void): void {
    try {
      if (typeof data.viewerCount !== 'number' || !Number.isFinite(data.viewerCount) || data.viewerCount < 0) {
        // viewerCount が無い（またはランク更新のみ）ROOM_USER イベントは無視する。
        return;
      }
      const count = Math.floor(data.viewerCount);
      const timestamp = new Date().toISOString();

      // WebSocket は throttle せず、admin render runtime に最新値を即時通知する。
      const message: ViewerCountEvent = {
        type: 'viewer_count',
        data: {
          count,
          timestamp,
          platform: 'tiktok'
        }
      };
      wsSend(JSON.stringify(message));

      // Backend への push は minBackendIntervalMs で throttle する。
      // 初回 (lastBackendPushAt === 0) は即送信する。
      const now = Date.now();
      if (sessionId && now - this.lastBackendPushAt >= this.minBackendIntervalMs) {
        this.lastBackendPushAt = now;
        void this.backendApi.sendViewerCount(sessionId, count);
      }
    } catch (error) {
      logger.error('視聴者数処理エラー:', error);
    }
  }
}
