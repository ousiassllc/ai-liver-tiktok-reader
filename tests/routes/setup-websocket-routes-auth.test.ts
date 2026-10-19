import { describe, it, expect, afterEach } from 'bun:test';
import {
  createRouteUpgradeTestContext,
  setupWebSocketRoutes
} from './routes-test-setup';

/**
 * refine-sweep iter-1 backend CRITICAL:
 * /ws/events は TikTok Live 接続を任意のユーザーに張らせられるため、
 * TIKTOK_READER_SHARED_SECRET が設定されている場合は
 * X-Reader-Secret ヘッダまたは ?secret= クエリで受け取った値と照合する。
 */
describe('Routes - setupWebSocketRoutes shared secret auth', () => {
  const ORIGINAL_SECRET = process.env.TIKTOK_READER_SHARED_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.TIKTOK_READER_SHARED_SECRET;
    } else {
      process.env.TIKTOK_READER_SHARED_SECRET = ORIGINAL_SECRET;
    }
  });

  it('rejects an unauthenticated connection when TIKTOK_READER_SHARED_SECRET is unset', () => {
    delete process.env.TIKTOK_READER_SHARED_SECRET;
    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

    setupWebSocketRoutes(mockWss, request('/ws/events'), mockSocket, mockHead);

    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n');
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects connection with missing secret when TIKTOK_READER_SHARED_SECRET is set', () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'super-secret-value';
    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

    setupWebSocketRoutes(mockWss, request('/ws/events'), mockSocket, mockHead);

    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n');
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects connection with wrong secret header', () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'super-secret-value';
    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

    setupWebSocketRoutes(
      mockWss,
      request('/ws/events', 'localhost:8472', { 'x-reader-secret': 'wrong-secret' }),
      mockSocket,
      mockHead
    );

    expect(mockWss.handleUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.destroy).toHaveBeenCalledTimes(1);
  });

  it('accepts connection with correct X-Reader-Secret header', () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'super-secret-value';
    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

    setupWebSocketRoutes(
      mockWss,
      request('/ws/events', 'localhost:8472', { 'x-reader-secret': 'super-secret-value' }),
      mockSocket,
      mockHead
    );

    expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(mockSocket.destroy).not.toHaveBeenCalled();
  });

  it('accepts connection with correct ?secret= query parameter', () => {
    process.env.TIKTOK_READER_SHARED_SECRET = 'super-secret-value';
    const { mockWss, mockSocket, mockHead, request } = createRouteUpgradeTestContext();

    setupWebSocketRoutes(
      mockWss,
      request('/ws/events?secret=super-secret-value'),
      mockSocket,
      mockHead
    );

    expect(mockWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(mockSocket.destroy).not.toHaveBeenCalled();
  });
});
