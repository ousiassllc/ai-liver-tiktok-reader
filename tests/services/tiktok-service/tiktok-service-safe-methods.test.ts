import { describe, it, expect } from 'bun:test';
import {
  createTikTokServiceTestContext,
  WebSocket
} from './tiktok-service-test-setup';

describe('TikTokService - safe WebSocket methods', () => {
  describe('safeSend', () => {
    it('should send message when WebSocket is OPEN', () => {
      const { service, mockWs } = createTikTokServiceTestContext();
      mockWs.readyState = WebSocket.OPEN;

      (service as any).safeSend('test message');

      expect(mockWs.send).toHaveBeenCalledWith('test message');
    });

    it('should not send message and log warning when WebSocket is CLOSED', () => {
      const { service, mockWs } = createTikTokServiceTestContext();
      const { logger } = require('../../../src/utils/logger');
      mockWs.readyState = WebSocket.CLOSED;

      (service as any).safeSend('test message');

      expect(mockWs.send).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'WebSocket is not open',
        { readyState: WebSocket.CLOSED }
      );
    });
  });

  describe('safeClose', () => {
    it('should close WebSocket when state is OPEN', () => {
      const { service, mockWs } = createTikTokServiceTestContext();
      mockWs.readyState = WebSocket.OPEN;

      (service as any).safeClose();

      expect(mockWs.close).toHaveBeenCalledTimes(1);
    });

    it('should close WebSocket when state is CONNECTING', () => {
      const { service, mockWs } = createTikTokServiceTestContext();
      mockWs.readyState = WebSocket.CONNECTING;

      (service as any).safeClose();

      expect(mockWs.close).toHaveBeenCalledTimes(1);
    });

    it('should not close when WebSocket is already CLOSED', () => {
      const { service, mockWs } = createTikTokServiceTestContext();
      mockWs.readyState = WebSocket.CLOSED;

      (service as any).safeClose();

      expect(mockWs.close).not.toHaveBeenCalled();
    });
  });
});
