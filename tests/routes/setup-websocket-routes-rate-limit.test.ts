import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import {
  createRouteUpgradeTestContext,
  setupWebSocketRoutes,
  setWebSocketRateLimiter
} from './routes-test-setup';
import { RateLimiter } from '../../src/services/rate-limiter';

/**
 * Issue #589: /ws/events の接続に IP ベースのレート制限を適用する。
 *
 * 期待動作:
 * - 上限内なら通常どおり handleUpgrade を呼ぶ
 * - 上限超過なら 429 Too Many Requests を返し socket を破棄する
 * - 429 は 401 認証チェックより優先される (シークレット無しでもレート制限は先に効く)
 * - X-Forwarded-For 経由の IP でカウントされる (Cloud Run 前提)
 */
describe('Routes - setupWebSocketRoutes rate limiting', () => {
  const ORIGINAL_SECRET = process.env.TIKTOK_READER_SHARED_SECRET;
  const TEST_SECRET = 'rate-limit-test-secret';
  const authorizedHeaders = { 'x-reader-secret': TEST_SECRET };

  beforeEach(() => {
    process.env.TIKTOK_READER_SHARED_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.TIKTOK_READER_SHARED_SECRET;
    } else {
      process.env.TIKTOK_READER_SHARED_SECRET = ORIGINAL_SECRET;
    }
    setWebSocketRateLimiter(null, true);
  });

  it('allows connections up to the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    setWebSocketRateLimiter(limiter, true);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events', 'localhost:8472', authorizedHeaders),
      mockSocket,
      mockHead
    );
    expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(mockSocket.destroy).not.toHaveBeenCalled();

    const ctx2 = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      ctx2.mockWss,
      ctx2.request('/ws/events', 'localhost:8472', authorizedHeaders),
      ctx2.mockSocket,
      ctx2.mockHead
    );
    expect(ctx2.mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
  });

  it('returns 429 when the same IP exceeds the limit', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    setWebSocketRateLimiter(limiter, true);

    // 1回目: OK
    const first = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      first.mockWss,
      first.request('/ws/events', 'localhost:8472', authorizedHeaders),
      first.mockSocket,
      first.mockHead
    );
    expect(first.mockWss.handleUpgrade).toHaveBeenCalledTimes(1);

    // 2回目: 429
    const second = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      second.mockWss,
      second.request('/ws/events', 'localhost:8472', authorizedHeaders),
      second.mockSocket,
      second.mockHead
    );
    expect(second.mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(second.mockSocket.destroy).toHaveBeenCalledTimes(1);

    const written = second.mockSocket.write.mock.calls[0][0] as string;
    expect(written).toMatch(/^HTTP\/1\.1 429 Too Many Requests\r\n/);
    expect(written).toContain('Content-Type: application/json');
    expect(written).toMatch(/Retry-After: \d+/);
    expect(written).toContain('"error":"Too Many Requests"');
  });

  it('counts each IP independently (X-Forwarded-For)', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    setWebSocketRateLimiter(limiter, true);

    const ipA = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      ipA.mockWss,
      ipA.request('/ws/events', 'localhost:8472', {
        ...authorizedHeaders,
        'x-forwarded-for': '203.0.113.1'
      }),
      ipA.mockSocket,
      ipA.mockHead
    );
    expect(ipA.mockWss.handleUpgrade).toHaveBeenCalledTimes(1);

    // Same IP again should be denied
    const ipAAgain = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      ipAAgain.mockWss,
      ipAAgain.request('/ws/events', 'localhost:8472', {
        ...authorizedHeaders,
        'x-forwarded-for': '203.0.113.1'
      }),
      ipAAgain.mockSocket,
      ipAAgain.mockHead
    );
    expect(ipAAgain.mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(ipAAgain.mockSocket.destroy).toHaveBeenCalledTimes(1);

    // Different IP should be allowed
    const ipB = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      ipB.mockWss,
      ipB.request('/ws/events', 'localhost:8472', {
        ...authorizedHeaders,
        'x-forwarded-for': '203.0.113.99'
      }),
      ipB.mockSocket,
      ipB.mockHead
    );
    expect(ipB.mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
  });

  it('rate limits before running the shared-secret auth check', () => {
    // Regression: if auth ran first, an attacker could probe with wrong secrets
    // and get 401s indistinguishable from 429s. Confirm rate limit fires first.
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    setWebSocketRateLimiter(limiter, true);
    process.env.TIKTOK_READER_SHARED_SECRET = 'top-secret';

    // First request without secret => 401
    const first = createRouteUpgradeTestContext();
    setupWebSocketRoutes(first.mockWss, first.request('/ws/events'), first.mockSocket, first.mockHead);
    expect(first.mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n');

    // Second request from same IP: should be 429, not 401.
    const second = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      second.mockWss,
      second.request('/ws/events', 'localhost:8472', { 'x-reader-secret': 'top-secret' }),
      second.mockSocket,
      second.mockHead
    );
    expect(second.mockWss.handleUpgrade).not.toHaveBeenCalled();
    const written = second.mockSocket.write.mock.calls[0][0] as string;
    expect(written).toMatch(/^HTTP\/1\.1 429 Too Many Requests/);
  });

  it('does not enforce rate limit when limiter is not configured', () => {
    setWebSocketRateLimiter(null, true);

    for (let i = 0; i < 20; i++) {
      const ctx = createRouteUpgradeTestContext();
      setupWebSocketRoutes(
        ctx.mockWss,
        ctx.request('/ws/events', 'localhost:8472', authorizedHeaders),
        ctx.mockSocket,
        ctx.mockHead
      );
      expect(ctx.mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    }
  });

  it('uses socket.remoteAddress when trustProxy=false regardless of X-Forwarded-For', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    setWebSocketRateLimiter(limiter, false);

    // Both requests share the same remoteAddress but different XFF headers.
    // With trustProxy=false, the limiter should ignore XFF and treat them as same IP.
    const first = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      first.mockWss,
      first.request('/ws/events', 'localhost:8472', {
        ...authorizedHeaders,
        'x-forwarded-for': '203.0.113.1'
      }, '10.0.0.5'),
      first.mockSocket,
      first.mockHead
    );
    expect(first.mockWss.handleUpgrade).toHaveBeenCalledTimes(1);

    const second = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      second.mockWss,
      second.request('/ws/events', 'localhost:8472', {
        ...authorizedHeaders,
        'x-forwarded-for': '203.0.113.2'
      }, '10.0.0.5'),
      second.mockSocket,
      second.mockHead
    );
    expect(second.mockWss.handleUpgrade).not.toHaveBeenCalled();
    const written = second.mockSocket.write.mock.calls[0][0] as string;
    expect(written).toMatch(/^HTTP\/1\.1 429/);
  });
});
