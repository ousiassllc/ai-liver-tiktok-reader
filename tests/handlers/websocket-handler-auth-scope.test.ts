import { describe, it, expect } from 'bun:test';
/**
 * Issue #2782 regression tests: upgrade 時に認証した session / 配信者と `connect` 本文が
 * 食い違う接続は、ConnectionManager.addClient（= 上流 TikTok 接続・backend 転送）より前に
 * 拒否されること。
 */
import { createWebSocketHandlerTestContext } from './websocket-handler-test-setup';
import { SessionConflictError } from '../../src/services/connection-limits';

const SCOPE_A = { sessionId: 'session-A', username: 'streamer-a' };

const connect = (liveUrl: string, sessionId?: string) =>
  JSON.stringify({ type: 'connect', liveUrl, sessionId });

describe('WebSocketHandler - Issue #2782 認証 scope との突き合わせ', () => {
  it('認証した session / 配信者と一致する connect は受理して addClient に渡す', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext(SCOPE_A);

    await handler.handleMessage(mockWs, connect('https://www.tiktok.com/@Streamer-A/live', 'session-A'));

    expect(mockConnectionManager.addClient).toHaveBeenCalledWith('streamer-a', mockWs, 'session-A');
    expect(mockWs.close).not.toHaveBeenCalled();
  });

  it('本文の session が認証した session と違う場合は SESSION_MISMATCH で拒否し addClient しない', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext(SCOPE_A);

    await handler.handleMessage(mockWs, connect('https://www.tiktok.com/@streamer-a/live', 'session-B'));

    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe('error');
    expect(sent.data.code).toBe('SESSION_MISMATCH');
    expect(mockWs.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('session 未指定の connect も認証した session とは一致しないため拒否する', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext(SCOPE_A);

    await handler.handleMessage(mockWs, connect('https://www.tiktok.com/@streamer-a/live'));

    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
    expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.code).toBe('SESSION_MISMATCH');
  });

  it('本文の配信者が認証した session の配信者と違う場合は STREAMER_NOT_ALLOWED で拒否し addClient しない', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext(SCOPE_A);

    await handler.handleMessage(mockWs, connect('https://www.tiktok.com/@synthetic-streamer-b/live', 'session-A'));

    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.data.code).toBe('STREAMER_NOT_ALLOWED');
    expect(mockWs.close).toHaveBeenCalledWith(1008, expect.any(String));
  });

  it('接続後に別配信者へ差し替える connect も拒否し、既存の client を外さない', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext(SCOPE_A);
    await handler.handleMessage(mockWs, connect('https://www.tiktok.com/@streamer-a/live', 'session-A'));
    mockConnectionManager.addClient.mockClear();

    await handler.handleMessage(mockWs, connect('https://www.tiktok.com/@synthetic-streamer-b/live', 'session-A'));

    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
    expect(mockConnectionManager.removeClient).not.toHaveBeenCalled();
  });

  it('共有 secret 経路（制限なし scope）は従来どおり任意の session / 配信者に接続できる', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();

    await handler.handleMessage(mockWs, connect('https://www.tiktok.com/@anyone/live', 'any-session'));

    expect(mockConnectionManager.addClient).toHaveBeenCalledWith('anyone', mockWs, 'any-session');
  });

  it('addClient が SessionConflictError を投げたら SESSION_CONFLICT を返して close(1008) する', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext(SCOPE_A);
    mockConnectionManager.addClient.mockRejectedValueOnce(new SessionConflictError());

    await handler.handleMessage(mockWs, connect('https://www.tiktok.com/@streamer-a/live', 'session-A'));

    expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.code).toBe('SESSION_CONFLICT');
    expect(mockWs.close).toHaveBeenCalledWith(1008, expect.any(String));
    // client 登録前に拒否されたため removeClient は呼ばない。
    expect(mockConnectionManager.removeClient).not.toHaveBeenCalled();
  });
});

describe('WebSocketHandler - Issue #2782 connect 本文の検証', () => {
  it('liveUrl が文字列でない / 長すぎる場合は INVALID_URL', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();

    await handler.handleMessage(mockWs, JSON.stringify({ type: 'connect', liveUrl: 123, sessionId: 's' }));
    await handler.handleMessage(mockWs, connect(`https://www.tiktok.com/@${'a'.repeat(600)}/live`, 's'));

    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
    expect(mockWs.send).toHaveBeenCalledTimes(2);
    for (const call of mockWs.send.mock.calls) {
      expect(JSON.parse(call[0]).data.code).toBe('INVALID_URL');
    }
  });

  it('sessionId が文字列でない / 長すぎる場合は INVALID_MESSAGE', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const liveUrl = 'https://www.tiktok.com/@testuser/live';

    await handler.handleMessage(mockWs, JSON.stringify({ type: 'connect', liveUrl, sessionId: { a: 1 } }));
    await handler.handleMessage(mockWs, connect(liveUrl, 's'.repeat(200)));

    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
    for (const call of mockWs.send.mock.calls) {
      expect(JSON.parse(call[0]).data.code).toBe('INVALID_MESSAGE');
    }
  });

  it('JSON が object でない場合は INVALID_MESSAGE', async () => {
    const { handler, mockWs } = createWebSocketHandlerTestContext();

    await handler.handleMessage(mockWs, 'null');

    expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.code).toBe('INVALID_MESSAGE');
  });
});
