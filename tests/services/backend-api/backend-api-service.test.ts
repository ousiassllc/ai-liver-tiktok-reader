import { describe, it, expect, beforeEach, afterAll, mock, jest, spyOn } from 'bun:test';
import axios from 'axios';
import { BackendApiService } from '../../../src/services/backend-api-service';
import { GiftApiPayload } from '../../../src/types/api';
import * as realLoggerNs from '../../../src/utils/logger';

const realLogger = { ...realLoggerNs };

// axios は CJS なので mock.module の factory 戻り値が esModuleInterop の
// default 解決と噛み合わない。src 側と同じインスタンスのメソッドを spyOn で
// 差し替える。
//
// Issue #1823: 差し替えるのは通信を発生させる get / post だけで、
// `axios.isAxiosError` は「実物のまま」にしている。実物は
// `isObject(payload) && payload.isAxiosError === true` で判定するだけなので、
// テストが投げるエラーオブジェクトの形（`isAxiosError: true` を持つか否か）で
// src 側の分岐が実運用どおりに決まる。モックしていた頃は
// - 返り値が本当に意図した分岐を選んでいるのか読み取れない
// - bun の `jest.clearAllMocks()` は `mockReturnValue` の実装をリセットしないため
//   一度設定した返り値が同ファイル内の後続テストへ漏れる
// という 2 つの問題があった。
const mockedAxios = {
  get: spyOn(axios, 'get'),
  post: spyOn(axios, 'post'),
};

// loggerをモック
// Issue #1823: module スコープの const にすることで、どちらの catch 分岐を
// 通ったかをログの形状で assert できるようにする。
const loggerMock = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
};
mock.module('../../../src/utils/logger', () => ({ logger: loggerMock }));

describe('BackendApiService', () => {
  let service: BackendApiService;
  const mockGiftData: GiftApiPayload = {
    session_id: 'test-session-123',
    tiktok_user_id: 'testuser',
    user_name: 'Test User',
    gift_type: 'Rose',
    gift_amount: 100,
    gift_count: 5
  };

  beforeEach(() => {
    // Issue #726: 各テスト前に BACKEND_INGRESS_TOKEN を明示解除して独立性を担保する
    delete process.env.BACKEND_INGRESS_TOKEN;
    // Issue #2782: backend 連携は BACKEND_API_URL を明示したときだけ有効（既定 URL は持たない）。
    process.env.BACKEND_API_URL = 'http://localhost:8471/api/v1';
    // 各テスト前にサービスを初期化
    service = new BackendApiService();
    jest.clearAllMocks();
  });

  describe('sendGift', () => {
    it('should send gift data to Backend API successfully', async () => {
      // axios.postの成功レスポンスをモック
      mockedAxios.post.mockResolvedValueOnce({ data: { success: true } });

      await service.sendGift(mockGiftData);

      // 正しいURLとデータで呼び出されたことを確認
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/internal/tiktok-reader/gift'),
        mockGiftData,
        expect.objectContaining({
          timeout: 5000,
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          })
        })
      );
    });

    // Issue #726: adminProtected 401 回避のため URL を /internal/tiktok-reader/gift に切替する
    // ことを担保する。誤って旧 URL (/gift) に戻すと backend の Cookie 認証で 401 になる。
    it('should call /internal/tiktok-reader/gift endpoint (Issue #726)', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: {} });

      await service.sendGift(mockGiftData);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://localhost:8471/api/v1/internal/tiktok-reader/gift',
        expect.any(Object),
        expect.any(Object)
      );
    });

    // Issue #726: BACKEND_INGRESS_TOKEN が設定されている場合、X-Ingress-Token ヘッダを
    // 付与して backend の RequireIngressToken を通す。
    it('should attach X-Ingress-Token header when BACKEND_INGRESS_TOKEN is set (Issue #726)', async () => {
      process.env.BACKEND_INGRESS_TOKEN = 'super-shared-secret';
      const tokenService = new BackendApiService();
      mockedAxios.post.mockResolvedValueOnce({ data: {} });

      await tokenService.sendGift(mockGiftData);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Ingress-Token': 'super-shared-secret'
          })
        })
      );
    });

    // Issue #726: BACKEND_INGRESS_TOKEN 未設定時はヘッダを付けない。
    // backend 側で 401 になるが、テスト実行 (unit) では例外や URL を変えないことを保証する。
    it('should not attach X-Ingress-Token header when BACKEND_INGRESS_TOKEN is unset (Issue #726)', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: {} });

      await service.sendGift(mockGiftData);

      const call = mockedAxios.post.mock.calls[0];
      const config = call[2] as { headers?: Record<string, string> };
      expect(config.headers).toBeDefined();
      expect(config.headers).not.toHaveProperty('X-Ingress-Token');
    });

    it('Issue #2782: BACKEND_API_URL 未設定なら backend へ一切通信しない（既定の localhost へも送らない）', async () => {
      delete process.env.BACKEND_API_URL;
      const unconfigured = new BackendApiService();

      await unconfigured.sendGift(mockGiftData);
      await unconfigured.sendViewerCount('sess-1', 10);
      await unconfigured.sendComment('sess-1', {
        platform: 'tiktok',
        platform_comment_id: 'c1',
        platform_user_id: 'u1',
        username: 'user',
        text: 'hello',
        received_at: '2026-01-01T00:00:00.000Z'
      });

      expect(unconfigured.isConfigured()).toBe(false);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should use custom BACKEND_API_URL from env var', async () => {
      process.env.BACKEND_API_URL = 'http://custom-api.com/api/v1';
      const customService = new BackendApiService();
      mockedAxios.post.mockResolvedValueOnce({ data: {} });

      await customService.sendGift(mockGiftData);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://custom-api.com/api/v1/internal/tiktok-reader/gift',
        expect.any(Object),
        expect.any(Object)
      );

      delete process.env.BACKEND_API_URL;
    });

    it('should handle network errors gracefully (非 axios エラー分岐)', async () => {
      const networkError = new Error('Network Error');
      mockedAxios.post.mockRejectedValueOnce(networkError);

      // エラーでも例外をスローしないことを確認
      await expect(service.sendGift(mockGiftData)).resolves.toBeUndefined();

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      // Issue #1823: 実物の isAxiosError が false を返す分岐（生の Error をそのまま渡す）
      // を通ったことをログ形状で検証する。
      expect(loggerMock.error).toHaveBeenCalledWith(
        'Backend APIへのギフト送信に失敗:',
        networkError
      );
    });

    it('should handle axios errors gracefully (axios エラー分岐)', async () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: 'Internal Server Error' }
        },
        message: 'Request failed with status code 500'
      };

      mockedAxios.post.mockRejectedValueOnce(axiosError);

      await expect(service.sendGift(mockGiftData)).resolves.toBeUndefined();

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      // Issue #1823: モックではなく実物の isAxiosError による分岐を、ログ形状で検証する。
      expect(loggerMock.error).toHaveBeenCalledWith('Backend APIへのギフト送信に失敗:', {
        url: 'http://localhost:8471/api/v1/internal/tiktok-reader/gift',
        status: 500,
        message: 'Request failed with status code 500'
      });
    });

    it('should handle timeout errors (axios エラー分岐 / response なし)', async () => {
      const timeoutError = {
        isAxiosError: true,
        code: 'ECONNABORTED',
        message: 'timeout of 5000ms exceeded'
      };

      mockedAxios.post.mockRejectedValueOnce(timeoutError);

      await expect(service.sendGift(mockGiftData)).resolves.toBeUndefined();

      // Issue #1823: response を持たない axios エラーでも axios 分岐を通り、
      // status は undefined で構造化ログに載る。
      expect(loggerMock.error).toHaveBeenCalledWith('Backend APIへのギフト送信に失敗:', {
        url: 'http://localhost:8471/api/v1/internal/tiktok-reader/gift',
        status: undefined,
        message: 'timeout of 5000ms exceeded'
      });
    });

    it('should set correct timeout', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: {} });

      await service.sendGift(mockGiftData);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          timeout: 5000
        })
      );
    });

    it('should set correct content-type header', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: {} });

      await service.sendGift(mockGiftData);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          })
        })
      );
    });
  });
});

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
});
