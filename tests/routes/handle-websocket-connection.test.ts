import { describe, it, expect } from 'bun:test';
import {
  createRouteConnectionTestContext,
  handleWebSocketConnection,
  setConnectionManager
} from './routes-test-setup';
import { UNRESTRICTED_SCOPE } from '../../src/routes/auth';

describe('Routes - handleWebSocketConnection', () => {
  it('should setup message handler', () => {
    const { mockWs } = createRouteConnectionTestContext();

    handleWebSocketConnection(mockWs);

    expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('should setup close handler', () => {
    const { mockWs } = createRouteConnectionTestContext();

    handleWebSocketConnection(mockWs);

    expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('should setup error handler', () => {
    const { mockWs } = createRouteConnectionTestContext();

    handleWebSocketConnection(mockWs);

    expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('should call handleClose on WebSocket error', async () => {
    const { mockWs, mockConnectionManager } = createRouteConnectionTestContext();
    handleWebSocketConnection(mockWs, undefined, UNRESTRICTED_SCOPE);

    // handleClose は「登録済みクライアントの解放」なので、先に connect を通して
    // currentUsername を確立しておかないと removeClient まで到達しない。
    // これを省くと error handler から handleClose を消しても検知できなくなる。
    const messageHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'message')![1];
    await messageHandler(
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          liveUrl: 'https://www.tiktok.com/@testuser/live',
          sessionId: 'session-1'
        })
      )
    );
    expect(mockConnectionManager.addClient).toHaveBeenCalledWith('testuser', mockWs, 'session-1');

    const errorHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'error')![1];

    const testError = new Error('Test error');
    await errorHandler(testError);

    // WebSocket エラー時に接続を解放しないと TikTok 接続と分散ロックが残留する。
    expect(mockConnectionManager.removeClient).toHaveBeenCalledTimes(1);
    expect(mockConnectionManager.removeClient).toHaveBeenCalledWith('testuser', mockWs);
  });

  it('should close WebSocket when ConnectionManager is not initialized', () => {
    const { mockWs } = createRouteConnectionTestContext();
    setConnectionManager(null as any);

    handleWebSocketConnection(mockWs);

    expect(mockWs.close).toHaveBeenCalledWith(1011, 'Server not ready');
    expect(mockWs.on).not.toHaveBeenCalled();
  });

  it('Issue #2782: 認証 scope を持たない接続は connect を受理しない', async () => {
    const { mockWs, mockConnectionManager } = createRouteConnectionTestContext();
    handleWebSocketConnection(mockWs);

    const messageHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'message')![1];
    await messageHandler(
      Buffer.from(
        JSON.stringify({
          type: 'connect',
          liveUrl: 'https://www.tiktok.com/@testuser/live',
          sessionId: 'session-1'
        })
      )
    );

    expect(mockConnectionManager.addClient).not.toHaveBeenCalled();
  });
});
