import { describe, it, expect, afterEach, beforeAll, afterAll, mock, jest } from 'bun:test';
// bun の mock.module はプロセス全体に永続し、mock.restore() でも元に戻らない
// (jest.mock はファイルスコープだったのでこの後始末は不要だった)。namespace
// import は live binding で書き換えが遡るため、スプレッドで値を退避しておき
// ファイル末尾で再登録して他テストへの汚染を打ち消す。
import * as realConnectionManagerNs from '../../src/services/connection-manager';
const realConnectionManager = { ...realConnectionManagerNs };
import type { Mocked } from '../support/bun-test-types';
import { WebSocket } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';
import { setupWebSocketRoutes, handleWebSocketConnection, setConnectionManager } from '../../src/routes';
import { ConnectionManager } from '../../src/services/connection-manager';

// ConnectionManagerをモック
// bun の mock.module は factory 必須 (jest の自動モック相当が無い)。
// テストは setConnectionManager で別途スタブを注入するため、ここでは
// import 時の副作用を避けるためにクラスを空のコンストラクタへ置き換える。
mock.module('../../src/services/connection-manager', () => ({
  ConnectionManager: jest.fn(),
}));

describe('WebSocket Integration Test', () => {
  let httpServer: HttpServer;
  let wss: WebSocketServer;
  let client: WebSocket;
  let mockConnectionManager: Mocked<ConnectionManager>;
  const TEST_PORT = 18472; // テスト用のポート
  const TEST_SECRET = 'integration-test-secret';
  const authorizedOptions = { headers: { 'x-reader-secret': TEST_SECRET } };

  beforeAll((done) => {
    process.env.TIKTOK_READER_SHARED_SECRET = TEST_SECRET;
    // モックConnectionManagerを作成して設定
    mockConnectionManager = {
      addClient: jest.fn().mockResolvedValue(undefined),
      removeClient: jest.fn().mockResolvedValue(undefined),
      cleanupConnection: jest.fn().mockResolvedValue(undefined),
      closeAll: jest.fn().mockResolvedValue(undefined),
      getConnectionCount: jest.fn().mockReturnValue(0),
      getClientCount: jest.fn().mockReturnValue(0),
      getTotalClientCount: jest.fn().mockReturnValue(0),
      isLeader: jest.fn().mockReturnValue(false),
      getStatus: jest.fn().mockReturnValue({ connections: 0, clients: 0, leaders: 0 }),
    } as any;

    setConnectionManager(mockConnectionManager);

    // テスト用サーバーを起動
    httpServer = createServer();
    wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
      setupWebSocketRoutes(wss, request, socket, head);
    });

    wss.on('connection', handleWebSocketConnection);

    httpServer.listen(TEST_PORT, () => {
      done();
    });
  });

  afterAll((done) => {
    delete process.env.TIKTOK_READER_SHARED_SECRET;
    // サーバーを停止
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }

    wss.close(() => {
      httpServer.close(() => {
        done();
      });
    });
  });

  afterEach(() => {
    // 各テスト後にクライアントを閉じる
    if (client && client.readyState === WebSocket.OPEN) {
      client.close();
    }
    jest.clearAllMocks();
  });

  it('should establish WebSocket connection', (done) => {
    client = new WebSocket(`ws://localhost:${TEST_PORT}/ws/events`, authorizedOptions);

    client.on('open', () => {
      expect(client.readyState).toBe(WebSocket.OPEN);
      done();
    });

    client.on('error', (error) => {
      done(error);
    });
  });

  it('should reject connection to invalid path', (done) => {
    client = new WebSocket(`ws://localhost:${TEST_PORT}/invalid-path`);

    client.on('error', (error) => {
      expect(error).toBeDefined();
      done();
    });

    client.on('open', () => {
      done(new Error('Should not connect to invalid path'));
    });
  });

  it('should receive error for invalid connect message', (done) => {
    client = new WebSocket(`ws://localhost:${TEST_PORT}/ws/events`, authorizedOptions);

    client.on('open', () => {
      // URL解析で確実に失敗するURLを送信（@もusernameもない）
      client.send(JSON.stringify({
        type: 'connect',
        liveUrl: 'https://www.example.com/invalid/path',
        sessionId: 'test-123'
      }));
    });

    client.on('message', (data) => {
      const message = JSON.parse(data.toString());

      if (message.type === 'error') {
        // spec api.md: error メッセージは data: { code, message } のネスト形式
        expect(message.data.code).toBe('INVALID_URL');
        expect(message.data.message).toBeDefined();
        clearTimeout(timeoutId);
        done();
      }
    });

    // タイムアウト設定
    const timeoutId: NodeJS.Timeout = setTimeout(() => {
      done(new Error('Timeout waiting for response'));
    }, 5000);
  });

  it('should call ConnectionManager.addClient for valid URL', (done) => {
    client = new WebSocket(`ws://localhost:${TEST_PORT}/ws/events`, authorizedOptions);

    // Issue #2512: ConnectionManagerがモックなのでレスポンスは来ない。固定 500ms 待って
    // から呼び出しを確認すると低スペック環境で間に合わず flaky になるため、mock 呼び出し
    // そのものを Promise 化して待つ（実イベントを待つ・タイムアウトは安全弁のみ）。
    let resolveCalled: () => void;
    const addClientCalled = new Promise<void>((resolve) => {
      resolveCalled = resolve;
    });
    mockConnectionManager.addClient.mockImplementationOnce(() => {
      resolveCalled();
      return Promise.resolve(undefined);
    });

    client.on('open', () => {
      // 有効なURL形式を送信
      client.send(JSON.stringify({
        type: 'connect',
        liveUrl: 'https://www.tiktok.com/@testuser/live',
        sessionId: 'test-session-123'
      }));
    });

    const timeoutId = setTimeout(() => {
      done(new Error('Timeout waiting for ConnectionManager.addClient to be called'));
    }, 5000);

    addClientCalled.then(() => {
      clearTimeout(timeoutId);
      expect(mockConnectionManager.addClient).toHaveBeenCalledWith(
        'testuser',
        expect.any(Object),
        'test-session-123'
      );
      done();
    });
  });

  it('should handle multiple clients', (done) => {
    const client1 = new WebSocket(`ws://localhost:${TEST_PORT}/ws/events`, authorizedOptions);
    const client2 = new WebSocket(`ws://localhost:${TEST_PORT}/ws/events`, authorizedOptions);

    let client1Connected = false;
    let client2Connected = false;

    client1.on('open', () => {
      client1Connected = true;
      checkBothConnected();
    });

    client2.on('open', () => {
      client2Connected = true;
      checkBothConnected();
    });

    client1.on('error', (err) => {
      client1.close();
      client2.close();
      done(err);
    });

    client2.on('error', (err) => {
      client1.close();
      client2.close();
      done(err);
    });

    function checkBothConnected() {
      if (client1Connected && client2Connected) {
        expect(client1.readyState).toBe(WebSocket.OPEN);
        expect(client2.readyState).toBe(WebSocket.OPEN);

        client1.close();
        client2.close();
        done();
      }
    }
  });

  it('should handle WebSocket close gracefully', (done) => {
    client = new WebSocket(`ws://localhost:${TEST_PORT}/ws/events`, authorizedOptions);

    client.on('open', () => {
      client.close();
    });

    client.on('close', () => {
      expect(client.readyState).toBe(WebSocket.CLOSED);
      done();
    });
  });

  it('should handle invalid JSON message', (done) => {
    client = new WebSocket(`ws://localhost:${TEST_PORT}/ws/events`, authorizedOptions);

    client.on('open', () => {
      // 不正なJSONを送信
      client.send('not a valid json');
    });

    client.on('message', (data) => {
      const message = JSON.parse(data.toString());

      if (message.type === 'error') {
        // spec api.md: error メッセージは data: { code, message } のネスト形式
        expect(message.data.code).toBe('INVALID_MESSAGE');
        clearTimeout(timeoutId);
        done();
      }
    });

    // タイムアウト設定
    const timeoutId: NodeJS.Timeout = setTimeout(() => {
      done(new Error('Timeout waiting for error response'));
    }, 5000);
  });
});

afterAll(() => {
  mock.module('../../src/services/connection-manager', () => realConnectionManager);
});
