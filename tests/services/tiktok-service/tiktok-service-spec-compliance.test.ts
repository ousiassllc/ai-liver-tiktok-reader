import { describe, it, expect, jest } from 'bun:test';
/**
 * spec 3-3-5-3-2 / 3-3-5-3-3 / 3-3-5-3-4 / api.md L2851 への準拠回帰テスト。
 *
 * - コメント / ギフトイベントには platformUserId と platform が含まれる
 * - ギフトイベントには currency / message フィールドが含まれる
 * - status メッセージは data: { status, message } のネスト形式で送信される
 * - error メッセージは data: { code, message } のネスト形式で送信される
 * - member イベントには memberLevel フィールドが含まれる
 */
import { createTikTokServiceTestContext } from './tiktok-service-test-setup';

describe('TikTokService - spec compliance', () => {
  describe('comment event (spec 3-3-5-3-2)', () => {
    it('includes platformUserId and platform fields', () => {
      const { service, mockWs } = createTikTokServiceTestContext();

      (service as any).handleComment({
        msgId: 'msg-1',
        user: { uniqueId: 'user-1', nickname: 'Tester' },
        comment: 'hello'
      });

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('comment');
      expect(sent.data.platformUserId).toBe('user-1');
      // 後方互換フィールドも維持されること
      expect(sent.data.tiktokUserId).toBe('user-1');
      expect(sent.data.platform).toBe('tiktok');
    });
  });

  describe('gift event (spec 3-3-5-3-3)', () => {
    it('includes platformUserId, platform, currency, message fields', () => {
      const { service, mockWs } = createTikTokServiceTestContext();

      (service as any).handleGift({
        msgId: 'gift-1',
        user: { uniqueId: 'user-2', nickname: 'Donor' },
        giftName: 'Rose',
        diamondCount: 100,
        repeatCount: 3
      });

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('gift');
      expect(sent.data.platformUserId).toBe('user-2');
      expect(sent.data.tiktokUserId).toBe('user-2');
      expect(sent.data.platform).toBe('tiktok');
      // currency / message は spec で必須。TikTok は diamond 通貨なので空文字で送信。
      expect(sent.data).toHaveProperty('currency');
      expect(sent.data).toHaveProperty('message');
      expect(typeof sent.data.currency).toBe('string');
      expect(typeof sent.data.message).toBe('string');
    });
  });

  describe('status message (spec 3-3-5-3-4)', () => {
    it('nests status and message under data field on STREAM_END', async () => {
      const {
        TikTokLiveConnection
      } = require('tiktok-live-connector');
      const { service, mockWs } = createTikTokServiceTestContext();

      const handlers: Record<string, (...args: any[]) => void> = {};
      const mockConnection = {
        on: jest.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return mockConnection;
        }),
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        removeAllListeners: jest.fn()
      };
      (TikTokLiveConnection as jest.Mock).mockImplementation(() => mockConnection);

      await service.connect('streamer', 'session-123', mockWs);

      // 接続成功時の status
      const connectedCall = mockWs.send.mock.calls.find(
        ([msg]) => JSON.parse(msg).type === 'status'
      );
      expect(connectedCall).toBeDefined();
      const connectedPayload = JSON.parse(connectedCall![0]);
      expect(connectedPayload).toEqual({
        type: 'status',
        data: {
          status: 'connected',
          message: expect.any(String)
        }
      });
      // 旧フォーマットの最上位 status/message を残さないこと
      expect(connectedPayload).not.toHaveProperty('status');
      expect(connectedPayload).not.toHaveProperty('message');

      // STREAM_END 時の disconnected status
      mockWs.send.mockClear();
      const streamEndHandler = handlers['streamEnd'];
      expect(streamEndHandler).toBeDefined();
      streamEndHandler();

      const endCall = mockWs.send.mock.calls.find(
        ([msg]) => JSON.parse(msg).type === 'status'
      );
      expect(endCall).toBeDefined();
      const endPayload = JSON.parse(endCall![0]);
      expect(endPayload).toEqual({
        type: 'status',
        data: {
          status: 'disconnected',
          message: expect.any(String)
        }
      });
      expect(endPayload).not.toHaveProperty('status');
      expect(endPayload).not.toHaveProperty('message');
    });
  });

  describe('connector diagnostic event', () => {
    it('does not report a fallback diagnostic as CONNECTION_FAILED', async () => {
      const {
        TikTokLiveConnection
      } = require('tiktok-live-connector');
      const { service, mockWs } = createTikTokServiceTestContext();

      const handlers: Record<string, (...args: any[]) => void> = {};
      const mockConnection = {
        isConnecting: true,
        isConnected: false,
        on: jest.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return mockConnection;
        }),
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        removeAllListeners: jest.fn()
      };
      (TikTokLiveConnection as jest.Mock).mockImplementation(() => mockConnection);

      let resolveConnect!: () => void;
      mockConnection.connect.mockImplementation(
        () => new Promise<void>((resolve) => { resolveConnect = resolve; }),
      );

      const connecting = service.connect('streamer', 'session-fallback', mockWs);
      await Promise.resolve();

      const errorHandler = handlers['error'];
      expect(errorHandler).toBeDefined();
      errorHandler({
        info: 'Failed to retrieve Room ID from main page, falling back to API source...',
        exception: new Error('Failed to extract the SIGI_STATE HTML tag'),
      });

      expect(mockWs.send).not.toHaveBeenCalled();
      expect(mockWs.close).not.toHaveBeenCalled();

      resolveConnect();
      await connecting;

      const messages = mockWs.send.mock.calls.map(([message]) => JSON.parse(message));
      expect(messages).toEqual([
        {
          type: 'status',
          data: {
            status: 'connected',
            message: 'TikTok Liveに接続しました',
          },
        },
      ]);
    });

    it('reports an error that occurs after the connection has completed', async () => {
      const { TikTokLiveConnection } = require('tiktok-live-connector');
      const { service, mockWs } = createTikTokServiceTestContext();
      const handlers: Record<string, (...args: any[]) => void> = {};
      const mockConnection = {
        isConnecting: false,
        isConnected: true,
        on: jest.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return mockConnection;
        }),
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        removeAllListeners: jest.fn(),
      };
      (TikTokLiveConnection as jest.Mock).mockImplementation(() => mockConnection);

      await service.connect('streamer', 'session-runtime-error', mockWs);
      mockWs.send.mockClear();

      handlers.error({
        info: 'WebSocket Error',
        exception: new Error('transport closed'),
      });

      expect(JSON.parse(mockWs.send.mock.calls[0][0])).toEqual({
        type: 'error',
        data: {
          code: 'CONNECTION_FAILED',
          message: 'transport closed',
        },
      });
      expect(mockWs.close).toHaveBeenCalledTimes(1);
    });

    it('does not duplicate the final error emitted immediately before connect rejects', async () => {
      const { TikTokLiveConnection } = require('tiktok-live-connector');
      const { service, mockWs } = createTikTokServiceTestContext();
      const handlers: Record<string, (...args: any[]) => void> = {};
      const finalError = new Error('all room ID sources failed');
      const mockConnection = {
        isConnecting: false,
        isConnected: false,
        on: jest.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return mockConnection;
        }),
        connect: jest.fn(async () => {
          handlers.error({ info: 'Error while connecting', exception: finalError });
          throw finalError;
        }),
        disconnect: jest.fn(),
        removeAllListeners: jest.fn(),
      };
      (TikTokLiveConnection as jest.Mock).mockImplementation(() => mockConnection);

      await expect(service.connect('streamer', 'session-final-error', mockWs)).rejects.toThrow(
        'all room ID sources failed',
      );

      expect(mockWs.send).not.toHaveBeenCalled();
      expect(mockWs.close).not.toHaveBeenCalled();
    });
  });

  describe('member event (spec api.md L2851)', () => {
    it('includes memberLevel field with default 0 when not provided', () => {
      const { service, mockWs } = createTikTokServiceTestContext();

      (service as any).handleSimpleEvent('member', {
        msgId: 'member-1',
        user: { uniqueId: 'user-3', nickname: 'NewMember' }
      });

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('member');
      expect(sent.data).toHaveProperty('memberLevel');
      expect(sent.data.memberLevel).toBe(0);
    });

    it('propagates memberLevel from payload when provided', () => {
      const { service, mockWs } = createTikTokServiceTestContext();

      (service as any).handleSimpleEvent('member', {
        msgId: 'member-2',
        user: { uniqueId: 'user-4', nickname: 'VipMember' },
        memberLevel: 7
      });

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sent.data.memberLevel).toBe(7);
    });

    it('omits memberLevel for non-member simple events', () => {
      const { service, mockWs } = createTikTokServiceTestContext();

      (service as any).handleSimpleEvent('follow', {
        msgId: 'follow-1',
        user: { uniqueId: 'user-5', nickname: 'Follower' }
      });

      const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('follow');
      expect(sent.data).not.toHaveProperty('memberLevel');
    });
  });
});
