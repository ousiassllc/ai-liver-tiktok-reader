import { afterAll, describe, expect, it, jest, mock } from 'bun:test';
import { WebSocket } from 'ws';
import * as realLoggerNs from '../../../src/utils/logger';
import { ConnectionManager } from '../../../src/services/connection-manager';
import type { DistributedLockService } from '../../../src/services/distributed-lock-service';
import type { PubSubService } from '../../../src/services/pubsub-service';

const realLogger = { ...realLoggerNs };

mock.module('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('ConnectionManager.closeAll', () => {
  it('接続中clientを閉じてTikTok切断とlease解放を実行する', async () => {
    const lockCleanupOrder: string[] = [];
    const releaseLock = jest.fn(async () => { lockCleanupOrder.push('release'); return true; });
    const stopLockRefresh = jest.fn(() => { lockCleanupOrder.push('stop-refresh'); });
    const lockService = {
      releaseLock,
      stopLockRefresh,
    } as unknown as DistributedLockService;
    const pubsubService = {} as PubSubService;
    const manager = new ConnectionManager(lockService, pubsubService);
    const client = {
      readyState: WebSocket.OPEN,
      close: jest.fn(),
    } as unknown as WebSocket;
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const unsubscribe = jest.fn();

    (manager as any).connections.set('streamer', {
      username: 'streamer',
      tiktokService: { disconnect },
      clients: new Set([client]),
      isLeader: true,
      sessionId: 'session',
      connecting: false,
      pendingMessages: [],
      unsubscribe,
    });

    await manager.closeAll();

    expect(client.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledWith('streamer');
    expect(stopLockRefresh).toHaveBeenCalledWith('streamer');
    expect(lockCleanupOrder).toEqual(['stop-refresh', 'release']);
    expect(manager.getConnectionCount()).toBe(0);
  });
});

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
});
