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

import { ConnectionManager } from '../../src/services/connection-manager';
import { DistributedLockService } from '../../src/services/distributed-lock-service';
import { PubSubService } from '../../src/services/pubsub-service';
import { hashForLog } from '../../src/utils/hash-for-log';
import { logger } from '../../src/utils/logger';

const loggerMock = logger as unknown as {
  info: jest.Mock;
  error: jest.Mock;
  warn: jest.Mock;
  debug: jest.Mock;
};

function buildMockWebSocket(): Mocked<WebSocket> {
  return {
    send: jest.fn(),
    readyState: WebSocket.OPEN,
    close: jest.fn(),
  } as any;
}

function allLoggedMessages(): string[] {
  const spies = [loggerMock.info, loggerMock.error, loggerMock.warn, loggerMock.debug];
  const messages: string[] = [];
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      const first = call[0];
      if (typeof first === 'string') messages.push(first);
    }
  }
  return messages;
}

/**
 * refine-sweep iter-7 tiktok-reader MINOR 回帰テスト:
 * ConnectionManager は 11 か所で TikTok username を含むログを吐くが、
 * どれも hashForLog を経由し、平文の username を残してはならない。
 * 平文が漏れた場合はこのテストが失敗する。
 */
describe('ConnectionManager PII logging (regression for iter-7 MINOR)', () => {
  let manager: ConnectionManager;
  let lockService: Mocked<DistributedLockService>;
  let pubsubService: Mocked<PubSubService>;
  const USERNAME = 'plaintext_pii_username';

  beforeEach(() => {
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.debug.mockClear();

    lockService = {
      acquireLock: jest.fn().mockResolvedValue(false),
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

  it('ConnectionManager 由来のログに平文 username が含まれない (hashForLog 経由になっている)', async () => {
    const ws = buildMockWebSocket();
    await manager.addClient(USERNAME, ws, 'session-1');
    await manager.removeClient(USERNAME, ws);

    const messages = allLoggedMessages();
    // ConnectionManager が出力する 11 か所のログ文言プレフィックス。
    // これらのメッセージには絶対に平文 username が含まれてはならない (SHA-256 hex のみ許容)。
    const connectionManagerPrefixes = [
      'クライアント追加',
      'クライアント削除',
      '接続処理中のため待機',
      '先行 connection promise が失敗',
      'リーダー選出',
      'TikTok Live接続完了',
      'TikTok Live接続エラー',
      'ロック喪失',
      'ロック喪失後のリーダー再選出エラー',
      '配信終了検出',
      '接続クリーンアップ',
    ];
    const cmMessages = messages.filter((m) =>
      connectionManagerPrefixes.some((prefix) => m.startsWith(prefix)),
    );
    // 少なくとも「クライアント追加」ログは出ている
    expect(cmMessages.some((m) => m.startsWith('クライアント追加'))).toBe(true);
    for (const m of cmMessages) {
      expect(m).not.toContain(USERNAME);
    }
    // かわりに SHA-256(先頭16文字) hash が現れる
    const expectedHash = hashForLog(USERNAME)!;
    expect(cmMessages.some((m) => m.includes(expectedHash))).toBe(true);
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
  mock.module('../../src/services/tiktok-service', () => realTikTokService);
});
