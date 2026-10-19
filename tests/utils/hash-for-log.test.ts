import { describe, it, expect } from 'bun:test';
import { createHash } from 'crypto';
import { hashForLog } from '../../src/utils/hash-for-log';

/**
 * refine-sweep iter-7 tiktok-reader MINOR: connection-manager.ts で TikTok username
 * を平文でログ出力していた回帰を防ぐための単体テスト。hashForLog が SHA-256 先頭
 * 16 文字の hex を返すこと、falsy 入力で undefined を返すこと、同一入力で同じ
 * ハッシュを返すこと（横断デバッグ性）を担保する。
 */
describe('hashForLog', () => {
  it('SHA-256(先頭16文字) の hex を返す', () => {
    const input = 'sample_tiktok_user';
    const expected = createHash('sha256').update(input).digest('hex').slice(0, 16);
    expect(hashForLog(input)).toBe(expected);
    expect(hashForLog(input)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('平文の username を含まない', () => {
    const username = 'super_secret_user';
    const hashed = hashForLog(username);
    expect(hashed).toBeDefined();
    expect(hashed).not.toContain(username);
  });

  it('同一入力に対して同じハッシュを返す (横断デバッグ用)', () => {
    expect(hashForLog('alice')).toBe(hashForLog('alice'));
  });

  it('異なる入力に対して異なるハッシュを返す', () => {
    expect(hashForLog('alice')).not.toBe(hashForLog('bob'));
  });

  it('undefined / null / 空文字は undefined を返す', () => {
    expect(hashForLog(undefined)).toBeUndefined();
    expect(hashForLog(null)).toBeUndefined();
    expect(hashForLog('')).toBeUndefined();
  });
});
