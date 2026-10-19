export interface ConnectMessage {
  type: 'connect';
  liveUrl: string;
  sessionId: string;
}

export interface CommentEvent {
  type: 'comment';
  data: {
    id: string;
    /** プラットフォーム固有ユーザーID（spec 3-3-5-3-2） */
    platformUserId: string;
    /** @deprecated 後方互換用。`platformUserId` を利用すること。 */
    tiktokUserId: string;
    username: string;
    avatarUrl?: string;
    text: string;
    timestamp: string;
    /** プラットフォーム種別（spec 3-3-5-3-2） */
    platform: 'tiktok' | 'youtube';
  };
}

export interface GiftEvent {
  type: 'gift';
  data: {
    id: string;
    /** プラットフォーム固有ユーザーID（spec 3-3-5-3-3） */
    platformUserId: string;
    /** @deprecated 後方互換用。`platformUserId` を利用すること。 */
    tiktokUserId: string;
    username: string;
    avatarUrl?: string;
    giftType: string;
    giftAmount: number;
    giftCount: number;
    /** 通貨コード（JPY/USD等）。TikTok は diamond なので空文字。 */
    currency: string;
    /** ギフトメッセージ（SuperChat 等、TikTok は空文字） */
    message: string;
    timestamp: string;
    /** プラットフォーム種別（spec 3-3-5-3-3） */
    platform: 'tiktok' | 'youtube';
  };
}

export interface SimpleEvent {
  type: 'follow' | 'share' | 'subscribe' | 'member';
  data: {
    id: string;
    /** プラットフォーム固有ユーザーID */
    platformUserId: string;
    /** @deprecated 後方互換用。`platformUserId` を利用すること。 */
    tiktokUserId: string;
    username: string;
    avatarUrl?: string;
    timestamp: string;
    platform: 'tiktok' | 'youtube';
    /**
     * member イベント時のメンバーランク（spec api.md L2851 で必須）。
     * follow / share / subscribe では undefined。
     */
    memberLevel?: number;
  };
}

/**
 * viewer_count イベント（Issue #615）。TikTok Live の WebcastEvent.ROOM_USER を購読して
 * viewerCount を admin render runtime に配信する。backend にも POST /session/{id}/viewer-count で
 * 同じ値を送るため、フロントは backend の /session/{id}/stats を polling する経路と
 * WebSocket 経路のどちらでも視聴者数を取得できる。
 */
export interface ViewerCountEvent {
  type: 'viewer_count';
  data: {
    /** アクティブ視聴者数（TikTok が取得できなかった場合は null） */
    count: number | null;
    timestamp: string;
    platform: 'tiktok';
  };
}

export interface StatusMessage {
  type: 'status';
  /** spec 3-3-5-3-4: data: { status, message } のネスト形式 */
  data: {
    status: 'connected' | 'disconnected' | 'quota_warning' | 'quota_exceeded';
    message: string;
  };
}

/**
 * spec api.md: error メッセージは data: { code, message } のネスト形式で送信する。
 * 旧フォーマット（最上位の code / message）からの移行のため互換ラッパは設けない。
 */
export interface ErrorMessage {
  type: 'error';
  data: {
    code: 'CONNECTION_FAILED' | 'INVALID_URL' | 'INVALID_MESSAGE' | 'SESSION_NOT_FOUND' | 'INTERNAL_ERROR';
    message: string;
  };
}

export type WebSocketMessage =
  | CommentEvent
  | GiftEvent
  | SimpleEvent
  | ViewerCountEvent
  | StatusMessage
  | ErrorMessage;
