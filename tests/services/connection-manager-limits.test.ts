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
 * Issue #590 regression tests: TikTok 同時接続数制限。
 *
 * spec: docs/content/docs/tiktok-connector/_index.md セクション「制限事項 / 接続数制限」
 *
 * - グローバル上限 (maxTotalClients) 超過で ConnectionLimitError('total')
 * - ユーザーあたり上限 (maxClientsPerUser) 超過で ConnectionLimitError('per_user')
 * - 上限=0 は「制限なし」
 * - 同一 ws の再 addClient は冪等（新規カウントされない）
 * - 上限超過で throw された時、内部状態（connections / clients）に汚染が残らない
 */
import { WebSocket } from 'ws';
import { ConnectionManager } from '../../src/services/connection-manager';
import { DistributedLockService } from '../../src/services/distributed-lock-service';
import { PubSubService } from '../../src/services/pubsub-service';
import {
  ConnectionLimitError,
  loadConnectionLimitsFromEnv,
  noConnectionLimits,
} from '../../src/services/connection-limits';

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

describe('ConnectionManager - Issue #590 connection limits', () => {
  describe('loadConnectionLimitsFromEnv', () => {
    it('未設定は 0 (制限なし)', () => {
      const limits = loadConnectionLimitsFromEnv({});
      expect(limits.maxTotalClients).toBe(0);
      expect(limits.maxClientsPerUser).toBe(0);
    });

    it('数値を正しく読み込む', () => {
      const limits = loadConnectionLimitsFromEnv({
        TIKTOK_READER_MAX_TOTAL_CLIENTS: '100',
        TIKTOK_READER_MAX_CLIENTS_PER_USER: '10',
      });
      expect(limits.maxTotalClients).toBe(100);
      expect(limits.maxClientsPerUser).toBe(10);
    });

    it('負値・数値化できない値は 0 として扱う', () => {
      const limits = loadConnectionLimitsFromEnv({
        TIKTOK_READER_MAX_TOTAL_CLIENTS: '-5',
        TIKTOK_READER_MAX_CLIENTS_PER_USER: 'not-a-number',
      });
      expect(limits.maxTotalClients).toBe(0);
      expect(limits.maxClientsPerUser).toBe(0);
    });

    it('空文字は 0 として扱う', () => {
      const limits = loadConnectionLimitsFromEnv({
        TIKTOK_READER_MAX_TOTAL_CLIENTS: '',
        TIKTOK_READER_MAX_CLIENTS_PER_USER: '',
      });
      expect(limits.maxTotalClients).toBe(0);
      expect(limits.maxClientsPerUser).toBe(0);
    });
  });

  describe('maxTotalClients (グローバル上限)', () => {
    it('上限=2 でグローバル 3 件目の接続は拒否される', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, {
        maxTotalClients: 2,
        maxClientsPerUser: 0,
      });

      await manager.addClient('alice', buildMockWebSocket(), 's1');
      await manager.addClient('bob', buildMockWebSocket(), 's2');

      const rejectedWs = buildMockWebSocket();
      await expect(manager.addClient('carol', rejectedWs, 's3'))
        .rejects.toBeInstanceOf(ConnectionLimitError);

      expect(manager.getTotalClientCount()).toBe(2);
      // carol の connection は作られていない
      expect(manager.getClientCount('carol')).toBe(0);
    });

    it('拒否エラーには reason=total と現状値が乗る', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, {
        maxTotalClients: 1,
        maxClientsPerUser: 0,
      });

      await manager.addClient('alice', buildMockWebSocket(), 's1');

      try {
        await manager.addClient('bob', buildMockWebSocket(), 's2');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionLimitError);
        const e = err as ConnectionLimitError;
        expect(e.reason).toBe('total');
        expect(e.limit).toBe(1);
        expect(e.current).toBe(1);
      }
    });
  });

  describe('maxClientsPerUser (ユーザー単位上限)', () => {
    it('上限=2 で同一ユーザー 3 件目の接続は拒否される', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, {
        maxTotalClients: 0,
        maxClientsPerUser: 2,
      });

      await manager.addClient('streamer', buildMockWebSocket(), 's1');
      await manager.addClient('streamer', buildMockWebSocket(), 's1');

      const rejectedWs = buildMockWebSocket();
      await expect(manager.addClient('streamer', rejectedWs, 's1'))
        .rejects.toBeInstanceOf(ConnectionLimitError);

      expect(manager.getClientCount('streamer')).toBe(2);
    });

    it('別ユーザーは同じ per-user 上限に影響しない', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, {
        maxTotalClients: 0,
        maxClientsPerUser: 1,
      });

      await manager.addClient('alice', buildMockWebSocket(), 's1');
      await manager.addClient('bob', buildMockWebSocket(), 's2');

      expect(manager.getClientCount('alice')).toBe(1);
      expect(manager.getClientCount('bob')).toBe(1);
      expect(manager.getTotalClientCount()).toBe(2);
    });

    it('拒否エラーには reason=per_user が乗る', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, {
        maxTotalClients: 0,
        maxClientsPerUser: 1,
      });

      await manager.addClient('streamer', buildMockWebSocket(), 's1');

      try {
        await manager.addClient('streamer', buildMockWebSocket(), 's1');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionLimitError);
        expect((err as ConnectionLimitError).reason).toBe('per_user');
      }
    });
  });

  describe('制限なし (デフォルト)', () => {
    it('maxTotalClients=0, maxClientsPerUser=0 の場合はいくつでも受け入れる', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, noConnectionLimits());

      for (let i = 0; i < 20; i++) {
        await manager.addClient(`user${i}`, buildMockWebSocket(), `s${i}`);
      }
      expect(manager.getTotalClientCount()).toBe(20);
    });

    it('コンストラクタで limits を省略した場合も制限なし', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService);

      for (let i = 0; i < 5; i++) {
        await manager.addClient('streamer', buildMockWebSocket(), 's');
      }
      expect(manager.getClientCount('streamer')).toBe(5);
    });
  });

  describe('冪等性 / 内部状態', () => {
    it('同じ ws を再 addClient しても新規席として消費しない', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, {
        maxTotalClients: 1,
        maxClientsPerUser: 0,
      });

      const ws = buildMockWebSocket();
      await manager.addClient('alice', ws, 's1');
      // 同一 ws 再登録は Set が冪等に扱うので上限には影響しない
      await expect(manager.addClient('alice', ws, 's1')).resolves.toBeUndefined();
      expect(manager.getClientCount('alice')).toBe(1);
    });

    it('上限拒否時に新規 username の connection マップは残さない', async () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, {
        maxTotalClients: 1,
        maxClientsPerUser: 0,
      });

      await manager.addClient('alice', buildMockWebSocket(), 's1');

      await expect(manager.addClient('bob', buildMockWebSocket(), 's2'))
        .rejects.toBeInstanceOf(ConnectionLimitError);

      // bob 用の connection は作られていない
      const status = manager.getStatus();
      expect(status.connections).toBe(1);
      expect(status.clients).toBe(1);
    });

    it('getStatus / getLimits は設定した制限値を返す', () => {
      const { lockService, pubsubService } = buildMockServices();
      const manager = new ConnectionManager(lockService, pubsubService, {
        maxTotalClients: 42,
        maxClientsPerUser: 7,
      });
      expect(manager.getLimits()).toEqual({ maxTotalClients: 42, maxClientsPerUser: 7 });
      expect(manager.getStatus().limits).toEqual({ maxTotalClients: 42, maxClientsPerUser: 7 });
    });
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
  mock.module('../../src/services/tiktok-service', () => realTikTokService);
});
