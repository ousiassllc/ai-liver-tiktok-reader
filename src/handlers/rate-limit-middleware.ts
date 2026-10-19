import { IncomingMessage, ServerResponse } from 'http';
import {
  RateLimiterConfig,
  extractClientIp,
} from '../services/rate-limiter';
import { logger } from '../utils/logger';

/**
 * Issue #589: HTTP レベルの IP レート制限ミドルウェア。
 *
 * ヘルスチェック系エンドポイントは Cloud Run / kubernetes の probe を
 * 落とさないため制限対象から外す。
 */

const RATE_LIMIT_EXEMPT_PATHS = new Set<string>([
  '/health',
  '/healthz',
  '/ready',
  '/readiness',
]);

export function isRateLimitExempt(url: string | undefined): boolean {
  if (!url) return true;
  // query / fragment を落として path 部分だけで判定
  const path = url.split('?')[0].split('#')[0];
  return RATE_LIMIT_EXEMPT_PATHS.has(path);
}

export function sendRateLimit429(
  res: ServerResponse,
  retryAfterSeconds: number
): void {
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfterSeconds),
  });
  res.end(
    JSON.stringify({
      error: 'Too Many Requests',
      retryAfter: retryAfterSeconds,
    })
  );
}

/**
 * HTTP レート制限を適用する。
 * 429 を返した場合 true、通した場合 false。
 */
export function applyHttpRateLimit(
  req: IncomingMessage,
  res: ServerResponse,
  config: RateLimiterConfig | null
): boolean {
  if (!config || !config.enabled || !config.limiter) return false;
  if (isRateLimitExempt(req.url)) return false;
  const clientIp = extractClientIp(req, config.trustProxy, config.trustedProxyHops);
  const result = config.limiter.check(clientIp);
  if (!result.allowed) {
    logger.warn(
      `HTTP レート制限超過: url=${req.url ?? ''} ip=${clientIp} retryAfter=${result.retryAfterSeconds}s`
    );
    sendRateLimit429(res, result.retryAfterSeconds);
    return true;
  }
  return false;
}
