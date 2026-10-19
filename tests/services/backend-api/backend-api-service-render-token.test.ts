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

/**
 * Issue #825: cloud render 経路の /ws/events 認証を render token で許可するため、
 * BackendApiService に verifyRenderToken を追加した。
 *
 * 期待動作:
 * - `GET {BACKEND_API_URL}/render/sessions/:session_id/bootstrap` に
 *   `Authorization: Bearer <render_token>` を付けて呼ぶ
 * - 200 かつ `platform === 'tiktok'` なら valid=true
 * - 401/404/5xx / ネットワーク例外 / platform !== 'tiktok' はすべて valid=false (fail-closed)
 * - session_id / render_token が空文字なら backend を呼ばず valid=false
 */
describe('BackendApiService.verifyRenderToken (Issue #825)', () => {
  let service: BackendApiService;

  beforeEach(() => {
    delete process.env.BACKEND_INGRESS_TOKEN;
    // Issue #2782: backend 連携は BACKEND_API_URL を明示したときだけ有効（既定 URL は持たない）。
    process.env.BACKEND_API_URL = 'http://localhost:8471/api/v1';
    delete process.env.BACKEND_RENDER_VERIFY_TIMEOUT_MS;
    service = new BackendApiService();
    jest.clearAllMocks();
  });

  it('platform=tiktok の 200 応答なら valid=true', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { platform: 'tiktok', session_id: 'sess-1' }
    });

    const result = await service.verifyRenderToken('render-token-abc', 'sess-1');

    expect(result).toEqual({ valid: true, platform: 'tiktok' });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://localhost:8471/api/v1/render/sessions/sess-1/bootstrap',
      expect.objectContaining({
        timeout: 3000,
        headers: expect.objectContaining({
          Authorization: 'Bearer render-token-abc'
        })
      })
    );
  });

  it('Issue #2782: bootstrap の live_url を liveUrl として返す（接続を許可する配信者の決定に使う）', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { platform: 'tiktok', live_url: 'https://www.tiktok.com/@streamer/live' }
    });

    const result = await service.verifyRenderToken('render-token-abc', 'sess-1');

    expect(result).toEqual({
      valid: true,
      platform: 'tiktok',
      liveUrl: 'https://www.tiktok.com/@streamer/live'
    });
  });

  it('Issue #2782: BACKEND_API_URL 未設定なら backend を呼ばず valid=false (fail-closed)', async () => {
    delete process.env.BACKEND_API_URL;
    const unconfigured = new BackendApiService();

    const result = await unconfigured.verifyRenderToken('render-token-abc', 'sess-1');

    expect(result).toEqual({ valid: false });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('platform=youtube を返された場合は valid=false (fail-closed)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { platform: 'youtube', session_id: 'sess-1' }
    });

    const result = await service.verifyRenderToken('render-token-abc', 'sess-1');

    expect(result).toEqual({ valid: false, platform: 'youtube' });
  });

  it('401 応答なら valid=false', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 401,
      data: { error: 'unauthorized' }
    });

    const result = await service.verifyRenderToken('bad-token', 'sess-1');

    expect(result.valid).toBe(false);
    // Issue #1823: 例外ではなく「backend 応答」経路で落ちたことを warn のログ形状で検証する。
    expect(loggerMock.warn).toHaveBeenCalledWith('render token 検証失敗（backend 応答）', {
      status: 401,
      session_id: 'sess-1'
    });
  });

  it('ネットワーク例外は valid=false (fail-closed / axios エラー分岐)', async () => {
    const err = Object.assign(new Error('boom'), {
      isAxiosError: true,
      response: undefined,
      code: 'ECONNRESET'
    });
    mockedAxios.get.mockRejectedValueOnce(err);

    const result = await service.verifyRenderToken('render-token', 'sess-1');

    expect(result.valid).toBe(false);
    // Issue #1823: モックではなく実物の isAxiosError による分岐を、ログ形状で検証する。
    expect(loggerMock.error).toHaveBeenCalledWith('render token 検証で backend 呼び出しに失敗:', {
      url: 'http://localhost:8471/api/v1/render/sessions/sess-1/bootstrap',
      status: undefined,
      message: 'boom'
    });
  });

  it('axios 以外の例外は valid=false かつ予期しないエラーとしてログされる', async () => {
    const err = new Error('unexpected');
    mockedAxios.get.mockRejectedValueOnce(err);

    const result = await service.verifyRenderToken('render-token', 'sess-1');

    expect(result.valid).toBe(false);
    // Issue #1823: 実物の isAxiosError が false を返す分岐（生の Error をそのまま渡す）を検証する。
    expect(loggerMock.error).toHaveBeenCalledWith('render token 検証で予期しないエラー:', err);
  });

  it('renderToken が空文字なら backend を呼ばずに valid=false', async () => {
    const result = await service.verifyRenderToken('', 'sess-1');
    expect(result.valid).toBe(false);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('sessionId が空文字なら backend を呼ばずに valid=false', async () => {
    const result = await service.verifyRenderToken('render-token', '');
    expect(result.valid).toBe(false);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('session_id は URL エンコードされる (スラッシュ等の混入から protect)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: { platform: 'tiktok' }
    });

    await service.verifyRenderToken('t', 'sess/with slash');

    const calledUrl = (mockedAxios.get.mock.calls[0][0] as string);
    expect(calledUrl).toBe(
      'http://localhost:8471/api/v1/render/sessions/sess%2Fwith%20slash/bootstrap'
    );
  });

  it('BACKEND_API_URL 環境変数を尊重する', async () => {
    process.env.BACKEND_API_URL = 'https://api.example.com/api/v1';
    const custom = new BackendApiService();
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { platform: 'tiktok' } });

    await custom.verifyRenderToken('t', 'sess-1');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/render/sessions/sess-1/bootstrap',
      expect.any(Object)
    );
  });

  it('BACKEND_RENDER_VERIFY_TIMEOUT_MS で timeout を上書きできる', async () => {
    process.env.BACKEND_RENDER_VERIFY_TIMEOUT_MS = '1500';
    const custom = new BackendApiService();
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { platform: 'tiktok' } });

    await custom.verifyRenderToken('t', 'sess-1');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 1500 })
    );
  });

  it('BACKEND_RENDER_VERIFY_TIMEOUT_MS が不正値ならデフォルト 3000ms', async () => {
    process.env.BACKEND_RENDER_VERIFY_TIMEOUT_MS = 'not-a-number';
    const custom = new BackendApiService();
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { platform: 'tiktok' } });

    await custom.verifyRenderToken('t', 'sess-1');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 3000 })
    );
  });
});

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
});
