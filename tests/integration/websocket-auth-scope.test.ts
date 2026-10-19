import { describe, it, expect, beforeAll, afterAll, jest } from 'bun:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import { setupWebSocketRoutes, handleWebSocketConnection, setConnectionManager, setRenderTokenVerifier, resetRouterContext } from '../../src/routes';

/**
 * Issue #2782 regression: 実際の routes / auth / WebSocketHandler を localhost の実 WebSocket に
 * 接続し、認証した session-A の接続が本文で session-B・別配信者を指定しても
 * ConnectionManager.addClient（上流 TikTok 接続・backend 転送の入口）に届かないことを確認する。
 * verifier は token-A と session-A の組だけを許可するスタブ、ConnectionManager は引数観測用スタブ。
 */
interface ConnectResult {
  message?: { type: string; data: { code: string } };
  closeCode?: number;
}

describe('WebSocket auth scope (Issue #2782)', () => {
  const PORT = 18473;
  let httpServer: HttpServer;
  let wss: WebSocketServer;
  const addClient = jest.fn().mockResolvedValue(undefined);
  const removeClient = jest.fn().mockResolvedValue(undefined);
  const verifyRenderToken = jest.fn(async (token: string, sessionId: string) =>
    token === 'token-A' && sessionId === 'session-A'
      ? { valid: true, platform: 'tiktok', liveUrl: 'https://www.tiktok.com/@synthetic-streamer-a/live' }
      : { valid: false }
  );

  beforeAll(async () => {
    delete process.env.TIKTOK_READER_SHARED_SECRET;
    setConnectionManager({ addClient, removeClient } as never);
    setRenderTokenVerifier({ verifyRenderToken });

    httpServer = createServer();
    wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => setupWebSocketRoutes(wss, request, socket, head));
    wss.on('connection', handleWebSocketConnection);
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  });

  afterAll(async () => {
    resetRouterContext();
    // サーバー側から close した（1008 拒否）接続は、Bun 1.3.14 の node:http 互換層では
    // 切断済みでも server.close() の待機対象に残り、コールバックが返らず hook が 15 秒で
    // タイムアウトする。close 前に closeAllConnections() で残接続を明示的に破棄する。
    await new Promise<void>((resolve) =>
      wss.close(() => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      })
    );
  });

  /** token-A / session-A で upgrade し、connect 本文を送って最初の応答（または close）を返す。 */
  function connectAs(body: Record<string, unknown>): Promise<ConnectResult> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://localhost:${PORT}/ws/events?session_id=session-A`,
        ['ai-liver-render-v1', 'ai-liver-render-token.token-A']
      );
      const result: ConnectResult = {};
      const timeout = setTimeout(() => {
        ws.terminate();
        resolve(result);
      }, 500);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', ...body })));
      ws.on('message', (data) => {
        result.message = JSON.parse(data.toString());
      });
      ws.on('close', (code) => {
        clearTimeout(timeout);
        result.closeCode = code;
        resolve(result);
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  it('認証した session / 配信者と一致する connect は addClient に渡る', async () => {
    addClient.mockClear();
    await connectAs({ liveUrl: 'https://www.tiktok.com/@synthetic-streamer-a/live', sessionId: 'session-A' });

    expect(addClient).toHaveBeenCalledTimes(1);
    expect(addClient.mock.calls[0][0]).toBe('synthetic-streamer-a');
    expect(addClient.mock.calls[0][2]).toBe('session-A');
  });

  it('本文に session-B と別配信者を指定した connect は addClient に届かず拒否される', async () => {
    addClient.mockClear();
    const result = await connectAs({
      liveUrl: 'https://www.tiktok.com/@synthetic-streamer-b/live',
      sessionId: 'session-B'
    });

    expect(addClient).not.toHaveBeenCalled();
    expect(result.message!.type).toBe('error');
    expect(result.message!.data.code).toBe('SESSION_MISMATCH');
    expect(result.closeCode).toBe(1008);
  });

  it('session は一致しても別配信者を指定した connect は addClient に届かず拒否される', async () => {
    addClient.mockClear();
    const result = await connectAs({
      liveUrl: 'https://www.tiktok.com/@synthetic-streamer-b/live',
      sessionId: 'session-A'
    });

    expect(addClient).not.toHaveBeenCalled();
    expect(result.message!.data.code).toBe('STREAMER_NOT_ALLOWED');
    expect(result.closeCode).toBe(1008);
  });
});
