import { describe, it, expect, jest } from 'bun:test';
import { createTikTokServiceTestContext, logger } from './tiktok-service-test-setup';

/**
 * Issue #2154 の回帰テスト:
 * TikTok のコメントは tiktok-reader 内でしか受信できず、従来は WebSocket 配信のみで
 * backend に一切届いていなかったため、MCP の pick_ai_comments が読む session_comments が
 * TikTok 配信では常に空だった。gift / viewer-count と同じ ingress 経路で転送する。
 *
 * 最重要の制約は「視聴者へのリアルタイム配信を遅延・阻害しない」こと。転送は safeSend の
 * 後に fire-and-forget で行い、失敗しても handleComment は throw しない。
 */
const baseCommentData = {
  msgId: 'msg123',
  user: {
    uniqueId: 'user123',
    nickname: 'TestUser',
  },
  comment: 'Hello World!',
};

/** fire-and-forget な `.catch()` が走るまでマイクロタスクを消化する。 */
const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('TikTokService - handleComment backend forwarding (Issue #2154)', () => {
  it('forwards the comment to backend with the session id and RFC3339 received_at', async () => {
    const { service, mockBackendApi } = createTikTokServiceTestContext();

    (service as any).handleComment(baseCommentData);
    await flushMicrotasks();

    expect(mockBackendApi.sendComment).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = mockBackendApi.sendComment.mock.calls[0];
    expect(sessionId).toBe('session-123');
    // backend の RecordSessionCommentRequest は platform を必須にしているため必ず送る。
    expect(payload.platform).toBe('tiktok');
    expect(payload.platform_comment_id).toBe('msg123');
    expect(payload.platform_user_id).toBe('user123');
    expect(payload.username).toBe('TestUser');
    expect(payload.text).toBe('Hello World!');
    // WebSocket に載せた timestamp と同じ値を received_at として送る。
    expect(payload.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Number.isNaN(Date.parse(payload.received_at))).toBe(false);
  });

  it('uses the deterministic id as platform_comment_id when msgId is missing', async () => {
    const { service, mockBackendApi } = createTikTokServiceTestContext();

    (service as any).handleComment({ ...baseCommentData, msgId: undefined });
    await flushMicrotasks();

    const [, payload] = mockBackendApi.sendComment.mock.calls[0];
    expect(payload.platform_comment_id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('skips backend forwarding when sessionId is not set', async () => {
    const { service, mockWs, mockBackendApi } = createTikTokServiceTestContext();
    // sessionId を null にすると connect() 前にイベントが来た場合を模擬できる。
    // 転送先 URL に session ID が必要なため転送しないが、WebSocket 配信は続行する。
    (service as any).sessionId = null;

    (service as any).handleComment(baseCommentData);
    await flushMicrotasks();

    expect(mockBackendApi.sendComment).not.toHaveBeenCalled();
    expect(mockWs.send).toHaveBeenCalledTimes(1);
  });

  it('skips backend forwarding for an empty comment but still delivers over WebSocket', async () => {
    // backend は空文字の text に 400 を返すため送らない。
    const { service, mockWs, mockBackendApi } = createTikTokServiceTestContext();

    (service as any).handleComment({ ...baseCommentData, comment: '' });
    await flushMicrotasks();

    expect(mockBackendApi.sendComment).not.toHaveBeenCalled();
    expect(mockWs.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.text).toBe('');
  });

  it('skips backend forwarding when user info is missing', async () => {
    const { service, mockWs, mockBackendApi } = createTikTokServiceTestContext();

    (service as any).handleComment({ msgId: 'msg123', comment: 'no user' });
    await flushMicrotasks();

    expect(mockWs.send).not.toHaveBeenCalled();
    expect(mockBackendApi.sendComment).not.toHaveBeenCalled();
  });

  // 以下 2 件が本 Issue の核心: backend 転送はコメント配信を絶対に阻害してはならない。
  it('does not throw and still delivers over WebSocket when backend forwarding rejects', async () => {
    const { service, mockWs, mockBackendApi } = createTikTokServiceTestContext();
    mockBackendApi.sendComment.mockRejectedValueOnce(new Error('backend unavailable'));

    expect(() => {
      (service as any).handleComment(baseCommentData);
    }).not.toThrow();

    // WebSocket 配信は転送の結果を待たずに完了している。
    expect(mockWs.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockWs.send.mock.calls[0][0]).type).toBe('comment');

    await flushMicrotasks();

    // reject は `.catch()` で受け止められている (floating promise の
    // unhandled rejection にならない) ことをログ形状で確認する。
    const errorMock = logger.error as jest.Mock;
    const forwardFailureLog = errorMock.mock.calls.find(
      call => call[0] === 'コメントのBackend API転送に失敗:'
    );
    expect(forwardFailureLog).toBeDefined();
    // 転送失敗はコメント処理自体の失敗として扱わない。
    const handlerErrorLog = errorMock.mock.calls.find(
      call => call[0] === 'コメント処理エラー:'
    );
    expect(handlerErrorLog).toBeUndefined();
  });

  it('does not throw when backend forwarding throws synchronously', async () => {
    const { service, mockWs, mockBackendApi } = createTikTokServiceTestContext();
    mockBackendApi.sendComment.mockImplementationOnce(() => {
      throw new Error('sync boom');
    });

    expect(() => {
      (service as any).handleComment(baseCommentData);
    }).not.toThrow();

    // 同期例外は safeSend の後に起きるため、コメント配信自体は成功している。
    expect(mockWs.send).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
  });

  it('delivers over WebSocket before awaiting the backend forward (fire-and-forget order)', async () => {
    const { service, mockWs, mockBackendApi } = createTikTokServiceTestContext();
    const callOrder: string[] = [];
    mockWs.send = jest.fn().mockImplementation(() => {
      callOrder.push('ws');
    });
    // 転送が解決しない Promise を返しても handleComment は同期的に戻る。
    mockBackendApi.sendComment.mockImplementationOnce(() => {
      callOrder.push('backend');
      return new Promise<void>(() => {});
    });

    (service as any).handleComment(baseCommentData);

    expect(callOrder).toEqual(['ws', 'backend']);
  });
});
