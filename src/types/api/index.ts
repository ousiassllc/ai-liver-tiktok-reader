export interface GiftApiPayload {
  session_id: string;
  tiktok_user_id: string;
  user_name: string;
  gift_type: string;
  gift_amount: number;
  gift_count: number;
}

/**
 * POST /session/{id}/viewer-count のリクエスト body（Issue #615）。
 *
 * count に null を渡すと backend 側で「取得不能」としてキャッシュに記録される。
 */
export interface ViewerCountApiPayload {
  count: number | null;
}

/**
 * POST /internal/tiktok-reader/session/{id}/comment のリクエスト body（Issue #2154）。
 *
 * backend 側で `session_comments` に記録され、MCP の `pick_ai_comments` が
 * AI に渡すコメント候補として読み出す。session_id は URL パスで渡すため body には含めない
 * （ViewerCountApiPayload と同じ設計）。
 *
 * - `platform`: 常に 'tiktok'。tiktok-reader 専用エンドポイントなので backend 側で
 *   固定値を埋める実装もあり得るが、backend の RecordSessionCommentRequest では
 *   `binding:"required"` になっている。backend は unknown field を無視する
 *   (DisallowUnknownFields を使っていない) ため、明示的に送っておけばどちらの
 *   実装でも 400 にならない。
 * - `platform_comment_id`: TikTok の msgId。取得できない場合は決定的 ID で代替する。
 * - `text`: 必須。空文字は backend が 400 を返すため、呼び出し側で空コメントを除外する。
 * - `received_at`: RFC3339。省略時は backend 側が受信時刻を採用する。
 */
export interface CommentApiPayload {
  platform: 'tiktok';
  platform_comment_id: string;
  platform_user_id: string;
  username: string;
  text: string;
  received_at: string;
}
