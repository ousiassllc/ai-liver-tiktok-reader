import { describe, it, expect, mock, jest, afterAll } from 'bun:test';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import * as realLoggerNs from '../../src/utils/logger';

const realLogger = { ...realLoggerNs };

mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  applyHttpRateLimit,
  isRateLimitExempt,
} from '../../src/handlers/rate-limit-middleware';
import {
  RateLimiter,
  RateLimiterConfig,
} from '../../src/services/rate-limiter';

/**
 * Issue #589: HTTP レート制限ミドルウェアのテスト。
 */

function makeReq(
  url: string,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1'
): IncomingMessage {
  const socket = { remoteAddress } as Socket;
  return { url, headers, socket } as unknown as IncomingMessage;
}

function makeRes(): {
  res: ServerResponse;
  writeHead: jest.Mock;
  end: jest.Mock;
} {
  const writeHead = jest.fn();
  const end = jest.fn();
  const res = { writeHead, end } as unknown as ServerResponse;
  return { res, writeHead, end };
}

function makeConfig(
  overrides: Partial<RateLimiterConfig> & { limiter: RateLimiter | null }
): RateLimiterConfig {
  return {
    enabled: true,
    trustProxy: overrides.trustProxy ?? true,
    trustedProxyHops: overrides.trustedProxyHops ?? 0,
    maxRequests: overrides.maxRequests ?? 60,
    windowMs: overrides.windowMs ?? 60_000,
    ...overrides,
  };
}

describe('isRateLimitExempt', () => {
  it.each([
    ['/health', true],
    ['/healthz', true],
    ['/ready', true],
    ['/readiness', true],
    ['/status', false],
    ['/ws/events', false],
    ['/anything', false],
  ])('%s -> %s', (url, expected) => {
    expect(isRateLimitExempt(url)).toBe(expected);
  });

  it('strips query and fragment before matching', () => {
    expect(isRateLimitExempt('/health?probe=1')).toBe(true);
    expect(isRateLimitExempt('/ready#anchor')).toBe(true);
  });

  it('treats undefined URL as exempt (safest)', () => {
    expect(isRateLimitExempt(undefined)).toBe(true);
  });
});

describe('applyHttpRateLimit', () => {
  it('no-ops when config is null', () => {
    const { res, writeHead, end } = makeRes();
    const req = makeReq('/status');
    expect(applyHttpRateLimit(req, res, null)).toBe(false);
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it('no-ops when limiter is disabled', () => {
    const { res, writeHead } = makeRes();
    const req = makeReq('/status');
    expect(
      applyHttpRateLimit(
        req,
        res,
        makeConfig({ enabled: false, limiter: null })
      )
    ).toBe(false);
    expect(writeHead).not.toHaveBeenCalled();
  });

  it('does not rate-limit /health even under pressure', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const cfg = makeConfig({ limiter });
    for (let i = 0; i < 20; i++) {
      const { res, writeHead } = makeRes();
      const req = makeReq('/health');
      expect(applyHttpRateLimit(req, res, cfg)).toBe(false);
      expect(writeHead).not.toHaveBeenCalled();
    }
  });

  it('returns 429 with Retry-After header when limit exceeded', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const cfg = makeConfig({ limiter });

    // 1回目: 通す
    const ok = makeRes();
    expect(
      applyHttpRateLimit(makeReq('/status'), ok.res, cfg)
    ).toBe(false);
    expect(ok.writeHead).not.toHaveBeenCalled();

    // 2回目: 429
    const denied = makeRes();
    expect(
      applyHttpRateLimit(makeReq('/status'), denied.res, cfg)
    ).toBe(true);
    expect(denied.writeHead).toHaveBeenCalledTimes(1);
    const [statusCode, headers] = denied.writeHead.mock.calls[0];
    expect(statusCode).toBe(429);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Retry-After']).toMatch(/^\d+$/);

    expect(denied.end).toHaveBeenCalledTimes(1);
    const body = JSON.parse(denied.end.mock.calls[0][0] as string);
    expect(body).toEqual({
      error: 'Too Many Requests',
      retryAfter: expect.any(Number),
    });
  });

  it('separates counters per client IP via X-Forwarded-For (trustProxy=true)', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const cfg = makeConfig({ limiter, trustProxy: true });

    const ipA1 = makeRes();
    expect(
      applyHttpRateLimit(
        makeReq('/status', { 'x-forwarded-for': '203.0.113.1' }),
        ipA1.res,
        cfg
      )
    ).toBe(false);

    const ipA2 = makeRes();
    expect(
      applyHttpRateLimit(
        makeReq('/status', { 'x-forwarded-for': '203.0.113.1' }),
        ipA2.res,
        cfg
      )
    ).toBe(true);
    expect(ipA2.writeHead).toHaveBeenCalledWith(429, expect.any(Object));

    // Different IP is unaffected
    const ipB = makeRes();
    expect(
      applyHttpRateLimit(
        makeReq('/status', { 'x-forwarded-for': '203.0.113.99' }),
        ipB.res,
        cfg
      )
    ).toBe(false);
    expect(ipB.writeHead).not.toHaveBeenCalled();
  });

  it('does not let a spoofed X-Forwarded-For prefix create a new bucket', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const cfg = makeConfig({ limiter, trustProxy: true, trustedProxyHops: 0 });

    const first = makeRes();
    expect(
      applyHttpRateLimit(
        makeReq('/status', { 'x-forwarded-for': '192.0.2.1, 203.0.113.50' }),
        first.res,
        cfg
      )
    ).toBe(false);

    const second = makeRes();
    expect(
      applyHttpRateLimit(
        makeReq('/status', { 'x-forwarded-for': '192.0.2.2, 203.0.113.50' }),
        second.res,
        cfg
      )
    ).toBe(true);
  });

  it('ignores X-Forwarded-For when trustProxy=false', () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const cfg = makeConfig({ limiter, trustProxy: false });

    // Same remoteAddress, different XFF headers. trustProxy=false => same bucket.
    const first = makeRes();
    expect(
      applyHttpRateLimit(
        makeReq('/status', { 'x-forwarded-for': '1.1.1.1' }, '10.0.0.5'),
        first.res,
        cfg
      )
    ).toBe(false);

    const second = makeRes();
    expect(
      applyHttpRateLimit(
        makeReq('/status', { 'x-forwarded-for': '2.2.2.2' }, '10.0.0.5'),
        second.res,
        cfg
      )
    ).toBe(true);
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
});
