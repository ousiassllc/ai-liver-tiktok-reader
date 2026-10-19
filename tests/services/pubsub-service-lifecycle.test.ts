import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import * as realLoggerNs from '../../src/utils/logger';
import { PubSubService } from '../../src/services/pubsub-service';

const realLogger = { ...realLoggerNs };

mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

mock.module('@google-cloud/pubsub', () => ({
  PubSub: jest.fn().mockImplementation(() => ({
    topic: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('PubSubService lifecycle', () => {
  let service: PubSubService;

  beforeEach(() => {
    service = new PubSubService('test-project', 'test-instance');
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.PUBSUB_DELETE_SUBSCRIPTION_ON_CLOSE;
  });

  it('close時にインスタンス固有subscriptionを削除する', async () => {
    const subscription = {
      close: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).subscription = subscription;
    (service as any).initialized = true;

    await service.close();

    expect(subscription.close).toHaveBeenCalledTimes(1);
    expect(subscription.delete).toHaveBeenCalledTimes(1);
    expect(service.isHealthy()).toBe(false);
  });

  it('subscription削除後にPubSub clientをcloseする', async () => {
    const closeOrder: string[] = [];
    (service as any).pubsub = {
      close: jest.fn(async () => { closeOrder.push('pubsub.close'); }),
    };
    (service as any).subscription = {
      close: jest.fn(async () => { closeOrder.push('subscription.close'); }),
      delete: jest.fn(async () => { closeOrder.push('subscription.delete'); }),
    };

    await service.close();

    expect(closeOrder).toEqual([
      'subscription.close',
      'subscription.delete',
      'pubsub.close',
    ]);
    expect((service as any).subscription).toBeNull();
  });

  it('closeを複数回呼んでもshutdown処理は1回だけ実行する', async () => {
    const closeClient = jest.fn().mockResolvedValue(undefined);
    const closeSubscription = jest.fn().mockResolvedValue(undefined);
    (service as any).pubsub = { close: closeClient };
    (service as any).subscription = {
      close: closeSubscription,
      delete: jest.fn().mockResolvedValue(undefined),
    };

    await service.close();
    await service.close();

    expect(closeSubscription).toHaveBeenCalledTimes(1);
    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  it('delete=falseの場合はsubscriptionをcloseするだけにする', async () => {
    process.env.PUBSUB_DELETE_SUBSCRIPTION_ON_CLOSE = 'false';
    const noDeleteService = new PubSubService('test-project', 'test-instance');
    const subscription = {
      close: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    (noDeleteService as any).subscription = subscription;

    await noDeleteService.close();

    expect(subscription.close).toHaveBeenCalledTimes(1);
    expect(subscription.delete).not.toHaveBeenCalled();
  });

  it('subscription.close前にpublisher batchをflushする', async () => {
    const flushOrder: string[] = [];
    const topic = {
      flush: jest.fn(async () => { flushOrder.push('flush'); }),
    };
    const subscription = {
      close: jest.fn(async () => { flushOrder.push('subscription.close'); }),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).topic = topic;
    (service as any).subscription = subscription;

    await service.close();

    expect(topic.flush).toHaveBeenCalledTimes(1);
    expect(subscription.close).toHaveBeenCalledTimes(1);
    expect(flushOrder).toEqual(['flush', 'subscription.close']);
  });

  it('topic.flush失敗時もsubscription.closeを継続する', async () => {
    (service as any).topic = {
      flush: jest.fn().mockRejectedValue(new Error('flush failed')),
    };
    const subscription = {
      close: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).subscription = subscription;

    await expect(service.close()).resolves.toBeUndefined();
    expect(subscription.close).toHaveBeenCalledTimes(1);
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
});
