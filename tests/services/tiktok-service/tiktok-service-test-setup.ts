import { mock, jest, afterAll } from 'bun:test';
import { WebSocket } from 'ws';
import * as realLoggerNs from '../../../src/utils/logger';

const realLogger = { ...realLoggerNs };

mock.module('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

mock.module('tiktok-live-connector', () => {
  return {
    TikTokLiveConnection: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      removeAllListeners: jest.fn()
    })),
    WebcastEvent: {
      CHAT: 'chat',
      GIFT: 'gift',
      FOLLOW: 'follow',
      SHARE: 'share',
      MEMBER: 'member',
      SUBSCRIBE: 'subscribe',
      SOCIAL: 'social',
      STREAM_END: 'streamEnd',
      // Issue #615: WebcastEvent.ROOM_USER を購読して viewerCount を扱うため
      // モックの WebcastEvent enum にも追加する。
      ROOM_USER: 'roomUser'
    },
    // refine-sweep iter-3 backend MAJOR: tiktok-service.ts が ControlEvent.ERROR を
    // 参照するようになったため、テスト用モックにも同じ shape を追加する。
    ControlEvent: {
      ERROR: 'error',
      CONNECTED: 'connected',
      DISCONNECTED: 'disconnected'
    },
    SignConfig: {
      apiKey: undefined
    }
  };
});

// refine-sweep iter-3 backend MAJOR: TikTokService が constructor で BackendApiService を
// 生成し、handleGift の際に POST /gift を呼ぶようになった。テスト時は axios がネットワークに
// 実際に飛ばないよう、BackendApiService を no-op モックに差し替えて DI する。
const { TikTokService } = require('../../../src/services/tiktok-service');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const { logger } = require('../../../src/utils/logger');

export { logger, TikTokLiveConnection, TikTokService, WebSocket };

export interface TikTokServiceTestContext {
  service: any;
  mockWs: {
    send: jest.Mock;
    close: jest.Mock;
    readyState: number;
  };
  mockBackendApi: {
    sendGift: jest.Mock;
    // Issue #615: TikTokService.handleRoomUser が backend に viewerCount を push する
    // ため、モック側にも sendViewerCount を用意して呼び出し検証できるようにする。
    sendViewerCount: jest.Mock;
    // Issue #2154: TikTokService.handleComment が backend にコメントを push する
    // ため、モック側にも sendComment を用意して呼び出し検証できるようにする。
    sendComment: jest.Mock;
  };
}

export function createTikTokServiceTestContext(): TikTokServiceTestContext {
  const mockWs = {
    send: jest.fn(),
    close: jest.fn(),
    readyState: WebSocket.OPEN
  };

  const mockBackendApi = {
    sendGift: jest.fn().mockResolvedValue(undefined),
    sendViewerCount: jest.fn().mockResolvedValue(undefined),
    sendComment: jest.fn().mockResolvedValue(undefined)
  };

  const service = new TikTokService(mockBackendApi);

  (service as any).ws = mockWs;
  (service as any).sessionId = 'session-123';

  jest.clearAllMocks();

  return { service, mockWs, mockBackendApi };
}

afterAll(() => {
  mock.module('../../../src/utils/logger', () => realLogger);
});
