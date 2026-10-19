import { describe, it, expect } from 'bun:test';
import { createTikTokServiceTestContext } from './tiktok-service-test-setup';

describe('TikTokService - handleSimpleEvent', () => {
  it('should send follow event to WebSocket with correct format', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockFollowData = {
      msgId: 'follow123',
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      }
    };

    (service as any).handleSimpleEvent('follow', mockFollowData);

    expect(mockWs.send).toHaveBeenCalledTimes(1);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.type).toBe('follow');
    expect(sentData.data.id).toBe('follow123');
    expect(sentData.data.tiktokUserId).toBe('user123');
    expect(sentData.data.username).toBe('TestUser');
    expect(sentData.data.timestamp).toBeDefined();
  });

  it('should send share event to WebSocket with correct format', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockShareData = {
      msgId: 'share123',
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      }
    };

    (service as any).handleSimpleEvent('share', mockShareData);

    expect(mockWs.send).toHaveBeenCalledTimes(1);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.type).toBe('share');
    expect(sentData.data.id).toBe('share123');
    expect(sentData.data.tiktokUserId).toBe('user123');
    expect(sentData.data.username).toBe('TestUser');
    expect(sentData.data.timestamp).toBeDefined();
  });

  it('should send member event to WebSocket with correct format', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockMemberData = {
      msgId: 'member123',
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      }
    };

    (service as any).handleSimpleEvent('member', mockMemberData);

    expect(mockWs.send).toHaveBeenCalledTimes(1);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.type).toBe('member');
    expect(sentData.data.id).toBe('member123');
    expect(sentData.data.tiktokUserId).toBe('user123');
    expect(sentData.data.username).toBe('TestUser');
    expect(sentData.data.timestamp).toBeDefined();
  });

  it('should send subscribe event to WebSocket with correct format', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockSubscribeData = {
      msgId: 'subscribe123',
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      }
    };

    (service as any).handleSimpleEvent('subscribe', mockSubscribeData);

    expect(mockWs.send).toHaveBeenCalledTimes(1);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.type).toBe('subscribe');
    expect(sentData.data.id).toBe('subscribe123');
    expect(sentData.data.tiktokUserId).toBe('user123');
    expect(sentData.data.username).toBe('TestUser');
    expect(sentData.data.timestamp).toBeDefined();
  });

  it('should skip event when user info is missing', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockData = {
      msgId: 'test123'
    };

    (service as any).handleSimpleEvent('follow', mockData);

    expect(mockWs.send).not.toHaveBeenCalled();
  });
});
