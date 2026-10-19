import { describe, expect, it, jest } from 'bun:test';
import { Timestamp, type Firestore } from '@google-cloud/firestore';
import { FirestoreLockStore } from '../../../src/services/lock/firestore-lock-store';

describe('FirestoreLockStore timeout fencing', () => {
  it('timeout後にtransaction readが完了してもleaseを延長しない', async () => {
    const update = jest.fn();
    const snapshot = {
      exists: true,
      readTime: Timestamp.now(),
      data: () => ({
        ownerInstanceId: 'instance-a',
        leaseId: 'lease-a',
        expiresAt: Timestamp.fromMillis(Date.now() + 15_000),
        updatedAt: Timestamp.now(),
      }),
    };
    const firestore = {
      collection: jest.fn(() => ({ doc: jest.fn(() => ({})) })),
      runTransaction: jest.fn(async (callback: (transaction: unknown) => Promise<boolean>) => (
        callback({
          get: jest.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return snapshot;
          }),
          update,
        })
      )),
    } as unknown as Firestore;
    const store = new FirestoreLockStore('test-project', 'locks', {
      firestore,
      leaseDurationMs: 15_000,
      transactionTimeoutMs: 1,
    });

    await expect(store.refresh('streamer', 'instance-a', 'lease-a')).rejects.toThrow(
      'Firestoreロック更新タイムアウト',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(update).not.toHaveBeenCalled();
  });
});
