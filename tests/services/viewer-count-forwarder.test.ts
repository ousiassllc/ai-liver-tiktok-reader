import { describe, it, expect, mock, jest, afterAll } from 'bun:test';
import { ViewerCountForwarder } from '../../src/services/viewer-count-forwarder';
import * as realLoggerNs from '../../src/utils/logger';

const realLogger = { ...realLoggerNs };

mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

// ViewerCountForwarder は tiktok-service.ts のファイル行数上限を守るため
// 切り出したモジュール。TikTokService 経由の統合テスト（tiktok-service-room-user.test.ts）
// と重複するが、単体レベルで throttle / reset を検証してリファクタ耐性を持たせる。
describe('ViewerCountForwarder (Issue #615)', () => {
  const makeBackend = () => ({
    sendGift: jest.fn().mockResolvedValue(undefined),
    sendViewerCount: jest.fn().mockResolvedValue(undefined)
  });

  it('forwards to wsSend and backend on first call', () => {
    const backend = makeBackend();
    const wsSend = jest.fn();
    const fwd = new ViewerCountForwarder(backend as any);

    fwd.handle({ viewerCount: 5 }, 'sess-1', wsSend);

    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(backend.sendViewerCount).toHaveBeenCalledWith('sess-1', 5);
  });

  it('throttles subsequent backend pushes within the interval window', () => {
    const backend = makeBackend();
    const wsSend = jest.fn();
    // 非常に長い throttle 間隔でテスト（1 分）
    const fwd = new ViewerCountForwarder(backend as any, 60_000);

    fwd.handle({ viewerCount: 1 }, 'sess-1', wsSend);
    fwd.handle({ viewerCount: 2 }, 'sess-1', wsSend);
    fwd.handle({ viewerCount: 3 }, 'sess-1', wsSend);

    expect(wsSend).toHaveBeenCalledTimes(3);
    // Backend push は初回のみ。
    expect(backend.sendViewerCount).toHaveBeenCalledTimes(1);
  });

  it('resets throttle so backend push resumes after reset()', () => {
    const backend = makeBackend();
    const wsSend = jest.fn();
    const fwd = new ViewerCountForwarder(backend as any, 60_000);

    fwd.handle({ viewerCount: 1 }, 'sess-1', wsSend);
    expect(backend.sendViewerCount).toHaveBeenCalledTimes(1);

    fwd.reset();
    fwd.handle({ viewerCount: 2 }, 'sess-1', wsSend);
    expect(backend.sendViewerCount).toHaveBeenCalledTimes(2);
    expect(backend.sendViewerCount).toHaveBeenLastCalledWith('sess-1', 2);
  });

  it('skips backend push when sessionId is null but still emits WebSocket event', () => {
    const backend = makeBackend();
    const wsSend = jest.fn();
    const fwd = new ViewerCountForwarder(backend as any);

    fwd.handle({ viewerCount: 10 }, null, wsSend);

    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(backend.sendViewerCount).not.toHaveBeenCalled();
  });

  it('ignores events without a valid viewerCount', () => {
    const backend = makeBackend();
    const wsSend = jest.fn();
    const fwd = new ViewerCountForwarder(backend as any);

    fwd.handle({}, 'sess-1', wsSend);
    fwd.handle({ viewerCount: -1 }, 'sess-1', wsSend);
    fwd.handle({ viewerCount: Number.NaN }, 'sess-1', wsSend);

    expect(wsSend).not.toHaveBeenCalled();
    expect(backend.sendViewerCount).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
});
