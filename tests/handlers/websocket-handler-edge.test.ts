import { describe, it, expect } from 'bun:test';
import { createWebSocketHandlerTestContext } from './websocket-handler-test-setup';

describe('WebSocketHandler - edge cases', () => {
  it('should handle message with missing sessionId', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockConnectionManager.addClient).toHaveBeenCalledWith(
      'testuser',
      mockWs,
      undefined
    );
  });

  it('should handle message with extra fields', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const connectMessage = JSON.stringify({
      type: 'connect',
      liveUrl: 'https://www.tiktok.com/@testuser/live',
      sessionId: 'session-123',
      extraField: 'should be ignored'
    });

    await handler.handleMessage(mockWs, connectMessage);

    expect(mockConnectionManager.addClient).toHaveBeenCalled();
  });

  it('should handle message with unknown type', async () => {
    const { handler, mockWs, mockConnectionManager } = createWebSocketHandlerTestContext();
    const unknownMessage = JSON.stringify({
      type: 'unknown',
      data: 'test'
    });

    await handler.handleMessage(mockWs, unknownMessage);

    expect(mockWs.send).not.toHaveBeenCalled();
    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
  });
});
