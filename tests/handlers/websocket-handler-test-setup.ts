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
import { UNRESTRICTED_SCOPE, type WebSocketAuthScope } from '../../src/routes/auth';

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

const { WebSocketHandler } = require('../../src/handlers/websocket-handler');

export { WebSocket, WebSocketHandler };

export interface WebSocketHandlerTestContext {
  handler: any;
  mockWs: {
    send: jest.Mock;
    close: jest.Mock;
    readyState: number;
  };
  mockConnectionManager: {
    addClient: jest.Mock;
    removeClient: jest.Mock;
    cleanupConnection: jest.Mock;
    closeAll: jest.Mock;
    getConnectionCount: jest.Mock;
    getClientCount: jest.Mock;
    getTotalClientCount: jest.Mock;
    isLeader: jest.Mock;
    getStatus: jest.Mock;
  };
}

export function createWebSocketHandlerTestContext(
  scope: WebSocketAuthScope = UNRESTRICTED_SCOPE
): WebSocketHandlerTestContext {
  const mockConnectionManager = {
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

  const handler = new WebSocketHandler(mockConnectionManager, scope);
  const mockWs = {
    send: jest.fn(),
    close: jest.fn(),
    readyState: WebSocket.OPEN
  };

  jest.clearAllMocks();

  return { handler, mockWs, mockConnectionManager };
}

afterAll(() => {
  mock.module('../../src/services/connection-manager', () => realConnectionManager);
  mock.module('../../src/utils/logger', () => realLogger);
});
