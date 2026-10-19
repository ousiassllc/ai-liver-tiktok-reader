import { logger } from '../../utils/logger';
import { hashForLog } from '../../utils/hash-for-log';
import { ConnectionInfo } from './connection-types';
import { DistributedLockService } from '../distributed-lock-service';

/**
 * 現在 isLeader なら TikTok Live からの分散ロックを解放して stopLockRefresh も止め、
 * connection.isLeader を false に戻す。
 *
 * `handleStreamEnd` / `handleLockLost` / `cleanupConnection` から重複して呼ばれるため、
 * Issue #773 で共通ヘルパーとして切り出した (connection-manager.ts の 300 行制限対応)。
 */
export async function releaseLeadershipIfHeld(
  username: string,
  connection: ConnectionInfo,
  lockService: DistributedLockService,
): Promise<void> {
  if (!connection.isLeader) return;
  // release transaction中に定期refreshが割り込まないよう、先に更新周期を止める。
  // local leaseはreleaseLockが参照するため、この時点ではまだ残っている。
  lockService.stopLockRefresh(username);
  // 現在の DistributedLockService.releaseLock は失敗時も throw せず false を返す実装だが、
  // それは型シグネチャ (Promise<boolean>) が保証するものではなく、テストでは意図的に
  // releaseLock を reject させて「呼び出し元が例外を握りつぶし、必ず leader 状態を
  // 解除できるか」を検証している (connection-result.test.ts の
  // 'cleans local state when TikTok disconnect and lock release fail')。
  // そのためこの try/catch は現状の実装に対しては到達しないが、契約違反や将来の実装変更に
  // 備えた防御境界として意図的に残しており、削除すると上記回帰テストが失敗する。
  try {
    await lockService.releaseLock(username);
  } catch (error) {
    logger.error(`分散ロック解放エラー: ${hashForLog(username)}`, error);
  } finally {
    connection.isLeader = false;
  }
}

/**
 * TikTok Live の切断処理を実施し、connection.tiktokService を null に戻す。
 * `handleStreamEnd` / `handleLockLost` / `cleanupConnection` から共通で使う。
 */
export async function disconnectTikTokServiceIfActive(
  connection: ConnectionInfo,
): Promise<void> {
  if (!connection.tiktokService) return;
  try {
    await connection.tiktokService.disconnect();
  } catch (error) {
    // SDK transport の切断失敗で map / lock の後始末まで止めない。
    logger.error('TikTok Live切断エラー:', error);
  } finally {
    connection.tiktokService = null;
  }
}

/**
 * TikTok Live 配信終了イベント検出時のハンドラ (spec 3-3-5-3-4: status='disconnected')。
 * TikTok 切断 + リーダー権限解放 (保持していれば) のみ実施する。
 */
export async function handleStreamEnd(
  username: string,
  connection: ConnectionInfo,
  lockService: DistributedLockService,
): Promise<void> {
  logger.info(`配信終了検出: ${hashForLog(username)}`);
  await disconnectTikTokServiceIfActive(connection);
  await releaseLeadershipIfHeld(username, connection, lockService);
}
