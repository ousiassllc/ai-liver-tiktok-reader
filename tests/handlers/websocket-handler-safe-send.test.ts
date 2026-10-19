import { describe, it, expect } from 'bun:test';
import {
  createWebSocketHandlerTestContext,
  WebSocket
} from './websocket-handler-test-setup';

describe('WebSocketHandler - safeSend', () => {
  it('should send message when WebSocket is OPEN', () => {
    const { handler, mockWs } = createWebSocketHandlerTestContext();
    mockWs.readyState = WebSocket.OPEN;

    (handler as any).safeSend(mockWs, 'test message');

    expect(mockWs.send).toHaveBeenCalledWith('test message');
  });

  it('should not send message and log warning when WebSocket is CLOSED', () => {
    const { handler, mockWs } = createWebSocketHandlerTestContext();
    const { logger } = require('../../src/utils/logger');
    mockWs.readyState = WebSocket.CLOSED;

    (handler as any).safeSend(mockWs, 'test message');

    expect(mockWs.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'WebSocket is not open. Message not sent.',
      { readyState: WebSocket.CLOSED }
    );
  });
});
