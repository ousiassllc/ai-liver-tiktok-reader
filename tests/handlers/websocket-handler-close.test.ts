import { describe, it, expect } from 'bun:test';
import { createWebSocketHandlerTestContext } from './websocket-handler-test-setup';

describe('WebSocketHandler - handleClose', () => {
  it('removes the client when the socket closes while addClient is still connecting', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    let resolveAddClient!: () => void;
    mockConnectionManager.addClient.mockImplementation(
      () => new Promise<void>((resolve) => { resolveAddClient = resolve; }),
    );
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123'
    });

    const handling = handler.handleMessage(mockWs, connectMessage);
    await Promise.resolve();

    expect((handler as any).currentUsername).toBe('testuser');
    await handler.handleClose(mockWs);
    expect(mockConnectionManager.removeClient).toHaveBeenCalledWith('testuser', mockWs);

    resolveAddClient();
    await handling;
    expect((handler as any).currentUsername).toBeNull();
  });

  it('should remove client when connection exists', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);
    await handler.handleClose(mockWs);

    expect(mockConnectionManager.removeClient).toHaveBeenCalledWith('testuser', mockWs);
  });

  it('should not throw error when no connection exists', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();

    await expect(handler.handleClose(mockWs)).resolves.toBeUndefined();
    expect(mockConnectionManager.removeClient).not.toHaveBeenCalled();
  });

  it('should handle ConnectionManager.removeClient throwing error', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    mockConnectionManager.removeClient.mockRejectedValue(new Error('Remove failed'));

    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);

    await expect(handler.handleClose(mockWs)).resolves.toBeUndefined();
  });

  it('should set currentUsername to null after disconnect', async () => {
    const { handler, mockWs } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123'
    });

    await handler.handleMessage(mockWs, connectMessage);
    await handler.handleClose(mockWs);

    expect((handler as any).currentUsername).toBeNull();
  });
});
