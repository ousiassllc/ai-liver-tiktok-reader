import { describe, it, expect, beforeEach, mock, jest, afterAll } from 'bun:test';
// bun の mock.module はプロセス全体に永続し、mock.restore() でも元に戻らない
// (jest.mock はファイルスコープだったのでこの後始末は不要だった)。namespace
// import は live binding で書き換えが遡るため、スプレッドで値を退避しておき
// ファイル末尾で再登録して他テストへの汚染を打ち消す。
import * as realTikTokServiceNs from '../../src/services/tiktok-service';
import * as realLoggerNs from '../../src/utils/logger';
const realTikTokService = { ...realTikTokServiceNs };
const realLogger = { ...realLoggerNs };
import type { Mocked } from '../support/bun-test-types';
import { WebSocket } from 'ws';
import { ConnectionManager } from '../../src/services/connection-manager';
import { DistributedLockService } from '../../src/services/distributed-lock-service';
import { PubSubService, TikTokEventMessage } from '../../src/services/pubsub-service';

mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// TikTokService をモック（leader 確定時に new されるが、テストでは触らない）
mock.module('../../src/services/tiktok-service', () => ({
  TikTokService: jest.fn().mockImplementation(() => ({
    setBroadcastCallback: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  })),
}));

function buildEvent(overrides: Partial<TikTokEventMessage> = {}): TikTokEventMessage {
  return {
    type: overrides.type ?? 'comment',
    username: overrides.username ?? 'someuser',
    data: overrides.data ?? { text: 'hi' },
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    instanceId: overrides.instanceId ?? 'other-instance',
  };
}

function buildMockWebSocket(): Mocked<WebSocket> {
  return {
    send: jest.fn(),
    readyState: WebSocket.OPEN,
    close: jest.fn(),
  } as any;
}

describe('ConnectionManager.handlePubSubMessage / flushPendingMessages', () => {
  let manager: ConnectionManager;
  let lockService: Mocked<DistributedLockService>;
  let pubsubService: Mocked<PubSubService>;

  beforeEach(() => {
    lockService = {
      acquireLock: jest.fn(),
      releaseLock: jest.fn(),
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

  // 内部 connections マップに直接接続を登録するヘルパ
  function registerConnection(username: string, opts: {
    connecting?: boolean;
    isLeader?: boolean;
    clients?: WebSocket[];
  } = {}) {
    const connection = {
      username,
      tiktokService: null,
      clients: new Set<WebSocket>(opts.clients ?? []),
      isLeader: opts.isLeader ?? false,
      sessionId: 'session-1',
      connecting: opts.connecting ?? false,
      pendingMessages: [] as TikTokEventMessage[],
    };
    (manager as any).connections.set(username, connection);
    return connection;
  }

  it('connecting=true 中の Pub/Sub メッセージは broadcast されず pendingMessages に積まれる', () => {
    const ws = buildMockWebSocket();
    const conn = registerConnection('someuser', { connecting: true, clients: [ws] });

    const message = buildEvent({ username: 'someuser', data: { text: 'queued' } });
    (manager as any).handlePubSubMessage('someuser', message);

    expect(ws.send).not.toHaveBeenCalled();
    expect(conn.pendingMessages).toHaveLength(1);
    expect(conn.pendingMessages[0]).toBe(message);
  });

  it('リーダー確定後（isLeader=true）、キュー内メッセージは破棄される', () => {
    const ws = buildMockWebSocket();
    const conn = registerConnection('someuser', { connecting: true, clients: [ws] });

    (manager as any).handlePubSubMessage('someuser', buildEvent({ username: 'someuser' }));
    (manager as any).handlePubSubMessage('someuser', buildEvent({ username: 'someuser' }));
    expect(conn.pendingMessages).toHaveLength(2);

    // リーダー確定をシミュレート
    conn.connecting = false;
    conn.isLeader = true;

    (manager as any).flushPendingMessages('someuser');

    expect(ws.send).not.toHaveBeenCalled();
    expect(conn.pendingMessages).toHaveLength(0);
  });

  it('非リーダー確定後、キュー内メッセージが flush されて broadcast される', () => {
    const ws = buildMockWebSocket();
    const conn = registerConnection('someuser', { connecting: true, clients: [ws] });

    const m1 = buildEvent({ username: 'someuser', type: 'comment', data: { text: 'a' } });
    const m2 = buildEvent({ username: 'someuser', type: 'gift', data: { name: 'rose' } });
    (manager as any).handlePubSubMessage('someuser', m1);
    (manager as any).handlePubSubMessage('someuser', m2);
    expect(conn.pendingMessages).toHaveLength(2);

    // 非リーダー確定をシミュレート
    conn.connecting = false;
    conn.isLeader = false;

    (manager as any).flushPendingMessages('someuser');

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'comment', data: { text: 'a' } }));
    expect(ws.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'gift', data: { name: 'rose' } }));
    expect(conn.pendingMessages).toHaveLength(0);
  });

  it('キュー上限 100 で古いものから捨てられる', () => {
    const ws = buildMockWebSocket();
    const conn = registerConnection('someuser', { connecting: true, clients: [ws] });

    for (let i = 0; i < 150; i++) {
      (manager as any).handlePubSubMessage(
        'someuser',
        buildEvent({ username: 'someuser', data: { seq: i } }),
      );
    }

    // 上限 100 件、最後の 100 件（seq=50..149）が残る
    expect(conn.pendingMessages).toHaveLength(100);
    expect((conn.pendingMessages[0].data as any).seq).toBe(50);
    expect((conn.pendingMessages[99].data as any).seq).toBe(149);
  });

  it('connecting=false かつ isLeader=true の場合はキューに積まれず破棄される（リーダー二重配信回避）', () => {
    const ws = buildMockWebSocket();
    registerConnection('someuser', { connecting: false, isLeader: true, clients: [ws] });

    (manager as any).handlePubSubMessage(
      'someuser',
      buildEvent({ username: 'someuser' }),
    );

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('connecting=false かつ isLeader=false の場合は即 broadcast される', () => {
    const ws = buildMockWebSocket();
    registerConnection('someuser', { connecting: false, isLeader: false, clients: [ws] });

    (manager as any).handlePubSubMessage(
      'someuser',
      buildEvent({ username: 'someuser', type: 'comment', data: { text: 'hi' } }),
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'comment', data: { text: 'hi' } }),
    );
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
  mock.module('../../src/services/tiktok-service', () => realTikTokService);
});
