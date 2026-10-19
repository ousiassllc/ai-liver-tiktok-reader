import { afterAll, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { WebSocket } from 'ws';
import * as realTikTokServiceNs from '../../../src/services/tiktok-service';
import * as realLoggerNs from '../../../src/utils/logger';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { DistributedLockService } from '../../../src/services/distributed-lock-service';
import { PubSubService } from '../../../src/services/pubsub-service';
import { TikTokService } from '../../../src/services/tiktok-service';
import type { Mocked } from '../../support/bun-test-types';

const realTikTokService = { ...realTikTokServiceNs };
const realLogger = { ...realLoggerNs };

mock.module('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

mock.module('../../../src/services/tiktok-service', () => ({
  TikTokService: jest.fn().mockImplementation(() => ({
    setBroadcastCallback: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  })),
}));

function buildMockWebSocket(): Mocked<WebSocket> {
  return {
    send: jest.fn(),
    readyState: WebSocket.OPEN,
    close: jest.fn(),
  } as any;
}

describe('ConnectionManager TikTok connection result', () => {
  let manager: ConnectionManager;
  let lockService: Mocked<DistributedLockService>;
  let pubsubService: Mocked<PubSubService>;

  beforeEach(() => {
    lockService = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      refreshLock: jest.fn(),
      startLockRefresh: jest.fn(),
      stopLockRefresh: jest.fn(),
      getLockHolder: jest.fn().mockResolvedValue(null),
      isLeader: jest.fn(),
    } as any;
    pubsubService = {
      subscribe: jest.fn().mockReturnValue(() => {}),
      publishEvent: jest.fn().mockResolvedValue(undefined),
    } as any;
    manager = new ConnectionManager(lockService, pubsubService);
  });

  it('reports CONNECTION_FAILED only when TikTokService.connect rejects', async () => {
    (TikTokService as unknown as jest.Mock).mockImplementationOnce(() => ({
      setBroadcastCallback: jest.fn(),
      connect: jest.fn().mockRejectedValue(new Error('all room ID sources failed')),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }));
    const ws = buildMockWebSocket();

    await manager.addClient('someuser', ws, 'session-1');

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toEqual({
      type: 'error',
      data: {
        code: 'CONNECTION_FAILED',
        message: 'all room ID sources failed',
      },
    });
    expect(lockService.releaseLock).toHaveBeenCalledWith('someuser');
    expect(lockService.stopLockRefresh).toHaveBeenCalledWith('someuser');
  });

  it('coalesces concurrent clients into one upstream attempt when connect fails', async () => {
    let rejectConnect!: (error: Error) => void;
    const connect = jest.fn(() => new Promise<void>((_resolve, reject) => {
      rejectConnect = reject;
    }));
    (TikTokService as unknown as jest.Mock).mockImplementationOnce(() => ({
      setBroadcastCallback: jest.fn(),
      connect,
      disconnect: jest.fn().mockResolvedValue(undefined),
    }));
    const clients = Array.from({ length: 20 }, () => buildMockWebSocket());

    const additions = clients.map((client) => manager.addClient('someuser', client, 'session-1'));
    await Promise.resolve();
    await Promise.resolve();

    expect(lockService.acquireLock).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);

    rejectConnect(new Error('stream unavailable'));
    await Promise.all(additions);

    expect(lockService.acquireLock).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight connection before cleaning up the last client', async () => {
    let resolveConnect!: () => void;
    const disconnect = jest.fn().mockResolvedValue(undefined);
    (TikTokService as unknown as jest.Mock).mockImplementationOnce(() => ({
      setBroadcastCallback: jest.fn(),
      connect: jest.fn(() => new Promise<void>((resolve) => { resolveConnect = resolve; })),
      disconnect,
    }));
    const ws = buildMockWebSocket();

    const adding = manager.addClient('someuser', ws, 'session-1');
    await Promise.resolve();
    const removing = manager.removeClient('someuser', ws);
    await Promise.resolve();

    expect(disconnect).not.toHaveBeenCalled();
    expect(manager.getConnectionCount()).toBe(1);

    resolveConnect();
    await Promise.all([adding, removing]);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(lockService.releaseLock).toHaveBeenCalledWith('someuser');
    expect(manager.getConnectionCount()).toBe(0);
  });

  it('does not delete a new client that arrives while the previous connection is disconnecting', async () => {
    let resolveDisconnect!: () => void;
    const disconnect = jest.fn(
      () => new Promise<void>((resolve) => { resolveDisconnect = resolve; }),
    );
    (TikTokService as unknown as jest.Mock).mockImplementationOnce(() => ({
      setBroadcastCallback: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect,
    }));
    const oldWs = buildMockWebSocket();
    const newWs = buildMockWebSocket();

    await manager.addClient('someuser', oldWs, 'session-1');
    const removing = manager.removeClient('someuser', oldWs);
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledTimes(1);

    const addingNew = manager.addClient('someuser', newWs, 'session-2');
    await Promise.resolve();
    expect(manager.getClientCount('someuser')).toBe(0);

    resolveDisconnect();
    await Promise.all([removing, addingNew]);

    expect(manager.getClientCount('someuser')).toBe(1);
    await manager.removeClient('someuser', newWs);
  });

  it('cleans local state when TikTok disconnect and lock release fail', async () => {
    (TikTokService as unknown as jest.Mock).mockImplementationOnce(() => ({
      setBroadcastCallback: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockRejectedValue(new Error('transport already closed')),
    }));
    lockService.releaseLock.mockRejectedValueOnce(new Error('lock store unavailable'));
    const ws = buildMockWebSocket();

    await manager.addClient('someuser', ws, 'session-1');
    await expect(manager.removeClient('someuser', ws)).resolves.toBeUndefined();

    expect(lockService.stopLockRefresh).toHaveBeenCalledWith('someuser');
    expect(manager.getConnectionCount()).toBe(0);
    expect(manager.isLeader('someuser')).toBe(false);
  });
});

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
  mock.module('../../../src/services/tiktok-service', () => realTikTokService);
});
