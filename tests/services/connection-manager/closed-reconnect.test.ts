import { afterAll, describe, expect, it, jest, mock } from 'bun:test';
import { WebSocket } from 'ws';
import * as realTikTokServiceNs from '../../../src/services/tiktok-service';
import * as realLoggerNs from '../../../src/utils/logger';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { WebSocketHandler } from '../../../src/handlers/websocket-handler';
import { TikTokService } from '../../../src/services/tiktok-service';
import type { DistributedLockService } from '../../../src/services/distributed-lock-service';
import type { PubSubService } from '../../../src/services/pubsub-service';

const realTikTokService = { ...realTikTokServiceNs };
const realLogger = { ...realLoggerNs };
mock.module('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
mock.module('../../../src/services/tiktok-service', () => ({ TikTokService: jest.fn() }));

function socket() {
  return { readyState: WebSocket.OPEN as number, send: jest.fn(), close: jest.fn() };
}

function fixture() {
  const lock = {
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(true),
    startLockRefresh: jest.fn(),
    stopLockRefresh: jest.fn(),
  };
  const unsubscribe = jest.fn();
  const pubsub = { subscribe: jest.fn().mockReturnValue(unsubscribe) };
  const manager = new ConnectionManager(lock as unknown as DistributedLockService, pubsub as unknown as PubSubService);
  return { manager, lock, pubsub, unsubscribe };
}

describe('ConnectionManager closed reconnect', () => {
  it.each([WebSocket.CLOSING, WebSocket.CLOSED])('does not recreate a connection after pending cleanup when the new socket is %p', async (state) => {
    const { manager, lock, pubsub, unsubscribe } = fixture();
    let finishDisconnect!: () => void;
    let signalDisconnect!: () => void;
    const disconnectStarted = new Promise<void>((resolve) => { signalDisconnect = resolve; });
    const disconnect = jest.fn(() => {
      signalDisconnect();
      return new Promise<void>((resolve) => { finishDisconnect = resolve; });
    });
    const createService = TikTokService as unknown as jest.Mock;
    createService.mockReset();
    createService.mockImplementation(() => ({
      setBroadcastCallback: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect,
    }));
    const first = socket();
    await manager.addClient('alice', first as unknown as WebSocket, 'session-A');
    const removing = manager.removeClient('alice', first as unknown as WebSocket);
    await disconnectStarted;

    const next = socket();
    const handler = new WebSocketHandler(manager, { sessionId: 'session-B', username: 'alice' });
    const adding = handler.handleMessage(next as unknown as WebSocket,
      JSON.stringify({ type: 'connect', liveUrl: '@alice', sessionId: 'session-B' }));
    next.readyState = state;
    const closing = handler.handleClose(next as unknown as WebSocket);
    finishDisconnect();
    await Promise.all([removing, adding, closing]);

    expect(manager.getConnectionCount()).toBe(0);
    expect(manager.getTotalClientCount()).toBe(0);
    expect(manager.isLeader('alice')).toBe(false);
    expect(lock.acquireLock).toHaveBeenCalledTimes(1);
    expect(lock.releaseLock).toHaveBeenCalledTimes(1);
    expect(createService).toHaveBeenCalledTimes(1);
    expect(pubsub.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores an already closed socket without creating a subscription or acquiring a lock', async () => {
    const { manager, lock, pubsub } = fixture();
    const ws = socket();
    ws.readyState = WebSocket.CLOSED;
    await manager.addClient('alice', ws as unknown as WebSocket, 'session-A');
    expect(manager.getConnectionCount()).toBe(0);
    expect(lock.acquireLock).not.toHaveBeenCalled();
    expect(pubsub.subscribe).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
  mock.module('../../../src/services/tiktok-service', () => realTikTokService);
});
