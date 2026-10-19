import { describe, it, expect, afterEach, mock, jest, afterAll } from 'bun:test';
// bun の mock.module はプロセス全体に永続し、mock.restore() でも元に戻らない
// (jest.mock はファイルスコープだったのでこの後始末は不要だった)。namespace
// import は live binding で書き換えが遡るため、スプレッドで値を退避しておき
// ファイル末尾で再登録して他テストへの汚染を打ち消す。
import * as realConnectionManagerNs from '../../src/services/connection-manager';
import * as realLoggerNs from '../../src/utils/logger';
const realConnectionManager = { ...realConnectionManagerNs };
const realLogger = { ...realLoggerNs };
/**
 * Issue #925 regression test.
 *
 * routes モジュールの依存が「モジュール直下の let 変数」だった時代は、
 * テスト1で inject した ConnectionManager / RateLimiter / RenderTokenVerifier が
 * テスト2 まで leak してしまい、Jest でモジュールを reset しない限り独立性が保てなかった。
 *
 * このテストは以下を担保する:
 * 1. setter で inject した値が `getRouterContext()` に反映される
 * 2. `resetRouterContext()` を呼ぶと全依存が初期状態 (null / trustProxy=true) に戻る
 * 3. reset 後は WebSocket 接続時に `Server not ready` で拒否される (ConnectionManager が空)
 */

// bun の mock.module は factory 必須 (jest の自動モック相当が無い)。
// テストは setConnectionManager で別途スタブを注入するため、ここでは
// import 時の副作用を避けるためにクラスを空のコンストラクタへ置き換える。
mock.module('../../src/services/connection-manager', () => ({
  ConnectionManager: jest.fn(),
}));
mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { WebSocket } from 'ws';
import {
  setConnectionManager,
  setWebSocketRateLimiter,
  setRenderTokenVerifier,
  resetRouterContext,
  getRouterContext,
  handleWebSocketConnection,
} from '../../src/routes';
import { createMockConnectionManager } from './routes-test-setup';

describe('Issue #925: router context isolation', () => {
  afterEach(() => {
    resetRouterContext();
    jest.clearAllMocks();
  });

  it('setter で inject した値が context に反映される', () => {
    const manager = createMockConnectionManager();
    const limiter = {
      check: jest.fn(),
      startCleanupTimer: jest.fn(),
      stopCleanupTimer: jest.fn(),
    } as unknown as Parameters<typeof setWebSocketRateLimiter>[0];
    const verifier = {
      verifyRenderToken: jest.fn().mockResolvedValue({ valid: true, platform: 'tiktok' }),
    };

    setConnectionManager(manager as never);
    setWebSocketRateLimiter(limiter, false, 2);
    setRenderTokenVerifier(verifier);

    const ctx = getRouterContext();
    expect(ctx.connectionManager).toBe(manager as never);
    expect(ctx.wsRateLimiter).toBe(limiter);
    expect(ctx.wsRateLimiterTrustProxy).toBe(false);
    expect(ctx.wsRateLimiterTrustedProxyHops).toBe(2);
    expect(ctx.renderTokenVerifier).toBe(verifier);
  });

  it('resetRouterContext() が全依存を初期状態に戻す', () => {
    const manager = createMockConnectionManager();
    setConnectionManager(manager as never);
    setWebSocketRateLimiter({} as never, false);
    setRenderTokenVerifier({
      verifyRenderToken: jest.fn().mockResolvedValue({ valid: false }),
    });

    resetRouterContext();

    const ctx = getRouterContext();
    expect(ctx.connectionManager).toBeNull();
    expect(ctx.wsRateLimiter).toBeNull();
    expect(ctx.wsRateLimiterTrustProxy).toBe(true);
    expect(ctx.wsRateLimiterTrustedProxyHops).toBe(0);
    expect(ctx.renderTokenVerifier).toBeNull();
  });

  it('reset 後は ConnectionManager 未初期化として WebSocket が拒否される', () => {
    const manager = createMockConnectionManager();
    setConnectionManager(manager as never);

    // 事前状態: 接続が成立するはず (mockWs.close が 1011 で呼ばれない)
    const mockWs1 = {
      on: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      readyState: WebSocket.OPEN,
    };
    handleWebSocketConnection(mockWs1 as unknown as WebSocket);
    expect(mockWs1.close).not.toHaveBeenCalled();

    // reset 後: ConnectionManager がクリアされて 1011 で拒否される
    resetRouterContext();

    const mockWs2 = {
      on: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      readyState: WebSocket.OPEN,
    };
    handleWebSocketConnection(mockWs2 as unknown as WebSocket);
    expect(mockWs2.close).toHaveBeenCalledWith(1011, 'Server not ready');
  });
});

afterAll(() => {
  mock.module('../../src/services/connection-manager', () => realConnectionManager);
  mock.module('../../src/utils/logger', () => realLogger);
});
