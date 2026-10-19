import { describe, it, expect, afterEach, jest } from 'bun:test';
import {
  createRouteUpgradeTestContext,
  setupWebSocketRoutes,
  setRenderTokenVerifier
} from './routes-test-setup';

/**
 * Issue #825: prod で TIKTOK_READER_SHARED_SECRET を設定した瞬間、cloud streaming の
 * render page (public バンドル。shared secret を埋め込めない) が /ws/events に接続できず
 * 401 で即切断されるバグの回帰テスト。
 *
 * 期待動作:
 * - shared secret が未提示でも、Sec-WebSocket-Protocol に render token が乗り、
 *   ?session_id= 付きで来た場合は backend の render_token 検証で許可される
 * - backend が invalid を返した場合は 401
 * - session_id または token が欠けている場合は 401
 * - render token 経路は shared secret 経路と共存する（優先度は shared secret）
 */
describe('Routes - setupWebSocketRoutes render token auth (Issue #825)', () => {
  const ORIGINAL_SECRET = process.env.TIKTOK_READER_SHARED_SECRET;

  const makeVerifier = (result: { valid: boolean; platform?: string; liveUrl?: string }) => ({
    verifyRenderToken: jest.fn().mockResolvedValue(result)
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.TIKTOK_READER_SHARED_SECRET;
    } else {
      process.env.TIKTOK_READER_SHARED_SECRET = ORIGINAL_SECRET;
    }
    setRenderTokenVerifier(null);
  });

  // 非同期経路をテストするため一度 microtask を回してから assert する。
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('shared secret が設定済みでも、有効な render token subprotocol + session_id で許可される', async () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'admin-secret';
    const verifier = makeVerifier({
      valid: true,
      platform: 'tiktok',
      liveUrl: 'https://www.tiktok.com/@Streamer-A/live'
    });
    setRenderTokenVerifier(verifier);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    const mockRequest = request('/ws/events?session_id=sess-1', 'localhost:8472', {
      'sec-websocket-protocol':
        'ai-liver-render-v1, ai-liver-render-token.render-token-abc'
    });
    setupWebSocketRoutes(mockWss, mockRequest, mockSocket, mockHead);

    await flush();

    expect(verifier.verifyRenderToken).toHaveBeenCalledWith(
      'render-token-abc',
      'sess-1'
    );
    expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(mockSocket.destroy).not.toHaveBeenCalled();

    // Issue #2782: 認証した session と bootstrap の live_url から決まる配信者を接続へ引き継ぐ。
    const callback = mockWss.handleUpgrade.mock.calls[0][3];
    const mockWs = {} as never;
    callback(mockWs);
    expect(mockWss.emit).toHaveBeenCalledWith('connection', mockWs, mockRequest, {
      sessionId: 'sess-1',
      username: 'streamer-a'
    });
  });

  it('Issue #2782: bootstrap に live_url が無い render token は許可する配信者を決められず 401 になる', async () => {
    const verifier = makeVerifier({ valid: true, platform: 'tiktok' });
    setRenderTokenVerifier(verifier);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events?session_id=sess-1', 'localhost:8472', {
        'sec-websocket-protocol':
          'ai-liver-render-v1, ai-liver-render-token.render-token-abc'
      }),
      mockSocket,
      mockHead
    );

    await flush();

    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n');
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it('render token 検証が invalid の場合は 401 で切断する', async () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'admin-secret';
    const verifier = makeVerifier({ valid: false });
    setRenderTokenVerifier(verifier);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events?session_id=sess-1', 'localhost:8472', {
        'sec-websocket-protocol':
          'ai-liver-render-v1, ai-liver-render-token.bad-token'
      }),
      mockSocket,
      mockHead
    );

    await flush();

    expect(verifier.verifyRenderToken).toHaveBeenCalled();
    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.write).toHaveBeenCalledWith(
      'HTTP/1.1 401 Unauthorized\r\n\r\n'
    );
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('session_id クエリが欠けている場合は backend を呼ばず 401', async () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'admin-secret';
    const verifier = makeVerifier({ valid: true, platform: 'tiktok' });
    setRenderTokenVerifier(verifier);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events', 'localhost:8472', {
        'sec-websocket-protocol':
          'ai-liver-render-v1, ai-liver-render-token.render-token-abc'
      }),
      mockSocket,
      mockHead
    );

    await flush();

    expect(verifier.verifyRenderToken).not.toHaveBeenCalled();
    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('render token subprotocol が欠けている場合は backend を呼ばず 401', async () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'admin-secret';
    const verifier = makeVerifier({ valid: true, platform: 'tiktok' });
    setRenderTokenVerifier(verifier);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events?session_id=sess-1', 'localhost:8472', {
        'sec-websocket-protocol': 'ai-liver-render-v1'
      }),
      mockSocket,
      mockHead
    );

    await flush();

    expect(verifier.verifyRenderToken).not.toHaveBeenCalled();
    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('shared secret が正しく提示されている場合は backend を呼ばずに同期で許可（既存経路の互換）', async () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'admin-secret';
    const verifier = makeVerifier({ valid: false });
    setRenderTokenVerifier(verifier);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events', 'localhost:8472', {
        'x-reader-secret': 'admin-secret'
      }),
      mockSocket,
      mockHead
    );

    // 同期で handleUpgrade が呼ばれること (backend 検証を待たない)
    expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);

    await flush();
    expect(verifier.verifyRenderToken).not.toHaveBeenCalled();
  });

  it('render token verifier が未設定の環境（dev）では、shared secret NG は即 401', async () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'admin-secret';
    setRenderTokenVerifier(null);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events?session_id=sess-1', 'localhost:8472', {
        'sec-websocket-protocol':
          'ai-liver-render-v1, ai-liver-render-token.some-token'
      }),
      mockSocket,
      mockHead
    );

    // 同期で 401 が返る
    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.write).toHaveBeenCalledWith(
      'HTTP/1.1 401 Unauthorized\r\n\r\n'
    );
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('verifyRenderToken が例外を投げても fail-closed で 401 になる', async () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'admin-secret';
    const verifier = {
      verifyRenderToken: jest.fn().mockRejectedValue(new Error('network down'))
    };
    setRenderTokenVerifier(verifier);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events?session_id=sess-1', 'localhost:8472', {
        'sec-websocket-protocol':
          'ai-liver-render-v1, ai-liver-render-token.render-token-abc'
      }),
      mockSocket,
      mockHead
    );

    await flush();

    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.write).toHaveBeenCalledWith(
      'HTTP/1.1 401 Unauthorized\r\n\r\n'
    );
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('backend が platform!="tiktok" を返した場合は 401 (verifier 内で扱われる想定の防御)', async () => {
    // BackendApiService は platform !== 'tiktok' の時 valid=false を返す。
    // ここでは verifier がその判断を実装しているとして valid=false で挙動を確認する。
    process.env.TIKTOK_READER_SHARED_SECRET = 'admin-secret';
    const verifier = makeVerifier({ valid: false, platform: 'youtube' });
    setRenderTokenVerifier(verifier);

    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
    setupWebSocketRoutes(
      mockWss,
      request('/ws/events?session_id=sess-1', 'localhost:8472', {
        'sec-websocket-protocol':
          'ai-liver-render-v1, ai-liver-render-token.render-token-abc'
      }),
      mockSocket,
      mockHead
    );

    await flush();

    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });
});
