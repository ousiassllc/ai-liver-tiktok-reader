import { describe, it, expect, beforeEach } from 'bun:test';
import './tiktok-service-test-setup';
import { createTikTokServiceTestContext, TikTokServiceTestContext } from './tiktok-service-test-setup';

// Issue #615: TikTokService.handleRoomUser の回帰テスト。
// - WebSocket に viewer_count イベントが送出されること
// - Backend の sendViewerCount が最新値で呼ばれること
// - 短時間の連続受信は throttle されて backend push が抑制されること
// - viewerCount が無い / 不正値のイベントは無視されること
describe('TikTokService.handleRoomUser (Issue #615)', () => {
  let ctx: TikTokServiceTestContext;

  beforeEach(() => {
    ctx = createTikTokServiceTestContext();
    // handleRoomUser は private だが (service as any) で呼び出し可能。
  });

  const invokeRoomUser = (data: unknown) => {
    (ctx.service as any).handleRoomUser(data);
  };

  it('should emit viewer_count WebSocket event with the received count', () => {
    invokeRoomUser({ viewerCount: 42 });

    expect(ctx.mockWs.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(ctx.mockWs.send.mock.calls[0][0]);
    expect(payload.type).toBe('viewer_count');
    expect(payload.data.count).toBe(42);
    expect(payload.data.platform).toBe('tiktok');
    expect(typeof payload.data.timestamp).toBe('string');
  });

  it('should call backend sendViewerCount on the first event with session id', () => {
    invokeRoomUser({ viewerCount: 100 });

    expect(ctx.mockBackendApi.sendViewerCount).toHaveBeenCalledTimes(1);
    expect(ctx.mockBackendApi.sendViewerCount).toHaveBeenCalledWith('session-123', 100);
  });

  it('should throttle backend pushes to at most one per throttle window', () => {
    // 短時間で複数回 emit しても backend への push は 1 回に絞られる。
    invokeRoomUser({ viewerCount: 10 });
    invokeRoomUser({ viewerCount: 11 });
    invokeRoomUser({ viewerCount: 12 });

    // WebSocket 側は毎回送出される（frontend の即時反映用途で throttle しない）。
    expect(ctx.mockWs.send).toHaveBeenCalledTimes(3);
    // Backend push は throttle により初回のみ。
    expect(ctx.mockBackendApi.sendViewerCount).toHaveBeenCalledTimes(1);
    expect(ctx.mockBackendApi.sendViewerCount).toHaveBeenCalledWith('session-123', 10);
  });

  it('should allow another backend push after the throttle window elapses', () => {
    // 1 回目
    invokeRoomUser({ viewerCount: 10 });
    expect(ctx.mockBackendApi.sendViewerCount).toHaveBeenCalledTimes(1);

    // throttle をリセット（テスト用に ViewerCountForwarder の内部状態を直接操作）。
    // reset() を呼ぶと lastBackendPushAt = 0 に戻り、次回の呼び出しで再度 backend を叩ける。
    (ctx.service as any).viewerCountForwarder.reset();

    invokeRoomUser({ viewerCount: 20 });
    expect(ctx.mockBackendApi.sendViewerCount).toHaveBeenCalledTimes(2);
    expect(ctx.mockBackendApi.sendViewerCount).toHaveBeenLastCalledWith('session-123', 20);
  });

  it('should ignore events without a viewerCount', () => {
    // WebcastRoomUserSeqMessage は viewerCount を持たない (ranks 更新のみ) ケースがある。
    invokeRoomUser({ totalUser: 500 });
    invokeRoomUser({});
    invokeRoomUser({ viewerCount: undefined });

    expect(ctx.mockWs.send).not.toHaveBeenCalled();
    expect(ctx.mockBackendApi.sendViewerCount).not.toHaveBeenCalled();
  });

  it('should ignore events with negative or non-finite viewerCount', () => {
    invokeRoomUser({ viewerCount: -5 });
    invokeRoomUser({ viewerCount: Number.NaN });
    invokeRoomUser({ viewerCount: Number.POSITIVE_INFINITY });

    expect(ctx.mockWs.send).not.toHaveBeenCalled();
    expect(ctx.mockBackendApi.sendViewerCount).not.toHaveBeenCalled();
  });

  it('should not call backend push when sessionId is not set', () => {
    (ctx.service as any).sessionId = null;

    invokeRoomUser({ viewerCount: 33 });

    // WebSocket 側は送出される。
    expect(ctx.mockWs.send).toHaveBeenCalledTimes(1);
    // sessionId 未設定なので backend push は行われない。
    expect(ctx.mockBackendApi.sendViewerCount).not.toHaveBeenCalled();
  });

  it('should floor fractional viewerCount to integer', () => {
    invokeRoomUser({ viewerCount: 42.9 });

    const payload = JSON.parse(ctx.mockWs.send.mock.calls[0][0]);
    expect(payload.data.count).toBe(42);
    expect(ctx.mockBackendApi.sendViewerCount).toHaveBeenCalledWith('session-123', 42);
  });
});
