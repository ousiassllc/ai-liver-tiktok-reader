import { describe, it, expect } from 'bun:test';
import { createTikTokServiceTestContext } from './tiktok-service-test-setup';

describe('TikTokService - handleGift', () => {
  it('should send gift to WebSocket with correct format', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 5
    };

    (service as any).handleGift(mockGiftData);

    expect(mockWs.send).toHaveBeenCalledTimes(1);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.type).toBe('gift');
    expect(sentData.data.id).toBeDefined();
    expect(sentData.data.id).toMatch(/^[a-f0-9]{32}$/);
    expect(sentData.data.tiktokUserId).toBe('user123');
    expect(sentData.data.username).toBe('TestUser');
    expect(sentData.data.giftType).toBe('Rose');
    expect(sentData.data.giftAmount).toBe(100);
    expect(sentData.data.giftCount).toBe(5);
    expect(sentData.data.timestamp).toBeDefined();
  });

  it('should prefer msgId when present', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      msgId: 'gift-msg-123',
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 1
    };

    (service as any).handleGift(mockGiftData);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.id).toBe('gift-msg-123');
  });

  it('should use extendedGiftInfo when available', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 5,
      extendedGiftInfo: {
        name: 'Premium Rose',
        diamond_count: 150
      }
    };

    (service as any).handleGift(mockGiftData);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.giftType).toBe('Rose');
    expect(sentData.data.giftAmount).toBe(100);
  });

  it('should fallback to extendedGiftInfo when main fields are missing', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      extendedGiftInfo: {
        name: 'Premium Rose',
        diamond_count: 150
      }
    };

    (service as any).handleGift(mockGiftData);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.giftType).toBe('Premium Rose');
    expect(sentData.data.giftAmount).toBe(150);
  });

  it('should handle missing gift name with fallback', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      diamondCount: 100,
      repeatCount: 1
    };

    (service as any).handleGift(mockGiftData);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.giftType).toBe('Unknown Gift');
  });

  it('should handle zero diamondCount', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 0,
      repeatCount: 1
    };

    (service as any).handleGift(mockGiftData);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.giftAmount).toBe(0);
  });

  it('should handle zero repeatCount', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 0
    };

    (service as any).handleGift(mockGiftData);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.giftCount).toBe(0);
  });

  // refine-sweep iter-3 backend MAJOR 回帰テスト:
  // 以前は BackendApiService の import / 呼び出しがコメントアウトされていたため、
  // handleGift 時に backend DB への保存が行われず、管理画面のギフト累計が常に 0 のままだった。
  // handleGift が sendGift を呼び出し、sessionId を含む正しい payload を渡すことを検証する。
  it('should forward gift to backend API with correct payload', () => {
    const { service, mockBackendApi } = createTikTokServiceTestContext();
    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 5
    };

    (service as any).handleGift(mockGiftData);

    expect(mockBackendApi.sendGift).toHaveBeenCalledTimes(1);
    const payload = mockBackendApi.sendGift.mock.calls[0][0];
    expect(payload.session_id).toBe('session-123');
    expect(payload.tiktok_user_id).toBe('user123');
    expect(payload.user_name).toBe('TestUser');
    expect(payload.gift_type).toBe('Rose');
    expect(payload.gift_amount).toBe(100);
    expect(payload.gift_count).toBe(5);
  });

  it('should skip backend forwarding when sessionId is not set', () => {
    const { service, mockBackendApi } = createTikTokServiceTestContext();
    // sessionId を明示的に null にすると、connect() 前にイベントが来た場合を模擬できる。
    (service as any).sessionId = null;

    const mockGiftData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      giftName: 'Rose',
      diamondCount: 100,
      repeatCount: 1
    };

    (service as any).handleGift(mockGiftData);

    expect(mockBackendApi.sendGift).not.toHaveBeenCalled();
  });
});
