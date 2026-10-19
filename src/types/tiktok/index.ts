export interface TikTokImage {
  url?: string[];
  mUri?: string;
}

export interface TikTokUser {
  uniqueId?: string;
  nickname?: string;
  profilePictureUrl?: string;
  avatarThumb?: TikTokImage;
  profilePicture?: TikTokImage;
}

export interface TikTokCommentData {
  msgId?: string;
  user?: TikTokUser;
  comment?: string;
}

export interface TikTokGiftData {
  msgId?: string;
  user?: TikTokUser;
  giftName?: string;
  diamondCount?: number;
  repeatCount?: number;
  extendedGiftInfo?: {
    name?: string;
    diamond_count?: number;
  };
}

export interface TikTokSimpleEventData {
  msgId?: string;
  user?: TikTokUser;
  /**
   * member イベント時のサブスクライバーランク。
   * tiktok-live-connector の MEMBER event payload に含まれる場合に利用する。
   */
  memberLevel?: number;
}

export interface TikTokSocialData {
  msgId?: string;
  user?: TikTokUser;
  action?: string | number;
}

/**
 * WebcastRoomUserSeqMessage の局所型（Issue #615）。
 *
 * tiktok-live-connector の型定義は同 SDK 内部で完結しているが、tiktok-service.ts は
 * SDK に直接依存しない形で必要フィールドだけ扱えるようローカルに定義する。
 * viewerCount / totalUser は number として emit される。
 */
export interface TikTokRoomUserData {
  msgId?: string;
  viewerCount?: number;
  totalUser?: number;
}
