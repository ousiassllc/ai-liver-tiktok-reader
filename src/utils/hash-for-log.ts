import { createHash } from 'crypto';

/**
 * refine-sweep iter-7 tiktok-reader MINOR: TikTok username / nickname 等の
 * PII をログに直接書き出さないため、SHA-256 の先頭 16 文字を返す共有ヘルパー。
 *
 * 同一入力に対しては同一ハッシュを返すため、複数ログ行を横断したデバッグ追跡が
 * 可能なまま、平文の個人情報を残さない。
 *
 * - 16 文字 (64bit) の空間は運用中の TikTok username 数に対して衝突確率が
 *   実用上ゼロで、デバッグ用途には十分。
 * - 入力が falsy な場合は `undefined` を返し、logger 側で自然にフィールドを
 *   省略できるようにする。
 *
 * 元は `services/tiktok-service.ts` に閉じたローカル関数だったが、
 * `services/connection-manager.ts` からも同じ用途で使うため utils に移設した。
 */
export const hashForLog = (
  value: string | undefined | null,
): string | undefined => {
  if (!value) return undefined;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
};
