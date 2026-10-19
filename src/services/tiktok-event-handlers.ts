import { randomUUID } from 'crypto';
import { WebcastEvent } from 'tiktok-live-connector';
import { CommentEvent, GiftEvent, SimpleEvent } from '../types/websocket';
import {
  TikTokCommentData,
  TikTokGiftData,
  TikTokSimpleEventData,
  TikTokUser,
} from '../types/tiktok';
import { logger } from '../utils/logger';
import { buildCommentEventId, buildGiftEventId } from '../utils/deterministic-id';
import { hashForLog } from '../utils/hash-for-log';
import { BackendApiService } from './backend-api-service';

/**
 * TikTok Live のイベントハンドラを純粋関数として集約したモジュール。
 * Issue #773: 376 行の tiktok-service.ts を 300 行以下に収めるため切り出した。
 * 元は TikTokService クラスの private メソッドだったが、状態を持たず引数として
 * `safeSend` / `backendApi` / `sessionId` を受け取る形に変えて再利用性を高めている。
 */

/** refine-sweep iter-3 backend MAJOR: `(WebcastEvent as any).SUBSCRIBE` の any キャストを避けるため、
 * 上位互換の名前でイベント名を解決するヘルパー。tiktok-live-connector の enum に SUBSCRIBE が
 * 存在しない場合でも文字列 'subscribe' にフォールバックし、SDK 更新時に enum に追加された値を
 * 自然に採用する。 */
export function resolveSubscribeEventName(): WebcastEvent {
  const enumRecord = WebcastEvent as unknown as Record<string, string>;
  return (enumRecord.SUBSCRIBE ?? 'subscribe') as WebcastEvent;
}

/** TikTokユーザーからアバターURLを抽出 */
export function extractAvatarUrl(user?: TikTokUser): string | undefined {
  if (!user) return undefined;
  if (user.profilePictureUrl) return user.profilePictureUrl;
  if (user.avatarThumb?.url?.[0]) return user.avatarThumb.url[0];
  if (user.profilePicture?.url?.[0]) return user.profilePicture.url[0];
  return undefined;
}

/**
 * Issue #2154: 受信コメントを backend に転送して `session_comments` に記録する。
 * MCP の `pick_ai_comments` はこのテーブルだけを読むため、転送しないと TikTok 配信では
 * AI が拾えるコメントが常に空のままになる。
 *
 * 視聴者へのリアルタイム配信を遅延・阻害しないことが最優先なので、呼び出し側は
 * `safeSend` の「後」にこの関数を呼び、await しない (fire-and-forget)。
 * BackendApiService 側でエラーは握り潰す設計だが、想定外の reject が
 * unhandled rejection にならないよう `.catch()` で必ず受け止める。
 */
function forwardCommentToBackend(
  backendApi: BackendApiService,
  sessionId: string,
  comment: CommentEvent['data'],
): void {
  backendApi
    .sendComment(sessionId, {
      platform: 'tiktok',
      platform_comment_id: comment.id,
      platform_user_id: comment.platformUserId,
      username: comment.username,
      text: comment.text,
      received_at: comment.timestamp,
    })
    .catch((error) => {
      // 転送失敗はコメント配信の失敗として扱わない (ログのみ残す)。
      logger.error('コメントのBackend API転送に失敗:', error);
    });
}

export function handleCommentEvent(
  data: TikTokCommentData,
  safeSend: (message: string) => void,
  backendApi: BackendApiService,
  sessionId: string | null,
): void {
  try {
    if (!data.user?.uniqueId || !data.user?.nickname) {
      logger.warn('コメント: ユーザー情報なし');
      return;
    }

    const avatarUrl = extractAvatarUrl(data.user);
    // debug も stdout に出るため、識別子・表示名・画像 URL はハッシュだけを記録する。
    logger.debug('Avatar extraction:', {
      uniqueIdHash: hashForLog(data.user.uniqueId),
      nicknameHash: hashForLog(data.user.nickname),
      avatarUrlHash: hashForLog(avatarUrl),
    });
    const timestamp = new Date().toISOString();
    const message: CommentEvent = {
      type: 'comment',
      data: {
        id: data.msgId || buildCommentEventId(data.user.uniqueId, data.comment || '', timestamp),
        platformUserId: data.user.uniqueId,
        tiktokUserId: data.user.uniqueId,
        username: data.user.nickname,
        avatarUrl,
        text: data.comment || '',
        timestamp,
        platform: 'tiktok',
      },
    };

    safeSend(JSON.stringify(message));
    // refine-sweep iter-5 tiktok-reader MINOR: plaintext nickname (PII) を INFO ログに残さない。
    logger.info('コメント配信:', {
      userHash: hashForLog(message.data.username),
      textLen: message.data.text.length,
    });

    // WebSocket 配信が済んだ後に backend へ転送する。sessionId が無い接続
    // (connect() 前のイベント) は転送先 URL を組めないため転送しない。
    // 空コメントは backend が 400 を返すため送らない (WebSocket 配信は従来どおり行う)。
    if (sessionId && message.data.text) {
      forwardCommentToBackend(backendApi, sessionId, message.data);
    }
  } catch (error) {
    logger.error('コメント処理エラー:', error);
  }
}

export function handleGiftEvent(
  data: TikTokGiftData,
  safeSend: (message: string) => void,
  backendApi: BackendApiService,
  sessionId: string | null,
): void {
  try {
    if (!data.user?.uniqueId || !data.user?.nickname) {
      logger.warn('ギフト: ユーザー情報なし');
      return;
    }

    const avatarUrl = extractAvatarUrl(data.user);
    const uniqueId = data.user.uniqueId;
    const giftType = data.giftName || data.extendedGiftInfo?.name || 'Unknown Gift';
    const giftAmount = data.diamondCount || data.extendedGiftInfo?.diamond_count || 0;
    const giftCount = data.repeatCount ?? 1;
    const timestamp = new Date().toISOString();
    const giftData = {
      // msgId があれば優先（handleComment と整合）。無い場合は決定的 ID で
      // 同一秒内の同一ギフトを冪等に扱う（backend 側で idempotency_key として使用）。
      id: data.msgId || buildGiftEventId(uniqueId, giftType, giftCount, giftAmount, timestamp),
      platformUserId: uniqueId,
      tiktokUserId: uniqueId,
      username: data.user.nickname,
      avatarUrl,
      giftType,
      giftAmount,
      giftCount,
      // TikTok は diamond ベースのため通貨コードは空文字、message も SuperChat 用なので空文字。
      // spec 3-3-5-3-3 で必須フィールドとして定義されているため明示的に空文字を入れる。
      currency: '',
      message: '',
      timestamp,
      platform: 'tiktok' as const,
    };

    const message: GiftEvent = { type: 'gift', data: giftData };

    safeSend(JSON.stringify(message));
    // refine-sweep iter-5 tiktok-reader MINOR: plaintext nickname を INFO ログに残さない。
    logger.info('ギフト配信:', { userHash: hashForLog(giftData.username), gift: giftData.giftType });

    // refine-sweep iter-3 backend MAJOR: 受信ギフトを backend API に非同期で保存する。
    // 以前は BackendApiService の import / 呼び出しが完全にコメントアウトされており、
    // 管理画面のギフト累計が常に 0 のままだった。sessionId が connect() 時に保持されて
    // いる場合のみ送信し、失敗しても WebSocket 経由の admin render 通知は継続する
    // （BackendApiService 内でエラーはログに残す設計）。
    if (sessionId) {
      void backendApi.sendGift({
        session_id: sessionId,
        tiktok_user_id: giftData.tiktokUserId,
        user_name: giftData.username,
        gift_type: giftData.giftType,
        gift_amount: giftData.giftAmount,
        gift_count: giftData.giftCount,
      });
    }
  } catch (error) {
    logger.error('ギフト処理エラー:', error);
  }
}

export function handleSimpleEventPayload(
  type: 'follow' | 'share' | 'member' | 'subscribe',
  data: TikTokSimpleEventData,
  safeSend: (message: string) => void,
): void {
  try {
    if (!data.user?.uniqueId || !data.user?.nickname) {
      logger.warn(`${type}: ユーザー情報なし`);
      return;
    }

    const avatarUrl = extractAvatarUrl(data.user);
    const messageData: SimpleEvent['data'] = {
      id: data.msgId || randomUUID(),
      platformUserId: data.user.uniqueId,
      tiktokUserId: data.user.uniqueId,
      username: data.user.nickname,
      avatarUrl,
      timestamp: new Date().toISOString(),
      platform: 'tiktok',
    };

    // spec api.md L2851: member イベントには memberLevel が必須。
    // payload に含まれない場合は 0 を既定値として送出する。
    if (type === 'member') {
      messageData.memberLevel = typeof data.memberLevel === 'number' ? data.memberLevel : 0;
    }

    const message: SimpleEvent = { type, data: messageData };

    safeSend(JSON.stringify(message));
    // refine-sweep iter-5 tiktok-reader MINOR: plaintext nickname を INFO ログに残さない。
    logger.info(`${type}配信:`, { userHash: hashForLog(message.data.username) });
  } catch (error) {
    logger.error(`${type}処理エラー:`, error);
  }
}
