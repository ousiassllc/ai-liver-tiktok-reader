import { describe, it, expect, beforeEach, afterAll, mock, jest, spyOn } from 'bun:test';
import axios from 'axios';
import { BackendApiService } from '../../../src/services/backend-api-service';
import { CommentApiPayload } from '../../../src/types/api';
import * as realLoggerNs from '../../../src/utils/logger';

const realLogger = { ...realLoggerNs };

// axios は CJS なので mock.module の factory 戻り値が esModuleInterop の
// default 解決と噛み合わない。src 側と同じインスタンスのメソッドを spyOn で
// 差し替える（backend-api-service.test.ts / -viewer-count.test.ts と同じ方針）。
//
// Issue #1823: 差し替えるのは通信を発生させる get / post だけで、
// `axios.isAxiosError` は「実物のまま」にして src 側の分岐が実運用どおりに決まるようにする。
const mockedAxios = {
  get: spyOn(axios, 'get'),
  post: spyOn(axios, 'post'),
};

const loggerMock = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
};
mock.module('../../../src/utils/logger', () => ({ logger: loggerMock }));

// Issue #2154 の回帰テスト:
// TikTok のコメントは tiktok-reader 内でしか受信できず、従来は WebSocket 配信のみで
// backend に一切届いていなかったため、MCP の pick_ai_comments が読む session_comments が
// TikTok 配信では常に空だった。POST /internal/tiktok-reader/session/{id}/comment への
// 転送が正しい URL / ヘッダ / body で行われ、かつ失敗時も throw しないことを担保する。
describe('BackendApiService.sendComment (Issue #2154)', () => {
  let service: BackendApiService;
  const mockCommentPayload: CommentApiPayload = {
    platform: 'tiktok',
    platform_comment_id: 'msg123',
    platform_user_id: 'user123',
    username: 'Test User',
    text: 'Hello World!',
    received_at: '2026-09-08T12:34:56.000Z'
  };

  beforeEach(() => {
    // token / URL の env をクリアして独立性を担保する
    delete process.env.BACKEND_INGRESS_TOKEN;
    // Issue #2782: backend 連携は BACKEND_API_URL を明示したときだけ有効（既定 URL は持たない）。
    process.env.BACKEND_API_URL = 'http://localhost:8471/api/v1';
    service = new BackendApiService();
    jest.clearAllMocks();
  });

  it('should POST the comment to /internal/tiktok-reader/session/{id}/comment with the configured base URL', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await service.sendComment('sess-abc', mockCommentPayload);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8471/api/v1/internal/tiktok-reader/session/sess-abc/comment',
      mockCommentPayload,
      expect.objectContaining({
        timeout: 5000,
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    );
  });

  it('should use custom BACKEND_API_URL from env var', async () => {
    process.env.BACKEND_API_URL = 'http://custom-api.example/api/v1';
    const customService = new BackendApiService();
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await customService.sendComment('sess-1', mockCommentPayload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://custom-api.example/api/v1/internal/tiktok-reader/session/sess-1/comment',
      mockCommentPayload,
      expect.any(Object)
    );

    delete process.env.BACKEND_API_URL;
  });

  // sessionId は WebSocket 接続時のクエリ由来なのでパス区切りを含み得る。
  // verifyRenderToken と同じく encodeURIComponent でエスケープし、URL パスを
  // 乗っ取られないことを担保する。
  it('should percent-encode the session id in the URL path', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await service.sendComment('sess/../evil', mockCommentPayload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8471/api/v1/internal/tiktok-reader/session/sess%2F..%2Fevil/comment',
      mockCommentPayload,
      expect.any(Object)
    );
  });

  // Issue #726 と同じ service-to-service 認証を使う。gift / viewer-count と同一の
  // BACKEND_INGRESS_TOKEN を再利用し、新しい env は追加しない。
  it('should attach X-Ingress-Token header when BACKEND_INGRESS_TOKEN is set', async () => {
    process.env.BACKEND_INGRESS_TOKEN = 's2s-secret-comment';
    const tokenService = new BackendApiService();
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await tokenService.sendComment('sess-2', mockCommentPayload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      mockCommentPayload,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Ingress-Token': 's2s-secret-comment'
        })
      })
    );
  });

  it('should not attach X-Ingress-Token header when BACKEND_INGRESS_TOKEN is unset', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await service.sendComment('sess-3', mockCommentPayload);

    const call = mockedAxios.post.mock.calls[0];
    const config = call[2] as { headers?: Record<string, string> };
    expect(config.headers).toBeDefined();
    expect(config.headers).not.toHaveProperty('X-Ingress-Token');
  });

  it('should not log the raw username (PII) on success', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await service.sendComment('sess-4', mockCommentPayload);

    const infoCall = loggerMock.info.mock.calls.find(
      call => call[0] === 'コメントをBackend APIに送信しました'
    );
    expect(infoCall).toBeDefined();
    expect(JSON.stringify(infoCall![1])).not.toContain('Test User');
    expect(infoCall![1]).toEqual({
      session_id: 'sess-4',
      platform_comment_id: 'msg123',
      text_len: 'Hello World!'.length
    });
  });

  it('should not throw when backend returns an error (fail-open / axios エラー分岐)', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: '500' };
    mockedAxios.post.mockRejectedValueOnce(err);

    await expect(service.sendComment('sess-1', mockCommentPayload)).resolves.toBeUndefined();
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    // Issue #1823: 実物の isAxiosError による分岐を、ログ形状で検証する。
    expect(loggerMock.error).toHaveBeenCalledWith('Backend APIへのコメント送信に失敗:', {
      url: 'http://localhost:8471/api/v1/internal/tiktok-reader/session/sess-1/comment',
      status: 500,
      message: '500'
    });
  });

  it('should not throw when a generic network error is raised (非 axios エラー分岐)', async () => {
    const genericError = new Error('boom');
    mockedAxios.post.mockRejectedValueOnce(genericError);

    await expect(service.sendComment('sess-1', mockCommentPayload)).resolves.toBeUndefined();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Backend APIへのコメント送信に失敗:',
      genericError
    );
  });

  it('should not throw on timeout (axios エラー分岐 / response なし)', async () => {
    const timeoutError = {
      isAxiosError: true,
      code: 'ECONNABORTED',
      message: 'timeout of 5000ms exceeded'
    };
    mockedAxios.post.mockRejectedValueOnce(timeoutError);

    await expect(service.sendComment('sess-1', mockCommentPayload)).resolves.toBeUndefined();
    expect(loggerMock.error).toHaveBeenCalledWith('Backend APIへのコメント送信に失敗:', {
      url: 'http://localhost:8471/api/v1/internal/tiktok-reader/session/sess-1/comment',
      status: undefined,
      message: 'timeout of 5000ms exceeded'
    });
  });
});

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
});
