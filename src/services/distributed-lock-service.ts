import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import type { Firestore } from '@google-cloud/firestore';
import { logger } from '../utils/logger';
import { hashForLog } from '../utils/hash-for-log';
import { FirestoreLockStore } from './lock/firestore-lock-store';

interface LocalLease {
  leaseId: string;
  lastRefreshSuccessAtMs: number;
}

const GRPC_STATUS_ABORTED = 10;

function getGrpcStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

export interface DistributedLockServiceOptions {
  firestore?: Firestore;
  leaseDurationMs?: number;
  refreshIntervalMs?: number;
  lockLossTimeoutMs?: number;
  transactionTimeoutMs?: number;
  now?: () => number;
}

/** Firestore transactionを使ったTikTok username単位の分散lease lifecycle。 */
export class DistributedLockService {
  private readonly store: FirestoreLockStore;
  private readonly localLeases = new Map<string, LocalLease>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly refreshCycles = new Map<string, symbol>();
  private readonly refreshIntervalMs: number;
  private readonly lockLossTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly projectId: string,
    collectionName: string,
    private readonly instanceId: string,
    options: DistributedLockServiceOptions = {},
  ) {
    this.store = new FirestoreLockStore(projectId, collectionName, {
      firestore: options.firestore,
      leaseDurationMs: options.leaseDurationMs ?? 15_000,
      transactionTimeoutMs: options.transactionTimeoutMs ?? 5_000,
    });
    this.refreshIntervalMs = options.refreshIntervalMs ?? 5_000;
    this.lockLossTimeoutMs = options.lockLossTimeoutMs ?? 10_000;
    // refresh失敗の継続時間はwall clock補正の影響を受けない単調時計で測る。
    this.now = options.now ?? (() => performance.now());
  }

  async acquireLock(username: string): Promise<boolean> {
    try {
      const acquiredLeaseId = await this.store.acquire(
        username,
        this.instanceId,
        randomUUID(),
        this.localLeases.get(username)?.leaseId,
      );

      if (!acquiredLeaseId) {
        // ownership mismatchが確定したため、同じusernameの古いlocal lease/refreshを残さない。
        if (this.localLeases.has(username)) {
          this.stopLockRefresh(username);
          this.localLeases.delete(username);
        }
        logger.debug(`ロック取得失敗: ${hashForLog(username)}`);
        return false;
      }

      this.localLeases.set(username, {
        leaseId: acquiredLeaseId,
        lastRefreshSuccessAtMs: this.now(),
      });
      logger.info(`ロック取得: ${hashForLog(username)}`);
      return true;
    } catch (error) {
      // 同一documentへの競合がSDK retry上限を超えたABORTEDは、別instanceが
      // winnerになった通常系として扱う。障害だけをerrorログへ残す。
      if (getGrpcStatusCode(error) === GRPC_STATUS_ABORTED) {
        logger.debug(`Firestoreロック取得競合: ${hashForLog(username)}`);
      } else {
        logger.error('Firestoreロック取得エラー:', error);
      }
      return false;
    }
  }

  async releaseLock(username: string): Promise<boolean> {
    const local = this.localLeases.get(username);
    if (!local) {
      logger.warn(`ロック解放失敗（ローカルleaseなし）: ${hashForLog(username)}`);
      return false;
    }

    try {
      const released = await this.store.release(username, this.instanceId, local.leaseId);
      if (released) {
        logger.info(`ロック解放: ${hashForLog(username)}`);
      } else {
        logger.warn(`ロック解放失敗（所有権なし）: ${hashForLog(username)}`);
      }
      return released;
    } catch (error) {
      logger.error('Firestoreロック解放エラー:', error);
      return false;
    } finally {
      // 解放RPC中に新しいleaseへ切り替わっていた場合、そのleaseは消さない。
      if (this.localLeases.get(username) === local) this.localLeases.delete(username);
    }
  }

  async refreshLock(username: string): Promise<boolean> {
    const local = this.localLeases.get(username);
    if (!local) return false;

    try {
      const refreshed = await this.store.refresh(username, this.instanceId, local.leaseId);
      if (!refreshed) {
        // 古いrefresh RPCの遅延完了で、後から取得したleaseを消さない。
        if (this.localLeases.get(username) === local) this.localLeases.delete(username);
        logger.warn(`ロック延長失敗（所有権喪失または期限切れ）: ${hashForLog(username)}`);
        return false;
      }

      if (this.localLeases.get(username) === local) local.lastRefreshSuccessAtMs = this.now();
      logger.debug(`ロック延長: ${hashForLog(username)}`);
      return true;
    } catch (error) {
      logger.error(`Firestoreロック延長エラー: ${hashForLog(username)}`, error);
      throw error;
    }
  }

  startLockRefresh(username: string, onLockLost?: () => void): void {
    this.stopLockRefresh(username);

    if (!this.localLeases.has(username)) {
      logger.warn(`ロック自動更新開始失敗（ローカルleaseなし）: ${hashForLog(username)}`);
      onLockLost?.();
      return;
    }

    const cycle = Symbol(username);
    this.refreshCycles.set(username, cycle);

    const loseLock = (): void => {
      if (this.refreshCycles.get(username) !== cycle) return;
      logger.warn(`ロック喪失検出: ${hashForLog(username)}`);
      this.stopLockRefresh(username);
      this.localLeases.delete(username);
      try {
        onLockLost?.();
      } catch (error) {
        logger.error(`ロック喪失callbackエラー: ${hashForLog(username)}`, error);
      }
    };

    const schedule = (): void => {
      if (this.refreshCycles.get(username) !== cycle) return;
      const timeout = setTimeout(() => void tick(), this.refreshIntervalMs);
      this.refreshTimers.set(username, timeout);
    };

    const tick = async (): Promise<void> => {
      if (this.refreshCycles.get(username) !== cycle) return;

      try {
        if (!await this.refreshLock(username)) {
          loseLock();
          return;
        }
      } catch (error) {
        logger.error(`ロック自動更新中の例外: ${hashForLog(username)}`, error);
        const lastSuccess = this.localLeases.get(username)?.lastRefreshSuccessAtMs;
        if (lastSuccess === undefined || this.now() - lastSuccess >= this.lockLossTimeoutMs) {
          loseLock();
          return;
        }
      }

      schedule();
    };

    schedule();
    logger.info(`ロック自動更新開始: ${hashForLog(username)}`);
  }

  stopLockRefresh(username?: string): void {
    if (username) {
      const timeout = this.refreshTimers.get(username);
      if (timeout) clearTimeout(timeout);
      this.refreshTimers.delete(username);
      this.refreshCycles.delete(username);
      logger.debug(`ロック自動更新停止: ${hashForLog(username)}`);
      return;
    }

    for (const timeout of this.refreshTimers.values()) clearTimeout(timeout);
    this.refreshTimers.clear();
    this.refreshCycles.clear();
  }

  async getLockHolder(username: string): Promise<string | null> {
    try {
      return await this.store.getHolder(username);
    } catch (error) {
      logger.error('Firestoreロックホルダー取得エラー:', error);
      return null;
    }
  }

  async isLeader(username: string): Promise<boolean> {
    const local = this.localLeases.get(username);
    if (!local) return false;

    try {
      return await this.store.isOwner(username, this.instanceId, local.leaseId);
    } catch (error) {
      logger.error('Firestoreリーダー確認エラー:', error);
      return false;
    }
  }

  isHealthy(): Promise<boolean> {
    return this.store.isHealthy();
  }

  waitForReady(timeoutMs = 10_000): Promise<void> {
    return this.store.waitForReady(timeoutMs);
  }

  async close(): Promise<void> {
    this.stopLockRefresh();
    this.localLeases.clear();
    await this.store.close();
    logger.info('Firestore接続クローズ');
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getProjectId(): string {
    return this.projectId;
  }
}
