/**
 * Issue #590: TikTok 同時接続数制限。
 *
 * spec: docs/content/docs/tiktok-connector/_index.md セクション「制限事項 / 接続数制限」
 *
 * WebSocket クライアント数を「全体」および「1 TikTok ユーザーあたり」で制限する。
 * 制限値は環境変数から読み込む:
 *   - TIKTOK_READER_MAX_TOTAL_CLIENTS: 本インスタンスが同時に保持する WebSocket
 *     クライアントの上限。0 または未設定は「制限なし」。
 *   - TIKTOK_READER_MAX_CLIENTS_PER_USER: 1 TikTok ユーザー（配信）あたりの
 *     WebSocket クライアントの上限。0 または未設定は「制限なし」。
 *
 * 制限は 1 インスタンス単位で適用する。マルチインスタンス構成で真の「全体」
 * 制限を掛けるには Cloud Run 側のインスタンス数やロードバランサ側の
 * concurrent connection 上限と併用する。
 */
export interface ConnectionLimits {
  readonly maxTotalClients: number;
  readonly maxClientsPerUser: number;
}

const DEFAULT_LIMITS: ConnectionLimits = {
  maxTotalClients: 0,
  maxClientsPerUser: 0,
};

/**
 * 環境変数から `ConnectionLimits` を組み立てる。
 * 空文字・欠損・数値化できない値・負値は「制限なし (0)」として扱う。
 */
export function loadConnectionLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConnectionLimits {
  return {
    maxTotalClients: parsePositiveInt(env.TIKTOK_READER_MAX_TOTAL_CLIENTS),
    maxClientsPerUser: parsePositiveInt(env.TIKTOK_READER_MAX_CLIENTS_PER_USER),
  };
}

function parsePositiveInt(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const parsed = Number.parseInt(value, 10);
  // Number.isFinite は NaN も false になるので NaN を別途チェックする必要はない。
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

/**
 * connection limits のデフォルト値（テストや明示的な制限なし指定に使う）。
 */
export function noConnectionLimits(): ConnectionLimits {
  return { ...DEFAULT_LIMITS };
}

export type ConnectionLimitReason = 'total' | 'per_user';

/**
 * 接続上限超過時に ConnectionManager から throw されるエラー。
 * WebSocketHandler 側で catch してクライアントに CONNECTION_LIMIT_EXCEEDED を返す。
 */
export class ConnectionLimitError extends Error {
  readonly reason: ConnectionLimitReason;
  readonly limit: number;
  readonly current: number;

  constructor(reason: ConnectionLimitReason, limit: number, current: number) {
    super(
      reason === 'total'
        ? `同時接続数上限 (${limit}) に達しました (現在 ${current})`
        : `ユーザーあたりの接続数上限 (${limit}) に達しました (現在 ${current})`,
    );
    this.name = 'ConnectionLimitError';
    this.reason = reason;
    this.limit = limit;
    this.current = current;
  }
}

/**
 * Issue #2782: 同一配信者（username）に、接続中の session と別の session から接続しようとした
 * ときに ConnectionManager から throw されるエラー。
 *
 * 配信者ごとの TikTok 接続・分散ロック・backend 転送先 session は 1 つなので、契約は
 * 「1 配信者 = 同時に 1 session」とし、後着の別 session を拒否する。
 * 判定は本インスタンス内の接続状態に対するもので、別インスタンスの session は見ない
 * （分散ロックのキーが username のみのため）。
 */
export class SessionConflictError extends Error {
  constructor() {
    super('streamer is already connected with another session');
    this.name = 'SessionConflictError';
  }
}
