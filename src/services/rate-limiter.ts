import { IncomingMessage } from 'http';

/**
 * IP ベースの接続レート制限（sliding window）。
 *
 * Issue #589: docs/content/docs/specifications/tiktok-connector/_index.md:274 で
 * 仕様化されている「クライアントからの接続リクエストのレート制限」の実装。
 *
 * 設計方針:
 * - 依存なし。単一プロセス内のメモリで動作する軽量な sliding window。
 * - HTTP (health/status) と WebSocket upgrade の両方で共有する。
 * - Cloud Run など複数インスタンス構成では各インスタンス独立でカウントする
 *   （分散カウントが必要なら Redis バックエンドに差し替え可能な構造）。
 * - 定期的に古いエントリを GC し、メモリリークを防ぐ。
 */

export interface RateLimiterOptions {
  /** 許可する最大リクエスト数 / ウィンドウ */
  maxRequests: number;
  /** ウィンドウサイズ（ミリ秒） */
  windowMs: number;
  /** GC 間隔（ミリ秒）。未指定なら windowMs と同じ */
  cleanupIntervalMs?: number;
  /** 1 IP あたり保持する最大タイムスタンプ数（DoS 保護）。デフォルト maxRequests * 2 */
  maxTimestampsPerKey?: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  /** 現在のウィンドウ内でのリクエスト数（本リクエストを含む場合は含めた数） */
  count: number;
  /** limit に達している場合、再試行可能になるまでの推奨秒数 */
  retryAfterSeconds: number;
  /** 適用された上限 */
  limit: number;
  /** 残り許容数 */
  remaining: number;
}

/**
 * IP ベース sliding window rate limiter。
 *
 * 実装上のトレードオフ:
 * - 各 IP ごとに直近 N 件のタイムスタンプを配列で保持する。
 *   maxRequests が大きい場合はメモリを消費するため上限を設ける。
 * - タイマーで cleanup する。unref() を呼び event loop をブロックしない。
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly maxTimestampsPerKey: number;
  private readonly buckets: Map<string, number[]> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.maxRequests) || options.maxRequests <= 0) {
      throw new Error('RateLimiter: maxRequests must be a positive number');
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error('RateLimiter: windowMs must be a positive number');
    }
    this.maxRequests = Math.floor(options.maxRequests);
    this.windowMs = Math.floor(options.windowMs);
    this.cleanupIntervalMs =
      options.cleanupIntervalMs && options.cleanupIntervalMs > 0
        ? Math.floor(options.cleanupIntervalMs)
        : this.windowMs;
    this.maxTimestampsPerKey =
      options.maxTimestampsPerKey && options.maxTimestampsPerKey > 0
        ? Math.floor(options.maxTimestampsPerKey)
        : Math.max(this.maxRequests * 2, this.maxRequests + 1);
  }

  /**
   * リクエストを 1 件計上し、上限内かどうか判定する。
   *
   * allowed=false のときはカウントに含めない (429 を返して弾く用途のため)。
   */
  check(key: string, now: number = Date.now()): RateLimitCheckResult {
    if (!key) {
      // key を特定できない場合は制限しない（呼び出し側で fallback したケース）
      return {
        allowed: true,
        count: 0,
        retryAfterSeconds: 0,
        limit: this.maxRequests,
        remaining: this.maxRequests,
      };
    }

    const timestamps = this.buckets.get(key) ?? [];
    const windowStart = now - this.windowMs;

    // ウィンドウ外のタイムスタンプを捨てる
    let firstInWindow = 0;
    while (firstInWindow < timestamps.length && timestamps[firstInWindow] <= windowStart) {
      firstInWindow++;
    }
    const activeTimestamps =
      firstInWindow > 0 ? timestamps.slice(firstInWindow) : timestamps;

    if (activeTimestamps.length >= this.maxRequests) {
      // 上限超過。カウントには含めない。
      const oldest = activeTimestamps[0];
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now);
      // 書き戻しておく（切り詰め版）
      this.buckets.set(key, activeTimestamps);
      return {
        allowed: false,
        count: activeTimestamps.length,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        limit: this.maxRequests,
        remaining: 0,
      };
    }

    // 上限内。今回分を追加して書き戻す。
    activeTimestamps.push(now);
    // DoS 保護: 万一 maxTimestampsPerKey を超えたら古いものを捨てる
    if (activeTimestamps.length > this.maxTimestampsPerKey) {
      activeTimestamps.splice(0, activeTimestamps.length - this.maxTimestampsPerKey);
    }
    this.buckets.set(key, activeTimestamps);

    return {
      allowed: true,
      count: activeTimestamps.length,
      retryAfterSeconds: 0,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - activeTimestamps.length),
    };
  }

  /**
   * ウィンドウ外のエントリを一括削除する。
   * 定期実行することで長時間動作時のメモリ肥大を防ぐ。
   */
  cleanup(now: number = Date.now()): void {
    const windowStart = now - this.windowMs;
    for (const [key, timestamps] of this.buckets) {
      const kept: number[] = [];
      for (const ts of timestamps) {
        if (ts > windowStart) kept.push(ts);
      }
      if (kept.length === 0) {
        this.buckets.delete(key);
      } else if (kept.length !== timestamps.length) {
        this.buckets.set(key, kept);
      }
    }
  }

  /**
   * 定期 GC を開始する。すでに開始済みなら何もしない。
   */
  startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      try {
        this.cleanup();
      } catch {
        // cleanup 失敗は握りつぶす（レート制限本体には影響させない）
      }
    }, this.cleanupIntervalMs);
    // Node.js: event loop をブロックしないよう unref
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * 定期 GC を停止する（テスト・シャットダウン用）。
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** テスト用: 現在保持しているキー数を返す */
  size(): number {
    return this.buckets.size;
  }

  /** テスト用: 全カウンタをリセットする */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * IncomingMessage から client IP を抽出する。
 *
 * - trustProxy=true のとき、X-Forwarded-For を右端から解決する。
 *   クライアントが注入できる左端を信頼するとレート制限を回避できるため、
 *   trustedProxyHops 個の既知proxyを末尾から除いたIPを使う。
 *   run.app直結は0、前段に外部LBが1段ある場合は1を指定する。
 * - false のとき socket.remoteAddress を採用する
 * - どちらも取れない場合は空文字列を返す（RateLimiter.check() は空文字列キーを
 *   「特定不能」として上限なしで通すため、結果的に呼び出し側で制限対象外になる）
 */
export function extractClientIp(
  req: IncomingMessage,
  trustProxy: boolean,
  trustedProxyHops = 0
): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const xffValue = Array.isArray(xff) ? xff[0] : xff;
    if (xffValue) {
      const forwardedFor = xffValue
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const clientIndex = forwardedFor.length - 1 - trustedProxyHops;
      if (clientIndex >= 0) {
        const clientIp = forwardedFor[clientIndex];
        if (clientIp) return clientIp;
      }
    }
  }
  const remote = req.socket?.remoteAddress;
  if (remote) return remote;
  return '';
}

/**
 * 環境変数から RateLimiter を組み立てる。
 *
 * - TIKTOK_READER_RATE_LIMIT_ENABLED: "false" で無効化（default: true）
 * - TIKTOK_READER_RATE_LIMIT_MAX: 最大リクエスト/ウィンドウ（default: 60）
 * - TIKTOK_READER_RATE_LIMIT_WINDOW_MS: ウィンドウ幅ミリ秒（default: 60000）
 * - TIKTOK_READER_TRUST_PROXY: "true" で X-Forwarded-For を採用（default: true, Cloud Run 想定）
 * - TIKTOK_READER_TRUST_PROXY_HOPS: X-Forwarded-For末尾の既知proxy数（default: 0, run.app直結）
 *
 * enabled=false のときは null を返し、呼び出し側で「制限なし」として扱う。
 */
export interface RateLimiterConfig {
  enabled: boolean;
  limiter: RateLimiter | null;
  trustProxy: boolean;
  trustedProxyHops: number;
  maxRequests: number;
  windowMs: number;
}

export function createRateLimiterFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RateLimiterConfig {
  const enabledRaw = env.TIKTOK_READER_RATE_LIMIT_ENABLED;
  const enabled = enabledRaw === undefined ? true : enabledRaw.toLowerCase() !== 'false';

  const trustProxyRaw = env.TIKTOK_READER_TRUST_PROXY;
  const trustProxy = trustProxyRaw === undefined ? true : trustProxyRaw.toLowerCase() !== 'false';

  const trustedProxyHopsParsed = Number(env.TIKTOK_READER_TRUST_PROXY_HOPS ?? '');
  const trustedProxyHops =
    Number.isInteger(trustedProxyHopsParsed) && trustedProxyHopsParsed >= 0
      ? trustedProxyHopsParsed
      : 0;

  const maxParsed = parseInt(env.TIKTOK_READER_RATE_LIMIT_MAX ?? '', 10);
  const maxRequests = Number.isFinite(maxParsed) && maxParsed > 0 ? maxParsed : 60;

  const windowParsed = parseInt(env.TIKTOK_READER_RATE_LIMIT_WINDOW_MS ?? '', 10);
  const windowMs = Number.isFinite(windowParsed) && windowParsed > 0 ? windowParsed : 60_000;

  if (!enabled) {
    return { enabled: false, limiter: null, trustProxy, trustedProxyHops, maxRequests, windowMs };
  }

  const limiter = new RateLimiter({ maxRequests, windowMs });
  return { enabled: true, limiter, trustProxy, trustedProxyHops, maxRequests, windowMs };
}
