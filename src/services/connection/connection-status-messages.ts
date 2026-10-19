// ConnectionManager から広告する status / error メッセージのファクトリ。
// spec 3-3-5-3-4: status / message は data フィールド配下にネストする形式。
// Issue #773: connection-manager.ts の 300 行制限を守るため切り出した。

export interface StatusMessage {
  type: 'status';
  data: {
    status: string;
    message: string;
    leader?: string | null;
  };
}

export interface ErrorMessage {
  type: 'error';
  data: {
    code: string;
    message: string;
  };
}

export function connectedStatusJson(): string {
  return JSON.stringify({
    type: 'status',
    data: {
      status: 'connected',
      message: 'TikTok Liveに接続済み',
    },
  } satisfies StatusMessage);
}

export function connectedViaOtherInstanceJson(leader: string | null): string {
  return JSON.stringify({
    type: 'status',
    data: {
      status: 'connected',
      message: 'TikTok Liveに接続しました（別インスタンス経由）',
      leader,
    },
  } satisfies StatusMessage);
}

export function reconnectingJson(): string {
  return JSON.stringify({
    type: 'status',
    data: {
      status: 'reconnecting',
      message: 'リーダー再選出中...',
    },
  } satisfies StatusMessage);
}

export function connectionFailedErrorJson(error: unknown): string {
  return JSON.stringify({
    type: 'error',
    data: {
      code: 'CONNECTION_FAILED',
      message:
        error instanceof Error
          ? error.message
          : 'TikTok Liveへの接続に失敗しました',
    },
  } satisfies ErrorMessage);
}
