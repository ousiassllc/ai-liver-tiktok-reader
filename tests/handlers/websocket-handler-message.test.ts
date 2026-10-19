import { describe, it, expect } from 'bun:test';
import { createWebSocketHandlerTestContext } from './websocket-handler-test-setup';

describe('WebSocketHandler - handleMessage', () => {
  it('should handle connect message with valid TikTok URL', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockConnectionManager.addClient).toHaveBeenCalledWith(
      'testuser',
      mockWs,
      'session-123'
    );
  });

  it('should extract username from standard TikTok URL', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@johndoe/live',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockConnectionManager.addClient).toHaveBeenCalledWith(
      'johndoe',
      mockWs,
      'session-123'
    );
  });

  it('should send error for invalid URL without username', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/live',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('INVALID_URL'));

    // spec api.md: error メッセージは data: { code, message } のネスト形式
    const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentMessage.type).toBe('error');
    expect(sentMessage).not.toHaveProperty('code');
    expect(sentMessage).not.toHaveProperty('message');
    expect(sentMessage.data.code).toBe('INVALID_URL');
    expect(sentMessage.data.message).toBe('不正なTikTok Live URL');
    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
  });

  it('should send error for completely invalid URL', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'http://example.com/no-username',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('INVALID_URL'));
    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
  });

  it('should send error for empty URL', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: '',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('INVALID_URL'));
    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
  });

  it('should remove old client before adding new one when username changes', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const firstMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@user1/live',
      sessionId: 'session-1'
    });

    await handler.handleMessage(mockWs, firstMessage);

    const secondMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@user2/live',
      sessionId: 'session-2'
    });

    await handler.handleMessage(mockWs, secondMessage);

    expect(mockConnectionManager.removeClient).toHaveBeenCalledWith('user1', mockWs);
    expect(mockConnectionManager.addClient).toHaveBeenCalledTimes(2);
  });

  it('should handle invalid JSON gracefully', async () => {
    const { handler, mockWs } = createWebSocketHandlerTestContext();

    await handler.handleMessage(mockWs, 'not a valid json');

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('INVALID_MESSAGE'));

    // spec api.md: error メッセージは data: { code, message } のネスト形式
    const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentMessage.type).toBe('error');
    expect(sentMessage).not.toHaveProperty('code');
    expect(sentMessage.data.code).toBe('INVALID_MESSAGE');
  });

  it('should handle ConnectionManager.addClient throwing error', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    mockConnectionManager.addClient.mockRejectedValue(new Error('Connection failed'));

    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('INTERNAL_ERROR'));
  });

  // refine-sweep iter-5 backend MAJOR:
  // 内部エラー詳細をそのままクライアントへ返してしまうと、DB スキーマや依存
  // ライブラリのバージョン、ファイルパスなど内部実装が漏洩する。旧実装は
  // `error.message` を素通ししていたため、任意のスタックトレースメッセージを
  // クライアントで観測できてしまう回帰があった。message は汎用文言に丸め、
  // 詳細は logger のみに残す挙動を保証する。
  it('should not leak internal error message details to client', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const secretInternal = 'sensitive-internal-detail: db conn refused at 10.0.0.1:5432';
    mockConnectionManager.addClient.mockRejectedValue(new Error(secretInternal));

    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('INTERNAL_ERROR'));
    const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentMessage.data.code).toBe('INTERNAL_ERROR');
    // 内部エラー文言はクライアントに露出しないこと。
    expect(sentMessage.data.message).not.toContain('sensitive-internal-detail');
    expect(sentMessage.data.message).not.toContain('10.0.0.1');
    expect(sentMessage.data.message).toBe('internal error');
  });

  it('should handle @username format', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: '@username123',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockConnectionManager.addClient).toHaveBeenCalledWith(
      'username123',
      mockWs,
      'session-123'
    );
  });

  it('should handle plain username format', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'plainusername',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockConnectionManager.addClient).toHaveBeenCalledWith(
      'plainusername',
      mockWs,
      'session-123'
    );
  });
});
