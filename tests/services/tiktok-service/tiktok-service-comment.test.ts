import { describe, it, expect, jest } from 'bun:test';
import { createTikTokServiceTestContext, logger } from './tiktok-service-test-setup';
import { hashForLog } from '../../../src/utils/hash-for-log';

describe('TikTokService - handleComment', () => {
  it('should send comment to WebSocket with correct format', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockCommentData = {
      msgId: 'msg123',
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      comment: 'Hello World!'
    };

    (service as any).handleComment(mockCommentData);

    expect(mockWs.send).toHaveBeenCalledTimes(1);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.type).toBe('comment');
    expect(sentData.data.id).toBe('msg123');
    expect(sentData.data.tiktokUserId).toBe('user123');
    expect(sentData.data.username).toBe('TestUser');
    expect(sentData.data.text).toBe('Hello World!');
    expect(sentData.data.timestamp).toBeDefined();
  });

  it('should generate deterministic id when msgId is missing', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockCommentData = {
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      comment: 'Test comment'
    };

    (service as any).handleComment(mockCommentData);

    expect(mockWs.send).toHaveBeenCalledTimes(1);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.id).toBeDefined();
    expect(sentData.data.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('should skip comment when user info is missing', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockCommentData = {
      msgId: 'msg123',
      comment: 'Test comment'
    };

    (service as any).handleComment(mockCommentData);

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('should skip comment when uniqueId is missing', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockCommentData = {
      msgId: 'msg123',
      user: {
        nickname: 'TestUser'
      },
      comment: 'Test comment'
    };

    (service as any).handleComment(mockCommentData);

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('should skip comment when nickname is missing', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockCommentData = {
      msgId: 'msg123',
      user: {
        uniqueId: 'user123'
      },
      comment: 'Test comment'
    };

    (service as any).handleComment(mockCommentData);

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('should handle empty comment text', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    const mockCommentData = {
      msgId: 'msg123',
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      comment: ''
    };

    (service as any).handleComment(mockCommentData);

    expect(mockWs.send).toHaveBeenCalledTimes(1);

    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.text).toBe('');
  });

  it('should not log raw PII (uniqueId / nickname / avatarUrl) and use debug level for avatar extraction', () => {
    // 回帰テスト: 過去に logger.info('Avatar extraction', ...) で
    // JSON.stringify(data.user) を平文ログに出していた (nickname / profilePictureUrl が漏えい)。
    // refine-sweep iter-4 tiktok-reader MAJOR #2: ライブ配信の高頻度コメントで
    // Cloud Logging コスト・ノイズが増えるため debug に格下げした。ハッシュ化された
    // 値のみがログに残り、level が debug であることを確認する。
    const { service } = createTikTokServiceTestContext();
    const sensitiveNickname = 'SuperSecretNicknamePII';
    const sensitiveAvatarUrl = 'https://example.com/avatar/SuperSecretAvatarPII.jpg';
    const mockCommentData = {
      msgId: 'msg123',
      user: {
        uniqueId: 'user123',
        nickname: sensitiveNickname,
        profilePictureUrl: sensitiveAvatarUrl,
      },
      comment: 'Hello World!',
    };

    (service as any).handleComment(mockCommentData);

    // Avatar extraction は debug level で出力される（info には出ない）
    const infoMock = logger.info as jest.Mock;
    const infoAvatarLog = infoMock.mock.calls.find(call => call[0] === 'Avatar extraction:');
    expect(infoAvatarLog).toBeUndefined();

    const debugMock = logger.debug as jest.Mock;
    const avatarLog = debugMock.mock.calls.find(call => call[0] === 'Avatar extraction:');
    expect(avatarLog).toBeDefined();
    const payload = avatarLog![1];
    // 平文の PII が含まれていないこと
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(sensitiveNickname);
    expect(serialized).not.toContain(sensitiveAvatarUrl);
    // ハッシュ化されたフィールドが提供されていること
    expect(payload.nicknameHash).toMatch(/^[a-f0-9]{16}$/);
    expect(payload.avatarUrlHash).toMatch(/^[a-f0-9]{16}$/);
    expect(serialized).not.toContain('user123');
    expect(payload.uniqueIdHash).toBe(hashForLog('user123'));
  });

  it('should handle WebSocket send error gracefully', () => {
    const { service, mockWs } = createTikTokServiceTestContext();
    mockWs.send = jest.fn().mockImplementation(() => {
      throw new Error('WebSocket send failed');
    });

    const mockCommentData = {
      msgId: 'msg123',
      user: {
        uniqueId: 'user123',
        nickname: 'TestUser'
      },
      comment: 'Test'
    };

    expect(() => {
      (service as any).handleComment(mockCommentData);
    }).not.toThrow();
  });
});
