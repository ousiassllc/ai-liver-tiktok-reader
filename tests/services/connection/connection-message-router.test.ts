import { beforeEach, describe, expect, it, jest } from 'bun:test';
import {
  routeTikTokMessage,
  type ConnectionMessageRouterDeps,
} from '../../../src/services/connection/connection-message-router';
import type { ConnectionBroadcaster } from '../../../src/services/connection/connection-broadcaster';
import type { PubSubService } from '../../../src/services/pubsub-service';

/**
 * Issue #2069 (C-1): `bun test --coverage` を CI のゲートにするにあたり、
 * bunfig.toml の coverageThreshold (0.5) はファイル単位で判定されるため、
 * テストの無かった本ファイル (funcs 0%) だけがゲートを落としていた。
 * ルーティング分岐を網羅して閾値を満たしつつ、分岐の意図を回帰で固定する。
 */
describe('routeTikTokMessage', () => {
  let broadcastToClients: ReturnType<typeof jest.fn>;
  let publishEvent: ReturnType<typeof jest.fn>;
  let onStreamDisconnected: ReturnType<typeof jest.fn>;
  let deps: ConnectionMessageRouterDeps;

  beforeEach(() => {
    broadcastToClients = jest.fn();
    publishEvent = jest.fn(async () => {});
    onStreamDisconnected = jest.fn(async () => {});
    deps = {
      broadcaster: { broadcastToClients } as unknown as ConnectionBroadcaster,
      pubsubService: { publishEvent } as unknown as PubSubService,
      onStreamDisconnected: onStreamDisconnected as unknown as () => Promise<void>,
    };
  });

  it('WebSocketクライアントへは常に生messageをそのまま配信する', () => {
    const message = JSON.stringify({ type: 'chat', data: { comment: 'hi' } });

    routeTikTokMessage('streamer', message, deps);

    expect(broadcastToClients).toHaveBeenCalledWith('streamer', message);
  });

  it('status以外のtypeはPub/Subへdataを転送する', () => {
    routeTikTokMessage(
      'streamer',
      JSON.stringify({ type: 'gift', data: { giftId: 1 } }),
      deps,
    );

    expect(publishEvent).toHaveBeenCalledWith('gift', 'streamer', { giftId: 1 });
    expect(onStreamDisconnected).not.toHaveBeenCalled();
  });

  it('dataが無いときはparsed全体をPub/Subへ渡す', () => {
    routeTikTokMessage('streamer', JSON.stringify({ type: 'like' }), deps);

    expect(publishEvent).toHaveBeenCalledWith('like', 'streamer', { type: 'like' });
  });

  it('type=statusはPub/Subへ転送しない', () => {
    routeTikTokMessage(
      'streamer',
      JSON.stringify({ type: 'status', data: { status: 'connected' } }),
      deps,
    );

    expect(publishEvent).not.toHaveBeenCalled();
    expect(onStreamDisconnected).not.toHaveBeenCalled();
  });

  it('type=errorはPub/Subへ転送しない', () => {
    routeTikTokMessage(
      'streamer',
      JSON.stringify({ type: 'error', data: { message: 'boom' } }),
      deps,
    );

    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('data.status=disconnectedで配信終了コールバックを呼ぶ', () => {
    routeTikTokMessage(
      'streamer',
      JSON.stringify({ type: 'status', data: { status: 'disconnected' } }),
      deps,
    );

    expect(onStreamDisconnected).toHaveBeenCalledTimes(1);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('旧形式のトップレベルstatus=disconnectedも受け付ける', () => {
    routeTikTokMessage(
      'streamer',
      JSON.stringify({ type: 'status', status: 'disconnected' }),
      deps,
    );

    expect(onStreamDisconnected).toHaveBeenCalledTimes(1);
  });

  it('配信終了コールバックがrejectしても例外を伝播しない', async () => {
    onStreamDisconnected.mockImplementation(async () => {
      throw new Error('teardown failed');
    });

    expect(() =>
      routeTikTokMessage(
        'streamer',
        JSON.stringify({ type: 'status', data: { status: 'disconnected' } }),
        deps,
      ),
    ).not.toThrow();

    // catch ハンドラが走るまで 1 tick 待つ (unhandled rejection にならないこと)。
    await Promise.resolve();
    expect(onStreamDisconnected).toHaveBeenCalledTimes(1);
  });

  it('JSONとして壊れたmessageでも例外を投げず配信だけ行う', () => {
    expect(() => routeTikTokMessage('streamer', 'not-json', deps)).not.toThrow();

    expect(broadcastToClients).toHaveBeenCalledWith('streamer', 'not-json');
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
