import { describe, expect, it, jest } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ConnectionManager } from '../../src/services/connection-manager';
import type { DistributedLockService } from '../../src/services/distributed-lock-service';
import type { PubSubService } from '../../src/services/pubsub-service';
import { HealthHandler } from '../../src/handlers/health-handler';

function createResponse(): {
  response: ServerResponse;
  writeHead: jest.Mock;
  end: jest.Mock;
} {
  const writeHead = jest.fn();
  const end = jest.fn();
  return {
    response: { writeHead, end } as unknown as ServerResponse,
    writeHead,
    end,
  };
}

describe('HealthHandler readiness', () => {
  it('Firestoreの接続状態をchecks.lockStoreとして返す', async () => {
    const lockService = {
      isHealthy: jest.fn().mockResolvedValue(true),
    } as unknown as DistributedLockService;
    const pubsubService = {
      isHealthy: jest.fn().mockReturnValue(true),
    } as unknown as PubSubService;
    const handler = new HealthHandler({
      lockService,
      pubsubService,
      connectionManager: null as ConnectionManager | null,
      instanceId: 'instance-a',
    });
    const { response, writeHead, end } = createResponse();

    await handler.handleRequest({ url: '/ready' } as IncomingMessage, response);

    expect(writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    const payload = JSON.parse(end.mock.calls[0][0] as string);
    expect(payload.status).toBe('ready');
    expect(payload.checks).toEqual({ lockStore: true, pubsub: true });
    expect(payload.checks).not.toHaveProperty('redis');
  });

  it('Firestoreが利用不能なら503を返す', async () => {
    const lockService = {
      isHealthy: jest.fn().mockResolvedValue(false),
    } as unknown as DistributedLockService;
    const pubsubService = {
      isHealthy: jest.fn().mockReturnValue(true),
    } as unknown as PubSubService;
    const handler = new HealthHandler({
      lockService,
      pubsubService,
      connectionManager: null,
      instanceId: 'instance-a',
    });
    const { response, writeHead, end } = createResponse();

    await handler.handleRequest({ url: '/ready' } as IncomingMessage, response);

    expect(writeHead).toHaveBeenCalledWith(503, { 'Content-Type': 'application/json' });
    expect(JSON.parse(end.mock.calls[0][0] as string).status).toBe('not_ready');
  });
});

describe('HealthHandler /source と /status (Issue #2782)', () => {
  const handler = (connectionManager: ConnectionManager | null = null) =>
    new HealthHandler({ lockService: null, pubsubService: null, connectionManager, instanceId: 'instance-a' });

  it('/source はライセンス・稼働版・ソース URL を返す', async () => {
    process.env.SOURCE_COMMIT = 'abc1234';
    process.env.TIKTOK_READER_SOURCE_URL = 'https://example.invalid/source';
    try {
      const { response, writeHead, end } = createResponse();

      await handler().handleRequest({ url: '/source' } as IncomingMessage, response);

      expect(writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(JSON.parse(end.mock.calls[0][0] as string)).toEqual({
        license: 'AGPL-3.0-only',
        version: 'abc1234',
        sourceUrl: 'https://example.invalid/source',
      });
    } finally {
      delete process.env.SOURCE_COMMIT;
      delete process.env.TIKTOK_READER_SOURCE_URL;
    }
  });

  it('/source は SOURCE_COMMIT / URL が未設定なら unknown / null を返す', async () => {
    delete process.env.SOURCE_COMMIT;
    delete process.env.TIKTOK_READER_SOURCE_URL;
    const { response, end } = createResponse();

    await handler().handleRequest({ url: '/source' } as IncomingMessage, response);

    expect(JSON.parse(end.mock.calls[0][0] as string)).toEqual({
      license: 'AGPL-3.0-only',
      version: 'unknown',
      sourceUrl: null,
    });
  });

  it('認証なしの /status は配信者名を含まず leader 数を返す', async () => {
    const connectionManager = {
      getStatus: () => ({ connections: 1, clients: 2, leaders: 1, limits: {} }),
    } as unknown as ConnectionManager;
    const { response, end } = createResponse();

    await handler(connectionManager).handleRequest({ url: '/status' } as IncomingMessage, response);

    const payload = JSON.parse(end.mock.calls[0][0] as string);
    expect(payload.leaders).toBe(1);
  });
});
