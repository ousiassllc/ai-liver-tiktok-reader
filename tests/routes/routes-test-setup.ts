import { mock, jest, afterAll } from 'bun:test';
// bun の mock.module はプロセス全体に永続し、mock.restore() でも元に戻らない
// (jest.mock はファイルスコープだったのでこの後始末は不要だった)。namespace
// import は live binding で書き換えが遡るため、スプレッドで値を退避しておき
// ファイル末尾で再登録して他テストへの汚染を打ち消す。
import * as realConnectionManagerNs from '../../src/services/connection-manager';
import * as realLoggerNs from '../../src/utils/logger';
const realConnectionManager = { ...realConnectionManagerNs };
const realLogger = { ...realLoggerNs };
import { WebSocket } from 'ws';

// bun の mock.module は factory 必須 (jest の自動モック相当が無い)。
// テストは setConnectionManager で別途スタブを注入するため、ここでは
// import 時の副作用を避けるためにクラスを空のコンストラクタへ置き換える。
mock.module('../../src/services/connection-manager', () => ({
  ConnectionManager: jest.fn(),
}));
mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

const {
  setupWebSocketRoutes,
  handleWebSocketConnection,
  setConnectionManager,
  setWebSocketRateLimiter,
  setRenderTokenVerifier
} = require('../../src/routes');

export {
  handleWebSocketConnection,
  setConnectionManager,
  setupWebSocketRoutes,
  setWebSocketRateLimiter,
  setRenderTokenVerifier,
  WebSocket
};

export function createRouteUpgradeTestContext() {
  const mockWss = {
    handleUpgrade: jest.fn(),
    emit: jest.fn()
  };

  const mockSocket = {
    write: jest.fn(),
    destroy: jest.fn()
  };

  jest.clearAllMocks();

  return {
    mockWss,
    mockSocket,
    mockHead: Buffer.from(''),
    request: (
      url: string | undefined,
      host = 'localhost:8472',
      extraHeaders: Record<string, string> = {},
      remoteAddress = '127.0.0.1'
    ) => ({
      url,
      headers: {
        ...(host ? { host } : {}),
        ...extraHeaders
      },
      socket: { remoteAddress }
    })
  };
}

export function createMockConnectionManager() {
  return {
    addClient: jest.fn().mockResolvedValue(undefined),
    removeClient: jest.fn().mockResolvedValue(undefined),
    cleanupConnection: jest.fn().mockResolvedValue(undefined),
    closeAll: jest.fn().mockResolvedValue(undefined),
    getConnectionCount: jest.fn().mockReturnValue(0),
    getClientCount: jest.fn().mockReturnValue(0),
    getTotalClientCount: jest.fn().mockReturnValue(0),
    isLeader: jest.fn().mockReturnValue(false),
    getStatus: jest.fn().mockReturnValue({ connections: 0, clients: 0, leaders: 0 }),
  };
}

export function createRouteConnectionTestContext() {
  const mockWs = {
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    readyState: WebSocket.OPEN
  };
  const mockConnectionManager = createMockConnectionManager();

  setConnectionManager(mockConnectionManager);
  jest.clearAllMocks();

  return { mockWs, mockConnectionManager };
}

afterAll(() => {
  mock.module('../../src/services/connection-manager', () => realConnectionManager);
  mock.module('../../src/utils/logger', () => realLogger);
});
