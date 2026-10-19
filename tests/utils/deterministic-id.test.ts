import { describe, it, expect } from 'bun:test';
import { buildCommentEventId, buildGiftEventId } from '../../src/utils/deterministic-id';

describe('deterministic-id', () => {
  describe('buildCommentEventId', () => {
    it('returns same id for same input', () => {
      const id1 = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.000Z');
      const id2 = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.000Z');
      expect(id1).toBe(id2);
    });

    it('returns different ids for different users', () => {
      const id1 = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.000Z');
      const id2 = buildCommentEventId('user2', 'hello', '2025-01-01T12:34:56.000Z');
      expect(id1).not.toBe(id2);
    });

    it('returns different ids for different texts', () => {
      const id1 = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.000Z');
      const id2 = buildCommentEventId('user1', 'world', '2025-01-01T12:34:56.000Z');
      expect(id1).not.toBe(id2);
    });

    it('returns different ids when seconds differ', () => {
      const id1 = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.000Z');
      const id2 = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:57.000Z');
      expect(id1).not.toBe(id2);
    });

    it('returns same id when only milliseconds differ', () => {
      const id1 = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.000Z');
      const id2 = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.999Z');
      expect(id1).toBe(id2);
    });

    it('returns 32 character output', () => {
      const id = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.000Z');
      expect(id).toHaveLength(32);
    });

    it('normalizes ISO strings without milliseconds to the same id', () => {
      const idWithMs = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56.000Z');
      const idWithoutMs = buildCommentEventId('user1', 'hello', '2025-01-01T12:34:56Z');
      expect(idWithMs).toBe(idWithoutMs);
    });

    it('is not affected by colons in text', () => {
      // セパレータ衝突対策: 旧実装（`:` 連結）では「a:b」を text にすると
      // userId/text/timestamp の境界が曖昧になり衝突しうるが、JSON.stringify
      // による境界明確化で異なる入力は異なる ID になることを保証する。
      const id1 = buildCommentEventId('user', 'a:b:2025-01-01T12:34:56', '2025-01-01T12:34:56.000Z');
      const id2 = buildCommentEventId('user:a', 'b:2025-01-01T12:34:56', '2025-01-01T12:34:56.000Z');
      expect(id1).not.toBe(id2);
    });
  });

  describe('buildGiftEventId', () => {
    it('returns same id for same input', () => {
      const id1 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      const id2 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      expect(id1).toBe(id2);
    });

    it('returns different ids for different gift types', () => {
      const id1 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      const id2 = buildGiftEventId('user1', 'Lion', 1, 100, '2025-01-01T12:34:56.000Z');
      expect(id1).not.toBe(id2);
    });

    it('returns different ids for different gift counts', () => {
      const id1 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      const id2 = buildGiftEventId('user1', 'Rose', 2, 100, '2025-01-01T12:34:56.000Z');
      expect(id1).not.toBe(id2);
    });

    it('returns different ids for different gift amounts', () => {
      const id1 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      const id2 = buildGiftEventId('user1', 'Rose', 1, 200, '2025-01-01T12:34:56.000Z');
      expect(id1).not.toBe(id2);
    });

    it('returns different ids when seconds differ', () => {
      const id1 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      const id2 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:57.000Z');
      expect(id1).not.toBe(id2);
    });

    it('returns same id when only milliseconds differ', () => {
      const id1 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      const id2 = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.500Z');
      expect(id1).toBe(id2);
    });

    it('returns 32 character output', () => {
      const id = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      expect(id).toHaveLength(32);
    });

    it('normalizes ISO strings without milliseconds to the same id', () => {
      const idWithMs = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56.000Z');
      const idWithoutMs = buildGiftEventId('user1', 'Rose', 1, 100, '2025-01-01T12:34:56Z');
      expect(idWithMs).toBe(idWithoutMs);
    });

    it('is not affected by colons in gift type', () => {
      // セパレータ衝突対策: ギフト名に `:` が含まれてもフィールド境界が
      // 保たれ、異なる入力は異なる ID になることを保証する。
      const id1 = buildGiftEventId('user', 'Rose:1', 1, 100, '2025-01-01T12:34:56.000Z');
      const id2 = buildGiftEventId('user', 'Rose', 1, 1100, '2025-01-01T12:34:56.000Z');
      expect(id1).not.toBe(id2);
    });
  });
});
