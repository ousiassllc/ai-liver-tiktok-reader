import { describe, it, expect } from 'bun:test';
import {
  createRouteUpgradeTestContext,
  setupWebSocketRoutes,
  WebSocket
} from './routes-test-setup';

describe('Routes - setupWebSocketRoutes', () => {
  const authorizedHeaders = { 'x-reader-secret': 'route-test-secret' };

  describe('Valid WebSocket paths', () => {
    it('should accept connection to /ws/events', () => {
      process.env.TIKTOK_READER_SHARED_SECRET = authorizedHeaders['x-reader-secret'];
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
      const mockRequest = request('/ws/events', 'localhost:8472', authorizedHeaders);

      setupWebSocketRoutes(mockWss, mockRequest, mockSocket, mockHead);

      expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
      expect(mockWss.handleUpgrade).toHaveBeenCalledWith(
        mockRequest,
        mockSocket,
        mockHead,
        expect.any(Function)
      );
      expect(mockSocket.destroy).not.toHaveBeenCalled();
    });

    it('should call handleUpgrade with correct callback', () => {
      process.env.TIKTOK_READER_SHARED_SECRET = authorizedHeaders['x-reader-secret'];
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();
      const mockRequest = request('/ws/events', 'localhost:8472', authorizedHeaders);

      setupWebSocketRoutes(mockWss, mockRequest, mockSocket, mockHead);

      const callback = mockWss.handleUpgrade.mock.calls[0][3];
      expect(typeof callback).toBe('function');

      const mockWs = {} as WebSocket;
      callback(mockWs);

      // Issue #2782: 共有 secret 経路は session / 配信者を制限しない scope を接続へ引き継ぐ。
      expect(mockWss.emit).toHaveBeenCalledWith('connection', mockWs, mockRequest, {
        sessionId: null,
        username: null
      });
    });
  });

  describe('Invalid WebSocket paths', () => {
    it('should reject connection to /invalid-path', () => {
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request('/invalid-path'), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n');
      expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
    });

    it('should reject connection to root path', () => {
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request('/'), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n');
      expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
    });

    it('should reject connection to /ws (missing /events)', () => {
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request('/ws'), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
    });

    it('should reject connection to /events (missing /ws)', () => {
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request('/events'), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Path variations', () => {
    it('should handle /ws/events with query parameters', () => {
      process.env.TIKTOK_READER_SHARED_SECRET = authorizedHeaders['x-reader-secret'];
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(
        mockWss,
        request('/ws/events?token=abc123', 'localhost:8472', authorizedHeaders),
        mockSocket,
        mockHead
      );

      expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
      expect(mockSocket.destroy).not.toHaveBeenCalled();
    });

    it('should handle /ws/events with trailing slash', () => {
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request('/ws/events/'), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
    });

    it('should handle case-sensitive path', () => {
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request('/WS/EVENTS'), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
    });
  });
});
