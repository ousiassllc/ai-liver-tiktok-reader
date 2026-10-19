import { describe, it, expect } from 'bun:test';
/**
 * Issue #590 regression tests: WebSocketHandler が ConnectionLimitError を
 * catch してクライアントに CONNECTION_LIMIT_EXCEEDED を返し、close(1013) で
 * 切断すること。
 */
import { createWebSocketHandlerTestContext } from './websocket-handler-test-setup';
import { ConnectionLimitError } from '../../src/services/connection-limits';

describe('WebSocketHandler - Issue #590 connection limit handling', () => {
  it('addClient が ConnectionLimitError(total) を throw した場合、CONNECTION_LIMIT_EXCEEDED を返して close(1013)', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    mockConnectionManager.addClient.mockRejectedValueOnce(
      new ConnectionLimitError('total', 100, 100),
    );

    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123',
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe('error');
    expect(sent.data.code).toBe('CONNECTION_LIMIT_EXCEEDED');
    expect(sent.data.reason).toBe('total');
    // 具体的な内部数値 (100 など) はクライアントに漏らさない仕様。
    expect(sent.data.message).not.toContain('100');

    expect(mockWs.close).toHaveBeenCalledWith(1013, expect.stringContaining('connection limit'));
  });

  it('addClient が ConnectionLimitError(per_user) を throw した場合、reason=per_user が乗る', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    mockConnectionManager.addClient.mockRejectedValueOnce(
      new ConnectionLimitError('per_user', 5, 5),
    );

    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123',
    });

    await handler.handleMessage(mockWs, connectMessage);

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.data.code).toBe('CONNECTION_LIMIT_EXCEEDED');
    expect(sent.data.reason).toBe('per_user');
    expect(mockWs.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  it('ConnectionLimitError 以外のエラーは INTERNAL_ERROR として扱われ close(1013) にはならない', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    mockConnectionManager.addClient.mockRejectedValueOnce(new Error('db down'));

    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123',
    });

    await handler.handleMessage(mockWs, connectMessage);

    // INTERNAL_ERROR パスに落ちる (spec api.md: data: {code, message} ネスト)
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe('error');
    expect(sent.data.code).toBe('INTERNAL_ERROR');
    // 内部エラー詳細 (db down) は漏らさない
    expect(sent.data.message).not.toContain('db down');
    // 上限超過ではないので close(1013) は呼ばれない
    expect(mockWs.close).not.toHaveBeenCalled();
  });

  it('上限拒否後は currentUsername が設定されず、以降の close 処理でも removeClient されない', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    mockConnectionManager.addClient.mockRejectedValueOnce(
      new ConnectionLimitError('total', 1, 1),
    );

    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123',
    });

    await handler.handleMessage(mockWs, connectMessage);
    await handler.handleClose(mockWs);

    // 拒否されたので currentUsername は set されず、removeClient も呼ばれない
    expect(mockConnectionManager.removeClient).not.toHaveBeenCalled();
  });
});
