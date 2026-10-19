import { logger } from '../../utils/logger';
import { hashForLog } from '../../utils/hash-for-log';
import { DistributedLockService } from '../distributed-lock-service';
import { ConnectionInfo } from './connection-types';

export class LeaderWatcher {
  private readonly intervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private readonly connections: Map<string, ConnectionInfo>,
    private readonly lockService: DistributedLockService,
    private readonly tryBecomeLeader: (username: string) => Promise<void>
  ) {}

  start(username: string): void {
    this.stop(username);

    let isChecking = false;

    const interval = setInterval(async () => {
      // 前回のチェックがまだ実行中の場合はスキップ
      if (isChecking) return;

      try {
        isChecking = true;

        const connection = this.connections.get(username);
        if (!connection || connection.isLeader || connection.connecting) return;

        const holder = await this.lockService.getLockHolder(username);

        if (!holder) {
          // refine-sweep iter-7 tiktok-reader MINOR: username は PII のため hashForLog 経由で出力する。
          logger.info(`リーダー不在を検出: ${hashForLog(username)}`);
          await this.tryBecomeLeader(username);
        }
      } catch (error) {
        logger.error(`リーダー監視エラー: ${hashForLog(username)}`, error);
      } finally {
        isChecking = false;
      }
    }, 3000);

    this.intervals.set(username, interval);
    logger.debug(`リーダー監視開始: ${hashForLog(username)}`);
  }

  stop(username: string): void {
    const interval = this.intervals.get(username);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(username);
      logger.debug(`リーダー監視停止: ${hashForLog(username)}`);
    }
  }

  stopAll(): void {
    for (const username of this.intervals.keys()) {
      this.stop(username);
    }
  }
}
