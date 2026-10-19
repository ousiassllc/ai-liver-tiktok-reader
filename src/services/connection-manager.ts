import { WebSocket } from 'ws';
import { TikTokService } from './tiktok-service';
import { DistributedLockService } from './distributed-lock-service';
import { PubSubService } from './pubsub-service';
import { logger } from '../utils/logger';
import { hashForLog } from '../utils/hash-for-log';
import { ConnectionInfo } from './connection/connection-types';
import { ConnectionBroadcaster } from './connection/connection-broadcaster';
import { LeaderWatcher } from './connection/leader-watcher';
import { ConnectionLimits, noConnectionLimits, SessionConflictError } from './connection-limits';
import { enforceConnectionLimits } from './connection/connection-limits-guard';
import {
  disconnectTikTokServiceIfActive,
  handleStreamEnd as runStreamEndCleanup,
  releaseLeadershipIfHeld,
} from './connection/connection-lock-lifecycle';
import { routeTikTokMessage } from './connection/connection-message-router';
import {
  connectedStatusJson,
  connectedViaOtherInstanceJson,
  connectionFailedErrorJson,
  reconnectingJson,
} from './connection/connection-status-messages';

export class ConnectionManager {
  private connections: Map<string, ConnectionInfo> = new Map();
  private lockService: DistributedLockService;
  private pubsubService: PubSubService;
  private broadcaster: ConnectionBroadcaster;
  private leaderWatcher: LeaderWatcher;
  private connectionPromises: Map<string, Promise<void>> = new Map();
  private readonly limits: ConnectionLimits;
  // 高頻度コメント10件/秒 × leader選出10秒を許容。
  private readonly MAX_PENDING_MESSAGES = 100;
  constructor(
    lockService: DistributedLockService,
    pubsubService: PubSubService,
    limits: ConnectionLimits = noConnectionLimits(),
  ) {
    this.lockService = lockService;
    this.pubsubService = pubsubService;
    this.limits = limits;
    this.broadcaster = new ConnectionBroadcaster(this.connections, this.MAX_PENDING_MESSAGES);
    this.leaderWatcher = new LeaderWatcher(
      this.connections,
      this.lockService,
      (username) => this.tryBecomeLeader(username)
    );
  }

  async addClient(username: string, ws: WebSocket, sessionId = ''): Promise<void> {
    await this.connections.get(username)?.cleanupPromise;
    // cleanup 待機中に閉じた WS を再登録し、無人の leader を残さない。
    if (ws.readyState !== WebSocket.OPEN) return;
    let connection = this.connections.get(username);
    // Issue #2782: 接続中の配信者に別 session を相乗りさせない（TikTokService は初回の
    // sessionId を保持し続け、WS の配信先と backend の保存先が食い違うため）。
    if (connection && sessionId !== connection.sessionId) {
      throw new SessionConflictError();
    }
    enforceConnectionLimits(
      username,
      ws,
      this.limits,
      connection,
      () => this.getTotalClientCount(),
    );

    if (!connection) {
      connection = {
        username,
        tiktokService: null,
        clients: new Set(),
        isLeader: false,
        sessionId,
        connecting: false,
        pendingMessages: [],
      };
      this.connections.set(username, connection);
      connection.unsubscribe = this.pubsubService.subscribe(username, (message) => {
        this.handlePubSubMessage(username, message);
      });
    }
    connection.clients.add(ws);
    logger.info(`クライアント追加: ${hashForLog(username)} (clients: ${connection.clients.size})`);

    await this.tryBecomeLeader(username);
  }

  async removeClient(username: string, ws: WebSocket): Promise<void> {
    const connection = this.connections.get(username);
    if (!connection) return;
    connection.clients.delete(ws);
    logger.info(`クライアント削除: ${hashForLog(username)} (clients: ${connection.clients.size})`);
    if (connection.clients.size === 0) {
      await this.cleanupConnection(username);
    }
  }

  private async tryBecomeLeader(username: string): Promise<void> {
    const existingPromise = this.connectionPromises.get(username);
    if (existingPromise) {
      // 同時に追加されたclientは先行処理へ合流する。先行処理が上流接続に
      // 失敗しても各callerが直列に再試行して外部APIを連打してはならない。
      logger.debug(`接続処理中のため待機: ${hashForLog(username)}`);
      await existingPromise;
      return;
    }

    const connection = this.connections.get(username);
    if (!connection) return;

    if (connection.isLeader && connection.tiktokService) {
      this.broadcaster.broadcastToClients(username, connectedStatusJson());
      return;
    }

    const connectionPromise = this.doTryBecomeLeader(username, connection);
    this.connectionPromises.set(username, connectionPromise);

    try {
      await connectionPromise;
    } finally {
      this.connectionPromises.delete(username);
    }
  }

  private async doTryBecomeLeader(username: string, connection: ConnectionInfo): Promise<void> {
    connection.connecting = true;
    try {
      const acquired = await this.lockService.acquireLock(username);
      if (acquired) {
        logger.info(`リーダー選出: ${hashForLog(username)}`);
        connection.isLeader = true;
        this.leaderWatcher.stop(username);
        this.lockService.startLockRefresh(username, () => {
          this.handleLockLost(username).catch((err) => logger.error('ロック喪失処理エラー:', err));
        });
        await this.establishTikTokConnection(username);
      } else {
        connection.isLeader = false;
        const holder = await this.lockService.getLockHolder(username);
        this.broadcaster.broadcastToClients(
          username,
          holder ? connectedViaOtherInstanceJson(holder) : reconnectingJson(),
        );
        this.leaderWatcher.start(username);
      }
    } finally {
      connection.connecting = false;
      this.flushPendingMessages(username);
    }
  }

  private async establishTikTokConnection(username: string): Promise<void> {
    const connection = this.connections.get(username);
    if (!connection || !connection.isLeader) return;

    try {
      connection.tiktokService = new TikTokService();
      connection.tiktokService.setBroadcastCallback((message: string) => {
        if (this.connections.get(username) === connection) this.handleTikTokMessage(username, message);
      });

      await connection.tiktokService.connect(username, connection.sessionId);
      logger.info(`TikTok Live接続完了: ${hashForLog(username)}`);
    } catch (error) {
      logger.error(`TikTok Live接続エラー: ${hashForLog(username)}`, error);
      if (connection.isLeader) {
        this.broadcaster.broadcastToClients(username, connectionFailedErrorJson(error));
        await releaseLeadershipIfHeld(username, connection, this.lockService);
      }
      connection.tiktokService = null;
    }
  }

  private handleTikTokMessage(username: string, message: string): void {
    if (!this.connections.get(username)?.isLeader) return;
    routeTikTokMessage(username, message, {
      broadcaster: this.broadcaster,
      pubsubService: this.pubsubService,
      onStreamDisconnected: () => this.handleStreamEnd(username),
    });
  }

  private handlePubSubMessage(username: string, message: Parameters<ConnectionBroadcaster['handlePubSubMessage']>[1]): void {
    this.broadcaster.handlePubSubMessage(username, message);
  }

  private flushPendingMessages(username: string): void {
    this.broadcaster.flushPendingMessages(username);
  }

  private async handleLockLost(username: string): Promise<void> {
    const connection = this.connections.get(username);
    if (!connection) return;

    logger.warn(`ロック喪失: ${hashForLog(username)}`);

    // SDK切断の完了前でも旧leader由来eventを配信しない。
    connection.isLeader = false;
    connection.connecting = false;
    this.flushPendingMessages(username);
    await disconnectTikTokServiceIfActive(connection);
    this.broadcaster.broadcastToClients(username, reconnectingJson());

    if (connection.clients.size > 0) {
      this.leaderWatcher.start(username);
      const delay = 3000 + Math.random() * 2000;
      setTimeout(() => {
        this.tryBecomeLeader(username).catch((err) =>
          logger.error(`ロック喪失後のリーダー再選出エラー: ${hashForLog(username)}`, err),
        );
      }, delay);
    }
  }

  private handleStreamEnd(username: string): Promise<void> {
    const connection = this.connections.get(username);
    if (!connection) return Promise.resolve();
    return runStreamEndCleanup(username, connection, this.lockService);
  }

  async cleanupConnection(username: string): Promise<void> {
    const connection = this.connections.get(username);
    if (!connection) return;
    if (connection.cleanupPromise) return connection.cleanupPromise;

    const cleanup = this.cleanupConnectionOnce(username, connection);
    connection.cleanupPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (connection.cleanupPromise === cleanup) connection.cleanupPromise = undefined;
    }
  }

  private async cleanupConnectionOnce(username: string, connection: ConnectionInfo): Promise<void> {
    logger.info(`接続クリーンアップ: ${hashForLog(username)}`);

    // connect 中の SDK は即 disconnect できないため完了を待つ。
    await this.connectionPromises.get(username)?.catch((error) =>
      logger.debug(`クリーンアップ待機中の接続処理が失敗: ${hashForLog(username)}`, error),
    );
    // 待機中に別 client が追加された場合は接続を維持する。
    if (this.connections.get(username) !== connection || connection.clients.size > 0) return;

    this.leaderWatcher.stop(username);
    if (connection.unsubscribe) connection.unsubscribe();
    await disconnectTikTokServiceIfActive(connection);
    await releaseLeadershipIfHeld(username, connection, this.lockService);
    this.connections.delete(username);
  }

  async closeAll(): Promise<void> {
    this.leaderWatcher.stopAll();
    this.broadcaster.closeAllClients();
    await Promise.all(Array.from(this.connections.keys()).map((u) => this.cleanupConnection(u)));
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getClientCount(username: string): number {
    return this.connections.get(username)?.clients.size ?? 0;
  }

  getTotalClientCount(): number {
    let total = 0;
    for (const connection of this.connections.values()) {
      total += connection.clients.size;
    }
    return total;
  }

  isLeader(username: string): boolean {
    return this.connections.get(username)?.isLeader ?? false;
  }

  /**
   * /status は認証なしで公開されるため、配信者の username は含めず leader 数だけを返す
   * （Issue #2782）。
   */
  getStatus(): { connections: number; clients: number; leaders: number; limits: ConnectionLimits } {
    let leaders = 0;
    for (const c of this.connections.values()) if (c.isLeader) leaders++;
    return {
      connections: this.connections.size,
      clients: this.getTotalClientCount(),
      leaders,
      limits: { ...this.limits },
    };
  }

  /** 設定された接続上限を返す。/status 表示や運用可視化に使う。 */
  getLimits(): ConnectionLimits {
    return { ...this.limits };
  }
}
