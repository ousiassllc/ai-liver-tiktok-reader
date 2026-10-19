import { createHash } from 'crypto';

/**
 * ISO 文字列を秒精度に正規化する（ミリ秒以下を 0 に揃える）
 *
 * - 入力にミリ秒があってもなくても、常に `YYYY-MM-DDTHH:MM:SS.000Z` 形式に統一する。
 * - パース不能な文字列は元の値をそのまま返す（fail-open）。
 *
 * 例:
 *   "2025-01-01T12:34:56.789Z" -> "2025-01-01T12:34:56.000Z"
 *   "2025-01-01T12:34:56Z"     -> "2025-01-01T12:34:56.000Z"
 */
const truncateToSeconds = (isoTs: string): string => {
  const d = new Date(isoTs);
  if (isNaN(d.getTime())) return isoTs;
  d.setMilliseconds(0);
  return d.toISOString();
};

/**
 * 32 文字 (128bit) に切り出す理由:
 *   - 衝突確率は誕生日攻撃で 2^-64 ≈ 5.4e-20、配信時間スケール (1日 = 10^5 秒) では実用上ゼロ
 *   - backend/ent/schema/gift.go の idempotency_key MaxLen(64) に収まる
 *   - 複合 unique index (idempotency_key, session_id) のキーサイズを抑えて B-tree 効率を維持
 *   - ログ・デバッグ時の可読性
 */
const ID_HEX_LENGTH = 32;

/**
 * コメントイベントの決定的 ID を生成する
 * 同一ユーザー・同一テキスト・同一秒であれば同じ ID になる
 *
 * JSON.stringify でフィールド境界を明確化し、テキスト中の `:` 等による
 * セパレータ衝突を防止する。
 */
export const buildCommentEventId = (userId: string, text: string, isoTs: string): string => {
  const key = JSON.stringify([userId, text, truncateToSeconds(isoTs)]);
  return createHash('sha256').update(key).digest('hex').slice(0, ID_HEX_LENGTH);
};

/**
 * ギフトイベントの決定的 ID を生成する
 * 同一ユーザー・同一ギフト種別・同数・同額・同一秒であれば同じ ID になる
 *
 * JSON.stringify でフィールド境界を明確化し、ギフト名等の `:` による
 * セパレータ衝突を防止する。
 */
export const buildGiftEventId = (
  userId: string,
  giftType: string,
  giftCount: number,
  giftAmount: number,
  isoTs: string,
): string => {
  const key = JSON.stringify([userId, giftType, giftCount, giftAmount, truncateToSeconds(isoTs)]);
  return createHash('sha256').update(key).digest('hex').slice(0, ID_HEX_LENGTH);
};
