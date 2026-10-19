import { WebSocket } from 'ws';
import { logger } from '../../utils/logger';
import { hashForLog } from '../../utils/hash-for-log';
import { TikTokEventMessage } from '../pubsub-service';
import { ConnectionInfo } from './connection-types';

export class ConnectionBroadcaster {
  constructor(
    private readonly connections: Map<string, ConnectionInfo>,
    private readonly maxPendingMessages: number
  ) {}

  handlePubSubMessage(username: string, message: TikTokEventMessage): void {
    const connection = this.connections.get(username);
    if (!connection) return;

    // connecting 中は確定までキューに積む
    if (connection.connecting) {
      connection.pendingMessages.push(message);
      // 暴走防止: 上限超過で古いものから捨てる
      if (connection.pendingMessages.length > this.maxPendingMessages) {
        const dropped = connection.pendingMessages.shift();
        // refine-sweep iter-8 tiktok-reader MINOR: TikTok username を平文でログに残さないため
        // hashForLog で SHA-256(先頭16文字) 化する (他ファイルと同一のポリシー)。
        logger.warn(`pendingMessages があふれ先頭を破棄: ${hashForLog(username)} type=${dropped?.type}`);
      }
      return;
    }

    if (connection.isLeader) return;

    this.broadcastToClients(username, JSON.stringify({
      type: message.type,
      data: message.data,
    }));
  }

  flushPendingMessages(username: string): void {
    const connection = this.connections.get(username);
    if (!connection) return;
    if (connection.connecting) return; // 安全ガード: 確定前の誤呼び出しを無視
    const pending = connection.pendingMessages.splice(0);
    if (connection.isLeader) {
      // リーダーは TikTok 直結で取得するため Pub/Sub 由来は破棄（二重配信回避）
      if (pending.length) logger.debug(`Pub/Subキュー破棄(leader): ${hashForLog(username)} count=${pending.length}`);
      return;
    }
    for (const message of pending) {
      this.broadcastToClients(username, JSON.stringify({ type: message.type, data: message.data }));
    }
  }

  broadcastToClients(username: string, message: string): void {
    const connection = this.connections.get(username);
    if (!connection) return;

    const clients = Array.from(connection.clients);
    const deadClients: WebSocket[] = [];

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          logger.error('メッセージ送信エラー:', error);
          deadClients.push(client);
        }
      } else if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
        deadClients.push(client);
      }
    }

    // 削除対象のクライアントをクリーンアップ
    for (const client of deadClients) {
      connection.clients.delete(client);
    }
  }

  closeAllClients(): void {
    for (const connection of this.connections.values()) {
      for (const client of connection.clients) {
        try {
          client.close(1001, 'Server shutting down');
        } catch (error) {
          logger.error('WebSocket shutdownエラー:', error);
        }
      }
      connection.clients.clear();
    }
  }
}
