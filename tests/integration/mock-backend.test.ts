import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
// @ts-expect-error mock-backend.mjs は型宣言を持たない ESM
import { createMockBackend } from '../../examples/mock-backend.mjs';
import { BackendApiService } from '../../src/services/backend-api-service';

/**
 * Issue #2782: 単独起動例の mock backend が、reader の BackendApiService が持つ
 * 4 つの backend 契約を満たすことを、実際の HTTP で確認する。
 */
describe('examples/mock-backend (Issue #2782)', () => {
  let server: Server;
  let received: Array<{ kind: string; path: string; body: unknown }>;
  let service: BackendApiService;

  beforeAll(async () => {
    const mock = createMockBackend({
      ingressToken: 'ingress-1',
      sessions: { 'session-A': { renderToken: 'token-A', liveUrl: 'https://www.tiktok.com/@synthetic-streamer/live' } }
    });
    server = mock.server;
    received = mock.received;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.BACKEND_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    process.env.BACKEND_INGRESS_TOKEN = 'ingress-1';
    service = new BackendApiService();
  });

  afterAll(async () => {
    delete process.env.BACKEND_API_URL;
    delete process.env.BACKEND_INGRESS_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('正しい render token は platform / live_url 付きで検証できる', async () => {
    expect(await service.verifyRenderToken('token-A', 'session-A')).toEqual({
      valid: true,
      platform: 'tiktok',
      liveUrl: 'https://www.tiktok.com/@synthetic-streamer/live'
    });
  });

  it('別 session / 誤った token は valid=false', async () => {
    expect((await service.verifyRenderToken('token-A', 'session-B')).valid).toBe(false);
    expect((await service.verifyRenderToken('wrong', 'session-A')).valid).toBe(false);
  });

  it('gift / comment / viewer-count を ingress token 付きで受信できる', async () => {
    await service.sendGift({ session_id: 'session-A' } as never);
    await service.sendComment('session-A', {
      platform: 'tiktok',
      platform_comment_id: 'c1',
      platform_user_id: 'u1',
      username: 'synthetic-user',
      text: 'hello',
      received_at: '2026-01-01T00:00:00.000Z'
    });
    await service.sendViewerCount('session-A', 12);

    expect(received.map((r) => r.kind)).toEqual(['gift', 'comment', 'viewer-count']);
    expect(received[1].path).toBe('/api/v1/internal/tiktok-reader/session/session-A/comment');
  });
});
