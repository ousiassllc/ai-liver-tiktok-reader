import { describe, it, expect, jest } from 'bun:test';
import { createTikTokServiceTestContext } from './tiktok-service-test-setup';

describe('TikTokService - handleGift edge cases', () => {
  it('should skip gift when user info is missing', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 5
    };

    (service as any).handleGift(mockGiftData);

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('should skip gift when uniqueId is missing', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 5
    };

    (service as any).handleGift(mockGiftData);

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('should handle WebSocket send error gracefully', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    mockWs.send = jest.fn().mockImplementation(() => {
      throw new Error('WebSocket send failed');
    });

    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 5
    };

    expect(() => {
      (service as any).handleGift(mockGiftData);
    }).not.toThrow();
  });

  it('should handle missing repeatCount with default value', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100
    };

    (service as any).handleGift(mockGiftData);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.giftCount).toBe(1);
  });
});
