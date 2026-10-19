import { describe, it, expect, jest } from 'bun:test';
import {
  createTikTokServiceTestContext,
  TikTokLiveConnection
} from './tiktok-service-test-setup';

describe('TikTokService - lifecycle', () => {
  describe('disconnect', () => {
    it('should disconnect TikTok connection and clean up listeners', async () => {
      const { service } = createTikTokServiceTestContext();
      const mockConnection = {
        removeAllListeners: jest.fn(),
        disconnect: jest.fn().mockResolvedValue(undefined)
      };

      (service as any).connection = mockConnection;

      await service.disconnect();

      expect(mockConnection.removeAllListeners).toHaveBeenCalledTimes(1);
      expect(mockConnection.disconnect).toHaveBeenCalledTimes(1);
      expect((service as any).connection).toBeNull();
    });

    it('should handle disconnect when no connection exists', async () => {
      const { service } = createTikTokServiceTestContext();
      (service as any).connection = null;

      await expect(service.disconnect()).resolves.toBeUndefined();
    });

    it('should handle disconnect errors gracefully', async () => {
      const { service } = createTikTokServiceTestContext();
      const mockConnection = {
        removeAllListeners: jest.fn(),
        disconnect: jest.fn().mockRejectedValue(new Error('Disconnect failed'))
      };

      (service as any).connection = mockConnection;

      await expect(service.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('connect error handling', () => {
    it('should cleanup listeners when connection fails', async () => {
      const { service, mockWs } = createTikTokServiceTestContext();
      const mockConnection = {
        on: jest.fn(),
        connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
        removeAllListeners: jest.fn()
      };

      (TikTokLiveConnection as jest.Mock).mockImplementation(() => mockConnection);

      await expect(service.connect('testuser', 'session-123', mockWs)).rejects.toThrow('Connection failed');

      expect(mockConnection.removeAllListeners).toHaveBeenCalledTimes(1);
      expect((service as any).connection).toBeNull();
    });

    it('disconnect後に遅れて成功したconnectを再切断する', async () => {
      const { service } = createTikTokServiceTestContext();
      let resolveConnect!: () => void;
      const mockConnection = {
        on: jest.fn(),
        connect: jest.fn(() => new Promise<void>((resolve) => { resolveConnect = resolve; })),
        disconnect: jest.fn().mockResolvedValue(undefined),
        removeAllListeners: jest.fn(),
      };
      (TikTokLiveConnection as jest.Mock).mockImplementation(() => mockConnection);

      const connecting = service.connect('testuser', 'session-123');
      await Promise.resolve();
      await service.disconnect();
      resolveConnect();

      await expect(connecting).rejects.toThrow('connection cancelled');
      expect(mockConnection.disconnect).toHaveBeenCalledTimes(2);
      expect((service as any).connection).toBeNull();
    });
  });
});
