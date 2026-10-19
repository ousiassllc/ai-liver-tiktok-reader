import { describe, it, expect, beforeEach, afterAll, mock, jest, spyOn } from 'bun:test';
import axios from 'axios';
import { BackendApiService } from '../../../src/services/backend-api-service';
import * as realLoggerNs from '../../../src/utils/logger';

const realLogger = { ...realLoggerNs };

// axios は CJS なので mock.module の factory 戻り値が esModuleInterop の
// default 解決と噛み合わない。src 側と同じインスタンスのメソッドを spyOn で
// 差し替える。
//
// Issue #1823: 差し替えるのは通信を発生させる get / post だけで、
// `axios.isAxiosError` は「実物のまま」にしている。実物は
// `isObject(payload) && payload.isAxiosError === true` で判定するだけなので、
// テストが投げるエラーオブジェクトの形で src 側の分岐が実運用どおりに決まる。
// モックしていた頃は返り値が意図した分岐を選んでいるか読み取れず、さらに bun の
// `jest.clearAllMocks()` が `mockReturnValue` をリセットしないため後続テストへ漏れていた。
const mockedAxios = {
  get: spyOn(axios, 'get'),
  post: spyOn(axios, 'post'),
};

// logger をモック
// Issue #1823: module スコープの const にして、どちらの catch 分岐を通ったかを
// ログの形状で assert できるようにする。
const loggerMock = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
};
mock.module('../../../src/utils/logger', () => ({ logger: loggerMock }));

// Issue #615 の回帰テスト:
// TikTok プラットフォームでのアクティブ視聴者数保存が機能する（従来は POST が
// 全く存在せず active_viewer_count が常に null だった）ことを保証する。
//
// Issue #726 の回帰テスト:
// adminProtected (Cookie 認証) を通せない tiktok-reader からの POST が
// 401 で失敗しないよう、URL を /internal/tiktok-reader/session/{id}/viewer-count に
// 切替し、BACKEND_INGRESS_TOKEN を X-Ingress-Token ヘッダで送ることを担保する。
describe('BackendApiService.sendViewerCount (Issue #615 & #726)', () => {
  let service: BackendApiService;

  beforeEach(() => {
    // Issue #726: token / URL の env をクリアして独立性を担保
    delete process.env.BACKEND_INGRESS_TOKEN;
    // Issue #2782: backend 連携は BACKEND_API_URL を明示したときだけ有効（既定 URL は持たない）。
    process.env.BACKEND_API_URL = 'http://localhost:8471/api/v1';
    service = new BackendApiService();
    jest.clearAllMocks();
  });

  it('should POST count to /internal/tiktok-reader/session/{id}/viewer-count with the configured base URL', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await service.sendViewerCount('sess-abc', 42);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8471/api/v1/internal/tiktok-reader/session/sess-abc/viewer-count',
      { count: 42 },
      expect.objectContaining({
        timeout: 5000,
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    );
  });

  it('should POST null count when viewerCount is unknown', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await service.sendViewerCount('sess-xyz', null);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/internal/tiktok-reader/session/sess-xyz/viewer-count'),
      { count: null },
      expect.any(Object)
    );
  });

  it('should use custom BACKEND_API_URL from env var', async () => {
    process.env.BACKEND_API_URL = 'http://custom-api.example/api/v1';
    const customService = new BackendApiService();
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await customService.sendViewerCount('sess-1', 5);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://custom-api.example/api/v1/internal/tiktok-reader/session/sess-1/viewer-count',
      { count: 5 },
      expect.any(Object)
    );

    delete process.env.BACKEND_API_URL;
  });

  it('should not throw when backend returns an error (fail-open / axios エラー分岐)', async () => {
    const err = { isAxiosError: true, response: { status: 500 }, message: '500' };
    mockedAxios.post.mockRejectedValueOnce(err);

    await expect(service.sendViewerCount('sess-1', 10)).resolves.toBeUndefined();
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    // Issue #1823: モックではなく実物の isAxiosError による分岐を、ログ形状で検証する。
    expect(loggerMock.error).toHaveBeenCalledWith('Backend APIへの視聴者数送信に失敗:', {
      url: 'http://localhost:8471/api/v1/internal/tiktok-reader/session/sess-1/viewer-count',
      status: 500,
      message: '500'
    });
  });

  it('should not throw when a generic network error is raised (非 axios エラー分岐)', async () => {
    const genericError = new Error('boom');
    mockedAxios.post.mockRejectedValueOnce(genericError);

    await expect(service.sendViewerCount('sess-1', 10)).resolves.toBeUndefined();
    // Issue #1823: 実物の isAxiosError が false を返す分岐（生の Error をそのまま渡す）を検証する。
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Backend APIへの視聴者数送信に失敗:',
      genericError
    );
  });

  // Issue #726: X-Ingress-Token ヘッダ付与の担保
  it('should attach X-Ingress-Token header when BACKEND_INGRESS_TOKEN is set (Issue #726)', async () => {
    process.env.BACKEND_INGRESS_TOKEN = 's2s-secret-viewer';
    const tokenService = new BackendApiService();
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await tokenService.sendViewerCount('sess-2', 7);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      { count: 7 },
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Ingress-Token': 's2s-secret-viewer'
        })
      })
    );
  });

  it('should not attach X-Ingress-Token header when BACKEND_INGRESS_TOKEN is unset (Issue #726)', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: {} });

    await service.sendViewerCount('sess-3', 12);

    const call = mockedAxios.post.mock.calls[0];
    const config = call[2] as { headers?: Record<string, string> };
    expect(config.headers).toBeDefined();
    expect(config.headers).not.toHaveProperty('X-Ingress-Token');
  });
});

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
});
