import { describe, it, expect, beforeEach, afterAll, mock, jest } from 'bun:test';
import { PubSubService, TikTokEventMessage } from '../../src/services/pubsub-service';
import * as realLoggerNs from '../../src/utils/logger';

const realLogger = { ...realLoggerNs };

mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// PubSub クライアントをモック
mock.module('@google-cloud/pubsub', () => {
  return {
    PubSub: jest.fn().mockImplementation(() => ({
      topic: jest.fn(),
    })),
  };
});

const INSTANCE_ID = 'test-instance';
const OTHER_INSTANCE_ID = 'other-instance';

interface MockMessage {
  data: Buffer;
  ack: jest.Mock;
  nack: jest.Mock;
}

function buildMessage(event: Partial<TikTokEventMessage> & { instanceId: string }): MockMessage {
  const eventMessage: TikTokEventMessage = {
    type: event.type ?? 'comment',
    username: event.username ?? 'someuser',
    data: event.data ?? { hello: 'world' },
    timestamp: event.timestamp ?? new Date().toISOString(),
    instanceId: event.instanceId,
  };
  return {
    data: Buffer.from(JSON.stringify(eventMessage)),
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

function buildInvalidMessage(): MockMessage {
  return {
    data: Buffer.from('not a valid json'),
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

describe('PubSubService.handleMessage', () => {
  let service: PubSubService;

  beforeEach(() => {
    service = new PubSubService('test-project', INSTANCE_ID);
    jest.clearAllMocks();
  });

  it('Emulatorでtopicがない場合だけ作成する', async () => {
    const topic = {
      exists: jest.fn().mockResolvedValue([false]),
      create: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).topic = topic;

    await (service as any).ensureEmulatorTopic();

    expect(topic.exists).toHaveBeenCalledTimes(1);
    expect(topic.create).toHaveBeenCalledTimes(1);
  });

  it('既存のinstance subscriptionへretryと24時間expirationを再設定する', async () => {
    const subscription = {
      exists: jest.fn().mockResolvedValue([true]),
      setMetadata: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).topic = {
      subscription: jest.fn().mockReturnValue(subscription),
    };

    await (service as any).getOrCreateSubscription();

    expect(subscription.setMetadata).toHaveBeenCalledWith({
      retryPolicy: {
        minimumBackoff: { seconds: 10 },
        maximumBackoff: { seconds: 60 },
      },
      expirationPolicy: { ttl: { seconds: 86400 } },
    });
  });

  it('既存subscriptionのexpiration更新失敗を初期化元へ伝播する', async () => {
    const updateError = new Error('permission denied');
    const subscription = {
      exists: jest.fn().mockResolvedValue([true]),
      setMetadata: jest.fn().mockRejectedValue(updateError),
    };
    (service as any).topic = {
      subscription: jest.fn().mockReturnValue(subscription),
    };

    await expect((service as any).getOrCreateSubscription()).rejects.toBe(updateError);
  });

  it('自インスタンス由来メッセージは即 ack（ハンドラ呼ばない）', async () => {
    const handler = jest.fn();
    service.subscribe('someuser', handler);

    const message = buildMessage({
      instanceId: INSTANCE_ID,
      username: 'someuser',
    });

    await (service as any).handleMessage(message);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.nack).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler が resolve すると ack が呼ばれる', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    service.subscribe('someuser', handler);

    const message = buildMessage({
      instanceId: OTHER_INSTANCE_ID,
      username: 'someuser',
    });

    await (service as any).handleMessage(message);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.nack).not.toHaveBeenCalled();
  });

  it('handler が同期で正常終了すると ack が呼ばれる', async () => {
    const handler = jest.fn(); // returns undefined synchronously
    service.subscribe('someuser', handler);

    const message = buildMessage({
      instanceId: OTHER_INSTANCE_ID,
      username: 'someuser',
    });

    await (service as any).handleMessage(message);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.nack).not.toHaveBeenCalled();
  });

  it('handler が async で reject すると nack が呼ばれる（ack は呼ばれない）', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('handler error'));
    service.subscribe('someuser', handler);

    const message = buildMessage({
      instanceId: OTHER_INSTANCE_ID,
      username: 'someuser',
    });

    await (service as any).handleMessage(message);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(message.nack).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('handler が同期で throw すると nack が呼ばれる', async () => {
    const handler = jest.fn(() => {
      throw new Error('sync handler error');
    });
    service.subscribe('someuser', handler);

    const message = buildMessage({
      instanceId: OTHER_INSTANCE_ID,
      username: 'someuser',
    });

    await (service as any).handleMessage(message);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(message.nack).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('JSON parse 失敗で ack（リトライ不可能な永続エラーとして破棄）', async () => {
    const message = buildInvalidMessage();

    await (service as any).handleMessage(message);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.nack).not.toHaveBeenCalled();
  });

  it('未登録ユーザー宛のメッセージでも ack（ハンドラ未登録は無視）', async () => {
    const message = buildMessage({
      instanceId: OTHER_INSTANCE_ID,
      username: 'unsubscribed-user',
    });

    await (service as any).handleMessage(message);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.nack).not.toHaveBeenCalled();
  });

});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
});
