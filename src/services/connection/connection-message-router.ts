import { logger } from '../../utils/logger';
import { ConnectionBroadcaster } from './connection-broadcaster';
import { PubSubService } from '../pubsub-service';

/**
 * ConnectionManager 内で TikTok Live から受信した生 message を
 * WebSocket クライアントへ配信しつつ、status/error 以外を Pub/Sub にも
 * 転送するロジック。
 *
 * Issue #773: connection-manager.ts の 300 行制限を守るため切り出した。
 * 呼び出し側は `handleTikTokMessage(username, message, deps)` として呼び、
 * status: 'disconnected' を検出した場合は非同期の `onStreamDisconnected`
 * コールバックが呼び出される。
 */
export interface ConnectionMessageRouterDeps {
  broadcaster: ConnectionBroadcaster;
  pubsubService: PubSubService;
  /** status: 'disconnected' を検出したときのコールバック（配信終了処理を発火する）。 */
  onStreamDisconnected: () => Promise<void>;
}

export function routeTikTokMessage(
  username: string,
  message: string,
  deps: ConnectionMessageRouterDeps,
): void {
  // まず WebSocket クライアントに広告
  deps.broadcaster.broadcastToClients(username, message);

  try {
    const parsed = JSON.parse(message);

    // spec 3-3-5-3-4: status は data.status にネストされる。後方互換のため旧 parsed.status も許容。
    const statusValue = parsed.data?.status ?? parsed.status;
    if (parsed.type === 'status' && statusValue === 'disconnected') {
      deps.onStreamDisconnected().catch((err) =>
        logger.error('配信終了処理エラー:', err),
      );
      return;
    }

    if (parsed.type !== 'status' && parsed.type !== 'error') {
      deps.pubsubService.publishEvent(parsed.type, username, parsed.data || parsed);
    }
  } catch (error) {
    logger.error('Pub/Sub発行エラー:', error);
  }
}
