import { PubSub, Topic, Subscription, Message } from '@google-cloud/pubsub';
import { logger } from '../utils/logger';
import { hashForLog } from '../utils/hash-for-log';
// Pub/Sub clientはgRPC status codeをerror.codeとして返す。
const GRPC_STATUS_NOT_FOUND = 5;
const GRPC_STATUS_ALREADY_EXISTS = 6;
// gRPC由来のunknownはcodeだけを安全に絞り込む。
function getGrpcErrorCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}
export interface TikTokEventMessage {
  type: 'comment' | 'gift' | 'follow' | 'share' | 'member' | 'subscribe' | 'status' | 'error';
  username: string;
  data: Record<string, unknown>;
  timestamp: string;
  instanceId: string;
}
export class PubSubService {
  private pubsub: PubSub;
  private topic: Topic | null = null;
  private subscription: Subscription | null = null;
  private topicName: string;
  private subscriptionName: string;
  private instanceId: string;
  private messageHandlers: Map<string, (message: TikTokEventMessage) => Promise<void> | void> = new Map();
  private initialized = false;
  private closing = false;
  private readonly subscriptionExpirationTtlSeconds: number;
  private readonly deleteSubscriptionOnClose: boolean;
  private readonly MAX_PUBLISH_RETRIES = 3;
  private readonly PUBLISH_RETRY_DELAY_MS = 1000;

  constructor(projectId: string, instanceId: string) {
    this.pubsub = new PubSub({ projectId });
    this.topicName = process.env.PUBSUB_TOPIC_NAME || 'tiktok-events';
    // サブスクリプションは必ずインスタンスごとに分離（pull型で各インスタンスが全メッセージを受信するため）
    const baseSubName = process.env.PUBSUB_SUBSCRIPTION_NAME || 'tiktok-events-sub';
    this.subscriptionName = `${baseSubName}-${instanceId}`;
    this.instanceId = instanceId;
    this.subscriptionExpirationTtlSeconds = this.parsePositiveInt(
      process.env.PUBSUB_SUBSCRIPTION_EXPIRATION_TTL_SECONDS, 86400,
    );
    this.deleteSubscriptionOnClose = process.env.PUBSUB_DELETE_SUBSCRIPTION_ON_CLOSE !== 'false';

    if (process.env.PUBSUB_EMULATOR_HOST) {
      logger.info(`Pub/Subエミュレータ: ${process.env.PUBSUB_EMULATOR_HOST}`);
    }
  }

  async initialize(): Promise<void> {
    try {
      // production topicはTerraform所有とし、runtimeにはsubscription権限だけを与える。
      this.topic = this.pubsub.topic(this.topicName);
      // EmulatorにはTerraformがtopicを作らないため、local/CIだけruntimeで補う。
      if (process.env.PUBSUB_EMULATOR_HOST) await this.ensureEmulatorTopic();
      logger.info(`Pub/Subトピック: ${this.topicName}`);

      this.subscription = await this.getOrCreateSubscription();
      logger.info(`Pub/Subサブスクリプション: ${this.subscriptionName}`);

      this.startListening();
      this.initialized = true;
    } catch (error) {
      logger.error('Pub/Sub初期化エラー:', error);
      throw error;
    }
  }

  private async ensureEmulatorTopic(): Promise<void> {
    if (!this.topic) throw new Error('トピック未初期化');

    try {
      const [exists] = await this.topic.exists();
      if (!exists) {
        await this.topic.create();
        logger.info(`Emulatorトピック作成: ${this.topicName}`);
      }
    } catch (error: unknown) {
      // 複数のlocal instanceが同時起動した場合のcreate競合は成功扱いにする。
      if (getGrpcErrorCode(error) !== GRPC_STATUS_ALREADY_EXISTS) throw error;
    }
  }

  private async getOrCreateSubscription(): Promise<Subscription> {
    if (!this.topic) throw new Error('トピック未初期化');

    const subscription = this.topic.subscription(this.subscriptionName);

    const retryPolicy = { minimumBackoff: { seconds: 10 }, maximumBackoff: { seconds: 60 } };
    const expirationPolicy = { ttl: { seconds: this.subscriptionExpirationTtlSeconds } };

    try {
      const [exists] = await subscription.exists();
      if (exists) {
        // orphan削除保証のため既存policyの更新失敗も初期化失敗にする。
        await subscription.setMetadata({ retryPolicy, expirationPolicy });
        logger.debug(`既存サブスクリプションのpolicyを再設定: ${this.subscriptionName}`);
      } else {
        await subscription.create({
          ackDeadlineSeconds: 60,
          messageRetentionDuration: { seconds: 600 },
          // SIGTERMを処理できなくてもinstance固有subscriptionを残し続けない。
          expirationPolicy,
          retryPolicy,
        });
        logger.info(`サブスクリプション作成: ${this.subscriptionName}`);
      }
    } catch (error: unknown) {
      // 並行起動で他インスタンスが先に create した場合は ALREADY_EXISTS を無視
      if (getGrpcErrorCode(error) !== GRPC_STATUS_ALREADY_EXISTS) throw error;
    }

    return subscription;
  }

  private startListening(): void {
    if (!this.subscription) {
      logger.error('サブスクリプション未初期化');
      return;
    }

    // handleMessage内で例外処理が完結するためPromiseは明示的に破棄する。
    this.subscription.on('message', (message: Message) => { void this.handleMessage(message); });
    this.subscription.on('error', (error: Error) => {
      // subscription/client close直後に配送中streamの遅延errorが来ることがある。
      if (!this.closing) logger.error('Pub/Subエラー:', error);
    });
    logger.info('Pub/Subメッセージ受信開始');
  }

  private async handleMessage(message: Message): Promise<void> {
    try {
      const eventMessage: TikTokEventMessage = JSON.parse(message.data.toString());

      if (eventMessage.instanceId === this.instanceId) {
        message.ack();
        return;
      }

      // TikTok usernameは平文でログに残さない。
      logger.debug('Pub/Sub受信:', {
        type: eventMessage.type,
        usernameHash: hashForLog(eventMessage.username),
        from: eventMessage.instanceId,
      });

      const handler = this.messageHandlers.get(eventMessage.username);
      if (handler) {
        try {
          await handler(eventMessage);
        } catch (err) {
          logger.error('Pub/Subハンドラ失敗、nack:', err);
          message.nack();
          return;
        }
      }
      message.ack();
    } catch (error) {
      // parse 失敗はリトライしても解決しない永続エラーなので ack で破棄
      logger.error('Pub/Subメッセージ JSON parse 失敗、ack で破棄:', error);
      message.ack();
    }
  }

  async publishEvent(
    type: TikTokEventMessage['type'],
    username: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.topic || !this.initialized) {
      logger.warn('Pub/Sub未初期化のため発行スキップ');
      return;
    }

    const eventMessage: TikTokEventMessage = {
      type,
      username,
      data,
      timestamp: new Date().toISOString(),
      instanceId: this.instanceId,
    };

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.MAX_PUBLISH_RETRIES; attempt++) {
      try {
        await this.topic.publishMessage({
          data: Buffer.from(JSON.stringify(eventMessage)),
          attributes: { type, username, instanceId: this.instanceId },
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`Pub/Sub発行失敗 (${attempt}/${this.MAX_PUBLISH_RETRIES}):`, lastError.message);

        if (attempt < this.MAX_PUBLISH_RETRIES) await this.sleep(this.PUBLISH_RETRY_DELAY_MS * attempt);
      }
    }

    logger.error('Pub/Sub発行リトライ上限:', lastError);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  subscribe(username: string, handler: (message: TikTokEventMessage) => Promise<void> | void): () => void {
    this.messageHandlers.set(username, handler);
    logger.info(`Pub/Sub購読: ${hashForLog(username)}`);
    return () => {
      this.messageHandlers.delete(username);
      logger.info(`Pub/Sub購読解除: ${hashForLog(username)}`);
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.initialized = false;

    try {
      // subscription close前にpublisher batchをflushし、SIGTERM時の未送信ロスを防ぐ。
      if (this.topic && typeof this.topic.flush === 'function') {
        try {
          await this.topic.flush();
        } catch (flushErr) {
          logger.warn('Pub/Sub topic.flush 失敗:', flushErr);
        }
      }

      if (this.subscription) {
        await this.subscription.close();
        if (this.deleteSubscriptionOnClose) {
          await this.deleteSubscription();
        }
      }
    } catch (error) {
      logger.error('Pub/Subクローズエラー:', error);
    } finally {
      try {
        await this.pubsub.close();
      } catch (error) {
        logger.warn('Pub/Sub clientクローズエラー:', error);
      }
      this.topic = null;
      this.subscription = null;
      this.messageHandlers.clear();
    }
  }

  isHealthy(): boolean {
    return this.initialized && this.topic !== null && this.subscription !== null;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  private async deleteSubscription(): Promise<void> {
    if (!this.subscription) return;

    try {
      await this.subscription.delete();
      logger.info(`Pub/Subサブスクリプション削除: ${this.subscriptionName}`);
    } catch (error: unknown) {
      // 既に削除済み (NOT_FOUND) は無視 (idempotent な close 動作にするため)
      if (getGrpcErrorCode(error) === GRPC_STATUS_NOT_FOUND) {
        logger.debug(`Pub/Subサブスクリプション削除済み: ${this.subscriptionName}`);
        return;
      }
      throw error;
    }
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
