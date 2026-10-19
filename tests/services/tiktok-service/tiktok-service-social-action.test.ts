import { describe, it, expect, jest } from 'bun:test';
/**
 * refine-sweep iter-4 tiktok-reader MINOR #4 の回帰テスト。
 *
 * TikTok の SOCIAL event は action フィールドで種別を示す:
 *   - action=1 → follow
 *   - action=2 → share
 *   - action=3 → subscribe
 *
 * 従来は「1/2 以外はすべて subscribe 扱い」というフォールバックだったため、
 * SDK が将来新しい action 値（4=..., 5=...）を追加した場合に誤って subscribe
 * として frontend / backend に転送されてしまう問題があった。修正後は 3 を明示的に
 * subscribe とし、他の未知値は skip する。
 */
import {
  createTikTokServiceTestContext,
  logger,
  TikTokLiveConnection,
} from './tiktok-service-test-setup';

describe('TikTokService - SOCIAL action mapping (regression for iter-4 MINOR #4)', () => {
  function connectAndCaptureSocialHandler() {
    const { service, mockWs } = createTikTokServiceTestContext();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const mockConnection = {
      on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
        return mockConnection;
      }),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      removeAllListeners: jest.fn(),
    };
    (TikTokLiveConnection as jest.Mock).mockImplementation(() => mockConnection);
    return { service, mockWs, handlers, mockConnection };
  }

  it('action=1 は follow イベントとして送出される', async () => {
    const { service, mockWs, handlers } = connectAndCaptureSocialHandler();
    await service.connect('streamer', 'session-1', mockWs);

    mockWs.send.mockClear();
    const socialHandler = handlers['social'];
    expect(socialHandler).toBeDefined();
    socialHandler({
      msgId: 'social-1',
      user: { uniqueId: 'u1', nickname: 'Alice' },
      action: 1,
    });

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe('follow');
  });

  it('action=2 は share イベントとして送出される', async () => {
    const { service, mockWs, handlers } = connectAndCaptureSocialHandler();
    await service.connect('streamer', 'session-1', mockWs);

    mockWs.send.mockClear();
    handlers['social']({
      msgId: 'social-2',
      user: { uniqueId: 'u2', nickname: 'Bob' },
      action: 2,
    });

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe('share');
  });

  it('action=3 は subscribe イベントとして送出される', async () => {
    const { service, mockWs, handlers } = connectAndCaptureSocialHandler();
    await service.connect('streamer', 'session-1', mockWs);

    mockWs.send.mockClear();
    handlers['social']({
      msgId: 'social-3',
      user: { uniqueId: 'u3', nickname: 'Carol' },
      action: 3,
    });

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe('subscribe');
  });

  it('未知の action は subscribe にフォールバックせず skip する', async () => {
    const { service, mockWs, handlers } = connectAndCaptureSocialHandler();
    await service.connect('streamer', 'session-1', mockWs);

    mockWs.send.mockClear();
    (logger.debug as jest.Mock).mockClear();

    // 想定外の action 値 (SDK 更新で追加された等)
    handlers['social']({
      msgId: 'social-x',
      user: { uniqueId: 'ux', nickname: 'Xavier' },
      action: 99,
    });

    // subscribe として誤配信されないこと
    expect(mockWs.send).not.toHaveBeenCalled();
    // debug ログに skip 記録が残ること
    const debugCalls = (logger.debug as jest.Mock).mock.calls;
    const skipLog = debugCalls.find(
      ([msg]) => typeof msg === 'string' && msg.includes('未知のアクション種別')
    );
    expect(skipLog).toBeDefined();
  });

  it('action 未設定 (undefined) も subscribe にフォールバックせず skip する', async () => {
    const { service, mockWs, handlers } = connectAndCaptureSocialHandler();
    await service.connect('streamer', 'session-1', mockWs);

    mockWs.send.mockClear();
    handlers['social']({
      msgId: 'social-noaction',
      user: { uniqueId: 'un', nickname: 'NoAction' },
    });

    expect(mockWs.send).not.toHaveBeenCalled();
  });
});
