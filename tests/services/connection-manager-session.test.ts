import { describe, it, expect, mock, jest, afterAll } from 'bun:test';
// bun の mock.module はプロセス全体に永続し、mock.restore() でも元に戻らない
// (jest.mock はファイルスコープだったのでこの後始末は不要だった)。namespace
// import は live binding で書き換えが遡るため、スプレッドで値を退避しておき
// ファイル末尾で再登録して他テストへの汚染を打ち消す。
import * as realTikTokServiceNs from '../../src/services/tiktok-service';
import * as realLoggerNs from '../../src/utils/logger';
const realTikTokService = { ...realTikTokServiceNs };
const realLogger = { ...realLoggerNs };
import type { Mocked } from '../support/bun-test-types';
/**
 * Issue #2782 regression tests: 1 配信者 = 同時に 1 session の契約と、公開 /status に配信者名を出さないこと。
 */
import { WebSocket } from 'ws';
import { ConnectionManager } from '../../src/services/connection-manager';
import { DistributedLockService } from '../../src/services/distributed-lock-service';
import { PubSubService } from '../../src/services/pubsub-service';
import { SessionConflictError } from '../../src/services/connection-limits';
import { WebSocketHandler } from '../../src/handlers/websocket-handler';
import { UNRESTRICTED_SCOPE } from '../../src/routes/auth';

mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

mock.module('../../src/services/tiktok-service', () => ({
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
  } as unknown as Mocked<WebSocket>;
}

function buildMockServices() {
  const lockService = {
    acquireLock: jest.fn().mockResolvedValue(false),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    refreshLock: jest.fn(),
    startLockRefresh: jest.fn(),
    stopLockRefresh: jest.fn(),
    getLockHolder: jest.fn().mockResolvedValue(null),
    isLeader: jest.fn(),
  } as unknown as Mocked<DistributedLockService>;

  const pubsubService = {
    subscribe: jest.fn().mockReturnValue(() => {}),
    publishEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as Mocked<PubSubService>;

  return { lockService, pubsubService };
}

describe('ConnectionManager - Issue #2782 session 契約', () => {
  it('接続中の配信者に別 session で接続すると SessionConflictError で拒否し、先行 session を変えない', async () => {
    const { lockService, pubsubService } = buildMockServices();
    const manager = new ConnectionManager(lockService, pubsubService);
    await manager.addClient('alice', buildMockWebSocket(), 'session-A');

    await expect(manager.addClient('alice', buildMockWebSocket(), 'session-B'))
      .rejects.toBeInstanceOf(SessionConflictError);

    expect(manager.getClientCount('alice')).toBe(1);
  });

  it('同じ session からの複数 client は相乗りできる', async () => {
    const { lockService, pubsubService } = buildMockServices();
    const manager = new ConnectionManager(lockService, pubsubService);
    await manager.addClient('alice', buildMockWebSocket(), 'session-A');
    await manager.addClient('alice', buildMockWebSocket(), 'session-A');

    expect(manager.getClientCount('alice')).toBe(2);
  });

  it('先行 session の client が全員抜けた後は別 session で接続できる', async () => {
    const { lockService, pubsubService } = buildMockServices();
    const manager = new ConnectionManager(lockService, pubsubService);
    const first = buildMockWebSocket();
    await manager.addClient('alice', first, 'session-A');
    await manager.removeClient('alice', first);

    await expect(manager.addClient('alice', buildMockWebSocket(), 'session-B')).resolves.toBeUndefined();
  });

  it('getStatus は配信者名ではなく leader 数だけを返す', async () => {
    const { lockService, pubsubService } = buildMockServices();
    lockService.acquireLock.mockResolvedValue(true);
    const manager = new ConnectionManager(lockService, pubsubService);
    await manager.addClient('synthetic-streamer', buildMockWebSocket(), 'session-A');

    const status = manager.getStatus();

    expect(status.leaders).toBe(1);
    expect(JSON.stringify(status)).not.toContain('synthetic-streamer');
  });

  it('配信者の大小文字を変えても別 session は同じ接続に対する競合として拒否する', async () => {
    const { lockService, pubsubService } = buildMockServices();
    const manager = new ConnectionManager(lockService, pubsubService);
    const first = buildMockWebSocket();
    const second = buildMockWebSocket();
    try {
      await new WebSocketHandler(manager, { sessionId: 'A', username: 'alice' })
        .handleMessage(first, JSON.stringify({ type: 'connect', liveUrl: '@Alice', sessionId: 'A' }));
      await new WebSocketHandler(manager, { sessionId: 'B', username: 'alice' })
        .handleMessage(second, JSON.stringify({ type: 'connect', liveUrl: '@alice', sessionId: 'B' }));

      expect(second.send).toHaveBeenCalledWith(expect.stringContaining('SESSION_CONFLICT'));
      expect(manager.getConnectionCount()).toBe(1);
      expect(manager.getClientCount('alice')).toBe(1);
    } finally {
      await manager.closeAll();
    }
  });

  it('同一 session の大小文字違いは上流接続を共有し、両方の close で解放する', async () => {
    const { lockService, pubsubService } = buildMockServices();
    lockService.acquireLock.mockResolvedValue(true);
    const manager = new ConnectionManager(lockService, pubsubService);
    const first = buildMockWebSocket();
    const second = buildMockWebSocket();
    const scope = { sessionId: 'A', username: 'alice' };
    const firstHandler = new WebSocketHandler(manager, scope);
    const secondHandler = new WebSocketHandler(manager, scope);
    try {
      await firstHandler.handleMessage(first, JSON.stringify({ type: 'connect', liveUrl: '@Alice', sessionId: 'A' }));
      await secondHandler.handleMessage(second, JSON.stringify({ type: 'connect', liveUrl: '@alice', sessionId: 'A' }));

      expect(manager.getConnectionCount()).toBe(1);
      expect(manager.getClientCount('alice')).toBe(2);
      expect(lockService.acquireLock).toHaveBeenCalledTimes(1);
      await firstHandler.handleClose(first);
      await secondHandler.handleClose(second);
      expect(manager.getConnectionCount()).toBe(0);
    } finally {
      await manager.closeAll();
    }
  });

  it('同じ WebSocket の session 差し替えを拒否した後に先行登録とロックを残さない', async () => {
    const { lockService, pubsubService } = buildMockServices();
    lockService.acquireLock.mockResolvedValue(true);
    const manager = new ConnectionManager(lockService, pubsubService);
    const ws = buildMockWebSocket();
    const handler = new WebSocketHandler(manager, UNRESTRICTED_SCOPE);
    try {
      await handler.handleMessage(ws, JSON.stringify({ type: 'connect', liveUrl: '@alice', sessionId: 'A' }));
      await handler.handleMessage(ws, JSON.stringify({ type: 'connect', liveUrl: '@alice', sessionId: 'B' }));
      await handler.handleClose(ws);

      expect(ws.close).toHaveBeenCalledWith(1008, 'session conflict');
      expect(manager.getTotalClientCount()).toBe(0);
      expect(manager.getConnectionCount()).toBe(0);
      expect(lockService.releaseLock).toHaveBeenCalledWith('alice');
    } finally {
      await manager.closeAll();
    }
  });

  it.each(['', undefined])('先行 session が %p でも後着の実 session への付け替えを拒否する', async (sessionId) => {
    const { lockService, pubsubService } = buildMockServices();
    lockService.acquireLock.mockResolvedValue(true);
    const manager = new ConnectionManager(lockService, pubsubService);
    try {
      await manager.addClient('alice', buildMockWebSocket(), sessionId);
      await expect(manager.addClient('alice', buildMockWebSocket(), 'A')).rejects.toBeInstanceOf(SessionConflictError);
      expect(manager.getClientCount('alice')).toBe(1);
    } finally {
      await manager.closeAll();
    }
  });

  it('session 未指定同士は同じ接続を共有できる', async () => {
    const { lockService, pubsubService } = buildMockServices();
    const manager = new ConnectionManager(lockService, pubsubService);
    try {
      await manager.addClient('alice', buildMockWebSocket());
      await manager.addClient('alice', buildMockWebSocket(), '');
      expect(manager.getClientCount('alice')).toBe(2);
    } finally {
      await manager.closeAll();
    }
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
  mock.module('../../src/services/tiktok-service', () => realTikTokService);
});
