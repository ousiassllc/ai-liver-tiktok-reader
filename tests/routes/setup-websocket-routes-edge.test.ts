import { describe, it, expect } from 'bun:test';
import {
  createRouteUpgradeTestContext,
  setupWebSocketRoutes
} from './routes-test-setup';

describe('Routes - setupWebSocketRoutes edge cases', () => {
  const authorizedHeaders = { 'x-reader-secret': 'route-edge-test-secret' };

  describe('Different hosts', () => {
    it('should accept connection from different host', () => {
      process.env.TIKTOK_READER_SHARED_SECRET = authorizedHeaders['x-reader-secret'];
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(
        mockWss,
        request('/ws/events', 'example.com:8472', authorizedHeaders),
        mockSocket,
        mockHead
      );

      expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    });

    it('should accept connection from IPv6 localhost', () => {
      process.env.TIKTOK_READER_SHARED_SECRET = authorizedHeaders['x-reader-secret'];
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(
        mockWss,
        request('/ws/events', '[::1]:8472', authorizedHeaders),
        mockSocket,
        mockHead
      );

      expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    });
  });

  describe('Edge cases', () => {
    it('should handle missing host header', () => {
      process.env.TIKTOK_READER_SHARED_SECRET = authorizedHeaders['x-reader-secret'];
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request('/ws/events', '', authorizedHeaders), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    });

    it('should ignore a malformed host header', () => {
      process.env.TIKTOK_READER_SHARED_SECRET = authorizedHeaders['x-reader-secret'];
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      expect(() => setupWebSocketRoutes(
        mockWss,
        request('/ws/events?session_id=test', 'bad host %', authorizedHeaders),
        mockSocket,
        mockHead
      )).not.toThrow();

      expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    });

    it('should handle undefined url', () => {
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request(undefined), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
    });

    it('should handle empty url', () => {
      const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

      setupWebSocketRoutes(mockWss, request(''), mockSocket, mockHead);

      expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
      expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
    });
  });
});
