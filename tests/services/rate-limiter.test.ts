import { describe, it, expect } from 'bun:test';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import {
  RateLimiter,
  createRateLimiterFromEnv,
  extractClientIp,
} from '../../src/services/rate-limiter';

/**
 * Issue #589: TikTok 接続レート制限の実装。
 * IP ベースの sliding window レート制限のユニットテスト。
 */

describe('RateLimiter', () => {
  describe('constructor', () => {
    it('rejects non-positive maxRequests', () => {
      expect(() => new RateLimiter({ maxRequests: 0, windowMs: 1000 })).toThrow();
      expect(() => new RateLimiter({ maxRequests: -1, windowMs: 1000 })).toThrow();
      expect(() => new RateLimiter({ maxRequests: NaN, windowMs: 1000 })).toThrow();
    });

    it('rejects non-positive windowMs', () => {
      expect(() => new RateLimiter({ maxRequests: 1, windowMs: 0 })).toThrow();
      expect(() => new RateLimiter({ maxRequests: 1, windowMs: -1 })).toThrow();
      expect(() => new RateLimiter({ maxRequests: 1, windowMs: NaN })).toThrow();
    });
  });

  describe('check()', () => {
    it('allows requests up to maxRequests within window', () => {
      const rl = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
      const now = 1_000_000;

      expect(rl.check('ip-1', now).allowed).toBe(true);
      expect(rl.check('ip-1', now + 1).allowed).toBe(true);
      expect(rl.check('ip-1', now + 2).allowed).toBe(true);

      const denied = rl.check('ip-1', now + 3);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('counts per key independently', () => {
      const rl = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
      const now = 1_000_000;

      expect(rl.check('ip-a', now).allowed).toBe(true);
      expect(rl.check('ip-b', now).allowed).toBe(true);
      expect(rl.check('ip-a', now).allowed).toBe(true);
      expect(rl.check('ip-b', now).allowed).toBe(true);

      // both should now be at limit
      expect(rl.check('ip-a', now).allowed).toBe(false);
      expect(rl.check('ip-b', now).allowed).toBe(false);
    });

    it('does not count denied requests (so recovery works)', () => {
      const rl = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
      const start = 1_000_000;

      expect(rl.check('ip', start).allowed).toBe(true);
      expect(rl.check('ip', start).allowed).toBe(true);
      // burst of denials
      for (let i = 0; i < 100; i++) {
        expect(rl.check('ip', start + i).allowed).toBe(false);
      }
      // once the window slides, the oldest 2 timestamps expire and we should
      // be allowed again — this only works because denied checks were not counted.
      const later = start + 60_001;
      expect(rl.check('ip', later).allowed).toBe(true);
    });

    it('slides the window: old timestamps expire', () => {
      const rl = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
      const t0 = 1_000_000;

      expect(rl.check('ip', t0).allowed).toBe(true);
      expect(rl.check('ip', t0 + 500).allowed).toBe(true);
      expect(rl.check('ip', t0 + 999).allowed).toBe(false);
      // exactly at windowMs later: the first timestamp is now == windowStart,
      // which is exclusive, so it should be considered expired.
      expect(rl.check('ip', t0 + 1000).allowed).toBe(true);
    });

    it('returns retry-after roughly matching when oldest expires', () => {
      const rl = new RateLimiter({ maxRequests: 1, windowMs: 10_000 });
      const t0 = 1_000_000;
      expect(rl.check('ip', t0).allowed).toBe(true);
      const denied = rl.check('ip', t0 + 3000);
      expect(denied.allowed).toBe(false);
      // 7s remaining until oldest (t0) expires => ceil(7000/1000) = 7
      expect(denied.retryAfterSeconds).toBe(7);
    });

    it('treats empty key as unlimited (unknown IP fallback)', () => {
      const rl = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
      for (let i = 0; i < 100; i++) {
        expect(rl.check('', 1_000_000 + i).allowed).toBe(true);
      }
    });
  });

  describe('cleanup()', () => {
    it('removes buckets whose timestamps have all expired', () => {
      const rl = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
      const t0 = 1_000_000;
      rl.check('ip-a', t0);
      rl.check('ip-b', t0);
      expect(rl.size()).toBe(2);

      rl.cleanup(t0 + 2000);
      expect(rl.size()).toBe(0);
    });

    it('keeps buckets whose timestamps are still in window', () => {
      const rl = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
      const t0 = 1_000_000;
      rl.check('ip-a', t0);
      rl.check('ip-b', t0 + 900);
      rl.cleanup(t0 + 1000);
      // ip-a's t0 is now exactly at windowStart (exclusive) => dropped
      // ip-b's t0+900 is within window => kept
      expect(rl.size()).toBe(1);
    });
  });

  describe('startCleanupTimer / stopCleanupTimer', () => {
    it('is idempotent and does not crash', () => {
      const rl = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
      rl.startCleanupTimer();
      rl.startCleanupTimer(); // no-op
      rl.stopCleanupTimer();
      rl.stopCleanupTimer(); // no-op
    });
  });
});

describe('extractClientIp', () => {
  function makeReq(
    headers: Record<string, string | string[]>,
    remoteAddress?: string
  ): IncomingMessage {
    const socket = { remoteAddress } as Socket;
    const req = { headers, socket } as unknown as IncomingMessage;
    return req;
  }

  it('uses the right-most X-Forwarded-For value for direct run.app traffic', () => {
    const req = makeReq(
      { 'x-forwarded-for': '192.0.2.10, 203.0.113.1' },
      '10.0.0.99'
    );
    expect(extractClientIp(req, true)).toBe('203.0.113.1');
  });

  it('skips configured trusted proxy hops from the right', () => {
    const req = makeReq(
      { 'x-forwarded-for': '192.0.2.10, 203.0.113.1, 10.0.0.1' },
      '10.0.0.99'
    );
    expect(extractClientIp(req, true, 1)).toBe('203.0.113.1');
  });

  it('does not trust X-Real-IP when X-Forwarded-For is missing', () => {
    const req = makeReq({ 'x-real-ip': '203.0.113.42' }, '10.0.0.99');
    expect(extractClientIp(req, true)).toBe('10.0.0.99');
  });

  it('falls back to socket.remoteAddress when configured proxy hops exceed the chain', () => {
    const req = makeReq(
      { 'x-forwarded-for': '203.0.113.42' },
      '10.0.0.99'
    );
    expect(extractClientIp(req, true, 2)).toBe('10.0.0.99');
  });

  it('falls back to socket.remoteAddress when trustProxy=true and headers are missing', () => {
    const req = makeReq({}, '198.51.100.7');
    expect(extractClientIp(req, true)).toBe('198.51.100.7');
  });

  it('ignores proxy headers when trustProxy=false', () => {
    const req = makeReq(
      { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
      '10.0.0.99'
    );
    expect(extractClientIp(req, false)).toBe('10.0.0.99');
  });

  it('returns "" if nothing is available (falls into RateLimiter unlimited fallback)', () => {
    const req = makeReq({});
    expect(extractClientIp(req, true)).toBe('');
  });

  it('Issue #2720: does not share a single bucket across clients with no resolvable IP', () => {
    // extractClientIp が 'unknown' のような非空文字列を返すと、socket.remoteAddress も
    // X-Forwarded-For も取得できない複数クライアントが同じキーで RateLimiter.check() を
    // 呼ぶことになり、互いの上限を消費し合ってしまう。'' を返せば RateLimiter.check() の
    // 「空文字列キーは制限しない」フォールバックに乗り、無制限として扱われる。
    const rl = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const now = 1_000_000;
    const req = makeReq({});
    for (let i = 0; i < 10; i++) {
      const clientIp = extractClientIp(req, true);
      expect(rl.check(clientIp, now + i).allowed).toBe(true);
    }
  });
});

describe('createRateLimiterFromEnv', () => {
  it('uses defaults when no env vars are set', () => {
    const cfg = createRateLimiterFromEnv({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.limiter).not.toBeNull();
    expect(cfg.maxRequests).toBe(60);
    expect(cfg.windowMs).toBe(60_000);
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.trustedProxyHops).toBe(0);
    cfg.limiter?.stopCleanupTimer();
  });

  it('honors explicit env values', () => {
    const cfg = createRateLimiterFromEnv({
      TIKTOK_READER_RATE_LIMIT_MAX: '5',
      TIKTOK_READER_RATE_LIMIT_WINDOW_MS: '2000',
      TIKTOK_READER_TRUST_PROXY: 'false',
      TIKTOK_READER_TRUST_PROXY_HOPS: '2',
    });
    expect(cfg.maxRequests).toBe(5);
    expect(cfg.windowMs).toBe(2000);
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.trustedProxyHops).toBe(2);
    cfg.limiter?.stopCleanupTimer();
  });

  it('returns disabled config when TIKTOK_READER_RATE_LIMIT_ENABLED=false', () => {
    const cfg = createRateLimiterFromEnv({
      TIKTOK_READER_RATE_LIMIT_ENABLED: 'false',
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.limiter).toBeNull();
  });

  it('falls back to defaults for invalid values', () => {
    const cfg = createRateLimiterFromEnv({
      TIKTOK_READER_RATE_LIMIT_MAX: 'abc',
      TIKTOK_READER_RATE_LIMIT_WINDOW_MS: '0',
      TIKTOK_READER_TRUST_PROXY_HOPS: '-1',
    });
    expect(cfg.maxRequests).toBe(60);
    expect(cfg.windowMs).toBe(60_000);
    expect(cfg.trustedProxyHops).toBe(0);
    cfg.limiter?.stopCleanupTimer();
  });
});
