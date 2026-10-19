import { afterAll, describe, expect, it, jest, mock } from 'bun:test';
import { WebSocket } from 'ws';
import * as realLoggerNs from '../../../src/utils/logger';
import type { DistributedLockService } from '../../../src/services/distributed-lock-service';
import type { PubSubService } from '../../../src/services/pubsub-service';
import { ConnectionManager } from '../../../src/services/connection-manager';

const realLogger = { ...realLoggerNs };

mock.module('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('ConnectionManager lock loss', () => {
  it('SDK切断待ちの間も旧leaderのeventを配信しない', async () => {
    let resolveDisconnect!: () => void;
    let notifyDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => { notifyDisconnectStarted = resolve; });
    const disconnect = jest.fn(() => {
      notifyDisconnectStarted();
      return new Promise<void>((resolve) => { resolveDisconnect = resolve; });
    });
    const lockService = {
      stopLockRefresh: jest.fn(),
    } as unknown as DistributedLockService;
    const publishEvent = jest.fn().mockResolvedValue(undefined);
    const pubsubService = { publishEvent } as unknown as PubSubService;
    const manager = new ConnectionManager(lockService, pubsubService);
    const send = jest.fn();
    const client = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    const connection = {
      username: 'streamer',
      tiktokService: { disconnect },
      clients: new Set([client]),
      isLeader: true,
      sessionId: 'session',
      connecting: true,
      pendingMessages: [{
        type: 'comment',
        username: 'streamer',
        data: { text: 'new-leader' },
        timestamp: '2026-08-26T00:00:00.000Z',
        instanceId: 'new-leader',
      }],
    };
    (manager as any).connections.set('streamer', connection);

    const losingLock = (manager as any).handleLockLost('streamer') as Promise<void>;
    expect(connection.isLeader).toBe(false);
    expect(connection.connecting).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: 'comment',
      data: { text: 'new-leader' },
    }));
    connection.clients.clear();

    (manager as any).handleTikTokMessage('streamer', JSON.stringify({
      type: 'comment',
      data: { text: 'stale' },
    }));
    expect(publishEvent).not.toHaveBeenCalled();

    await disconnectStarted;
    resolveDisconnect();
    await losingLock;
  });

  it('lock holderを確認できない場合はconnectedではなくreconnectingを返す', async () => {
    const lockService = {
      acquireLock: jest.fn().mockResolvedValue(false),
      getLockHolder: jest.fn().mockResolvedValue(null),
    } as unknown as DistributedLockService;
    const pubsubService = {
      subscribe: jest.fn().mockReturnValue(() => undefined),
    } as unknown as PubSubService;
    const manager = new ConnectionManager(lockService, pubsubService);
    const send = jest.fn();
    const client = {
      readyState: WebSocket.OPEN,
      send,
      close: jest.fn(),
    } as unknown as WebSocket;

    await manager.addClient('streamer', client, 'session');

    expect(JSON.parse(send.mock.calls[0][0] as string).data.status).toBe('reconnecting');
    await manager.closeAll();
  });
});

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
});
