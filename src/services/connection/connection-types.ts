import { WebSocket } from 'ws';
import { TikTokService } from '../tiktok-service';
import { TikTokEventMessage } from '../pubsub-service';

/**
 * 1 つの TikTok ユーザー（配信）に対する接続状態。
 * ConnectionManager が username をキーに 1 件ずつ保持する。
 */
export interface ConnectionInfo {
  username: string;
  tiktokService: TikTokService | null;
  clients: Set<WebSocket>;
  isLeader: boolean;
  sessionId: string;
  unsubscribe?: () => void;
  connecting: boolean;
  cleanupPromise?: Promise<void>;
  pendingMessages: TikTokEventMessage[];
}
