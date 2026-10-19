import { WebSocket } from 'ws';
import { ConnectionInfo } from './connection-types';
import {
  ConnectionLimits,
  ConnectionLimitError,
} from '../connection-limits';

/**
 * Issue #590: 接続上限チェック。
 * 上限に達している場合は ConnectionLimitError を throw する。
 * WebSocketHandler 側で catch し、CONNECTION_LIMIT_EXCEEDED としてクライアントに返す。
 *
 * 既に該当 connection の clients に含まれている WebSocket が再度 addClient
 * された場合は Set が冪等に扱うため、実質的な新規追加は発生しない。
 * そのため事前チェックでは「同一 ws が既に含まれているか」を除外する必要はなく、
 * 「新規追加として増える 1 席分」を見込んで現在数と比較する。
 *
 * Issue #773: connection-manager.ts の 300 行制限を守るため純粋関数として切り出した。
 */
export function enforceConnectionLimits(
  username: string,
  ws: WebSocket,
  limits: ConnectionLimits,
  existing: ConnectionInfo | undefined,
  getTotalClientCount: () => number,
): void {
  const alreadyRegistered = existing?.clients.has(ws) ?? false;

  if (alreadyRegistered) {
    return;
  }

  const { maxTotalClients, maxClientsPerUser } = limits;

  if (maxTotalClients > 0) {
    const totalNow = getTotalClientCount();
    if (totalNow >= maxTotalClients) {
      throw new ConnectionLimitError('total', maxTotalClients, totalNow);
    }
  }

  if (maxClientsPerUser > 0) {
    const perUserNow = existing?.clients.size ?? 0;
    if (perUserNow >= maxClientsPerUser) {
      throw new ConnectionLimitError('per_user', maxClientsPerUser, perUserNow);
    }
  }
}
