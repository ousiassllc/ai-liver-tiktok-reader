import { createHash } from 'crypto';
import {
  DocumentData,
  Firestore,
  Timestamp,
} from '@google-cloud/firestore';

interface LockDocument extends DocumentData {
  ownerInstanceId: string;
  leaseId: string;
  expiresAt: Timestamp;
  updatedAt: Timestamp;
}

interface FirestoreLockStoreOptions {
  firestore?: Firestore;
  leaseDurationMs: number;
  transactionTimeoutMs: number;
}

const HEALTH_CHECK_DOCUMENT_ID = 'health-check';

/** Firestore lock documentのtransactionとserver時刻基準の期限判定を担当する。 */
export class FirestoreLockStore {
  private readonly firestore: Firestore;
  private readonly ownsFirestore: boolean;
  private readonly leaseDurationMs: number;
  private readonly transactionTimeoutMs: number;

  constructor(
    projectId: string,
    private readonly collectionName: string,
    options: FirestoreLockStoreOptions,
  ) {
    this.firestore = options.firestore ?? new Firestore({ projectId });
    this.ownsFirestore = options.firestore === undefined;
    this.leaseDurationMs = options.leaseDurationMs;
    this.transactionTimeoutMs = options.transactionTimeoutMs;
  }

  private getLockRef(username: string) {
    const documentId = createHash('sha256').update(username).digest('hex');
    return this.firestore.collection(this.collectionName).doc(documentId);
  }

  private parseLockDocument(data: DocumentData | undefined): LockDocument | null {
    if (
      !data ||
      typeof data.ownerInstanceId !== 'string' ||
      typeof data.leaseId !== 'string' ||
      !(data.expiresAt instanceof Timestamp) ||
      !(data.updatedAt instanceof Timestamp)
    ) {
      return null;
    }
    return data as LockDocument;
  }

  private expiresAt(readTime: Timestamp): Timestamp {
    return Timestamp.fromMillis(readTime.toMillis() + this.leaseDurationMs);
  }

  private isExpired(lock: LockDocument, readTime: Timestamp): boolean {
    return lock.expiresAt.toMillis() <= readTime.toMillis();
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    operationName: string,
    onTimeout?: () => void,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(
            () => {
              onTimeout?.();
              reject(new Error(`${operationName}タイムアウト`));
            },
            this.transactionTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async acquire(
    username: string,
    ownerInstanceId: string,
    proposedLeaseId: string,
    currentLeaseId: string | undefined,
  ): Promise<string | null> {
    const lockRef = this.getLockRef(username);
    let timedOut = false;
    // 同一documentへの同時acquireは競合するため、Firestore SDKのtransaction retryに任せる。
    // 取得側のtimeout後にcommitしてもleaseは最大leaseDurationMsで失効し、呼び出し元はleaderにならない。
    return this.withTimeout(
      this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(lockRef);
        const readTime = snapshot.readTime;
        // PromiseのtimeoutではSDKのRPC自体をcancelできない。遅延read後のwriteを防ぐ。
        if (timedOut) return null;

        if (snapshot.exists) {
          const current = this.parseLockDocument(snapshot.data());
          if (!current) throw new Error('Firestore lock document has an invalid schema');

          if (!this.isExpired(current, readTime)) {
            if (
              current.ownerInstanceId !== ownerInstanceId ||
              current.leaseId !== currentLeaseId
            ) {
              return null;
            }

            transaction.update(lockRef, {
              expiresAt: this.expiresAt(readTime),
              updatedAt: readTime,
            });
            return current.leaseId;
          }
        }

        transaction.set(lockRef, {
          ownerInstanceId,
          leaseId: proposedLeaseId,
          expiresAt: this.expiresAt(readTime),
          updatedAt: readTime,
        } satisfies LockDocument);
        return proposedLeaseId;
      }),
      'Firestoreロック取得',
      () => { timedOut = true; },
    );
  }

  async release(username: string, ownerInstanceId: string, leaseId: string): Promise<boolean> {
    const lockRef = this.getLockRef(username);
    let timedOut = false;
    return this.withTimeout(
      this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(lockRef);
        if (timedOut) return false;
        if (!snapshot.exists) return false;

        const current = this.parseLockDocument(snapshot.data());
        if (
          !current ||
          this.isExpired(current, snapshot.readTime) ||
          current.ownerInstanceId !== ownerInstanceId ||
          current.leaseId !== leaseId
        ) {
          return false;
        }

        transaction.delete(lockRef);
        return true;
      }, { maxAttempts: 1 }),
      'Firestoreロック解放',
      () => { timedOut = true; },
    );
  }

  async refresh(username: string, ownerInstanceId: string, leaseId: string): Promise<boolean> {
    const lockRef = this.getLockRef(username);
    let timedOut = false;
    return this.withTimeout(
      this.firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(lockRef);
        if (timedOut) return false;
        if (!snapshot.exists) return false;

        const current = this.parseLockDocument(snapshot.data());
        if (
          !current ||
          this.isExpired(current, snapshot.readTime) ||
          current.ownerInstanceId !== ownerInstanceId ||
          current.leaseId !== leaseId
        ) {
          return false;
        }

        transaction.update(lockRef, {
          expiresAt: this.expiresAt(snapshot.readTime),
          updatedAt: snapshot.readTime,
        });
        return true;
      }, { maxAttempts: 1 }),
      'Firestoreロック更新',
      () => { timedOut = true; },
    );
  }

  async getHolder(username: string): Promise<string | null> {
    const snapshot = await this.withTimeout(
      this.getLockRef(username).get(),
      'Firestoreロックホルダー取得',
    );
    if (!snapshot.exists) return null;

    const current = this.parseLockDocument(snapshot.data());
    if (!current || this.isExpired(current, snapshot.readTime)) return null;
    return current.ownerInstanceId;
  }

  async isOwner(username: string, ownerInstanceId: string, leaseId: string): Promise<boolean> {
    const snapshot = await this.withTimeout(
      this.getLockRef(username).get(),
      'Firestoreリーダー確認',
    );
    if (!snapshot.exists) return false;

    const current = this.parseLockDocument(snapshot.data());
    return Boolean(
      current &&
      !this.isExpired(current, snapshot.readTime) &&
      current.ownerInstanceId === ownerInstanceId &&
      current.leaseId === leaseId
    );
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.withTimeout(
        this.firestore.collection(this.collectionName).doc(HEALTH_CHECK_DOCUMENT_ID).get(),
        'Firestoreヘルスチェック',
      );
      return true;
    } catch {
      return false;
    }
  }

  async waitForReady(timeoutMs: number): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.firestore.collection(this.collectionName).doc(HEALTH_CHECK_DOCUMENT_ID).get(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Firestore接続タイムアウト')), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {
    if (this.ownsFirestore) await this.firestore.terminate();
  }
}
