import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { DistributedLockService } from '../../src/services/distributed-lock-service';

const describeWithEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

describeWithEmulator('DistributedLockService Firestore integration', () => {
  const projectId = 'ai-liver-firestore-lock-test';
  let firestore: Firestore;
  let collectionName: string;

  beforeEach(() => {
    firestore = new Firestore({ projectId });
    collectionName = `tiktok-locks-${randomUUID()}`;
  });

  afterEach(async () => {
    const refs = await firestore.collection(collectionName).listDocuments();
    if (refs.length > 0) {
      const batch = firestore.batch();
      for (const ref of refs) batch.delete(ref);
      await batch.commit();
    }
    await firestore.terminate();
  });

  it('100並列acquireでwinnerが1件だけになる', async () => {
    const services = Array.from({ length: 100 }, (_, index) => (
      new DistributedLockService(projectId, collectionName, `instance-${index}`, {
        firestore,
        // Emulatorは同一documentへの競合transactionを直列に再試行するため、
        // この原子性テストだけRPC timeoutを延ばす。本番既定値5秒は変更しない。
        transactionTimeoutMs: 60_000,
      })
    ));

    const results = await Promise.all(services.map((service) => service.acquireLock('streamer')));

    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = services[results.findIndex(Boolean)];
    expect(await winner.isLeader('streamer')).toBe(true);
  }, 90_000);

  it('Firestore接続のstartup/readiness probeが成功する', async () => {
    const service = new DistributedLockService(projectId, collectionName, 'health-checker', {
      firestore,
    });

    await expect(service.waitForReady()).resolves.toBeUndefined();
    expect(await service.isHealthy()).toBe(true);
  });

  it('wrong ownerとwrong leaseIdのrefresh/releaseを個別に拒否する', async () => {
    const owner = new DistributedLockService(projectId, collectionName, 'owner', { firestore });
    expect(await owner.acquireLock('streamer')).toBe(true);

    const documentId = createHash('sha256').update('streamer').digest('hex');
    const snapshot = await firestore.collection(collectionName).doc(documentId).get();
    const actualLeaseId = snapshot.data()?.leaseId as string;
    const wrongOwner = new DistributedLockService(projectId, collectionName, 'attacker', { firestore });
    const wrongLease = new DistributedLockService(projectId, collectionName, 'owner', { firestore });

    (wrongOwner as unknown as {
      localLeases: Map<string, { leaseId: string; lastRefreshSuccessAtMs: number }>;
    }).localLeases.set('streamer', {
      leaseId: actualLeaseId,
      lastRefreshSuccessAtMs: Date.now(),
    });
    expect(await wrongOwner.refreshLock('streamer')).toBe(false);
    (wrongOwner as unknown as {
      localLeases: Map<string, { leaseId: string; lastRefreshSuccessAtMs: number }>;
    }).localLeases.set('streamer', {
      leaseId: actualLeaseId,
      lastRefreshSuccessAtMs: Date.now(),
    });
    expect(await wrongOwner.releaseLock('streamer')).toBe(false);

    (wrongLease as unknown as {
      localLeases: Map<string, { leaseId: string; lastRefreshSuccessAtMs: number }>;
    }).localLeases.set('streamer', {
      leaseId: 'wrong-lease',
      lastRefreshSuccessAtMs: Date.now(),
    });
    expect(await wrongLease.refreshLock('streamer')).toBe(false);
    (wrongLease as unknown as {
      localLeases: Map<string, { leaseId: string; lastRefreshSuccessAtMs: number }>;
    }).localLeases.set('streamer', {
      leaseId: 'wrong-lease',
      lastRefreshSuccessAtMs: Date.now(),
    });
    expect(await wrongLease.releaseLock('streamer')).toBe(false);
    expect(await owner.isLeader('streamer')).toBe(true);
  });

  it('期限切れleaseを別instanceが取得できる', async () => {
    const first = new DistributedLockService(projectId, collectionName, 'first', {
      firestore,
      leaseDurationMs: 5_000,
    });
    const second = new DistributedLockService(projectId, collectionName, 'second', {
      firestore,
      leaseDurationMs: 5_000,
    });

    expect(await first.acquireLock('streamer')).toBe(true);
    const documentId = createHash('sha256').update('streamer').digest('hex');
    await firestore.collection(collectionName).doc(documentId).update({
      expiresAt: Timestamp.fromMillis(0),
    });
    expect(await second.acquireLock('streamer')).toBe(true);
    expect(await first.isLeader('streamer')).toBe(false);
    expect(await second.isLeader('streamer')).toBe(true);
  });

  it('期限切れleaseは旧ownerでもreleaseできない', async () => {
    const owner = new DistributedLockService(projectId, collectionName, 'owner', {
      firestore,
      leaseDurationMs: 5_000,
    });

    expect(await owner.acquireLock('streamer')).toBe(true);
    const documentId = createHash('sha256').update('streamer').digest('hex');
    await firestore.collection(collectionName).doc(documentId).update({
      expiresAt: Timestamp.fromMillis(0),
    });
    expect(await owner.releaseLock('streamer')).toBe(false);
  });

  it('refreshでlease期限を延長する', async () => {
    const owner = new DistributedLockService(projectId, collectionName, 'owner', {
      firestore,
      leaseDurationMs: 5_000,
    });
    const contender = new DistributedLockService(projectId, collectionName, 'contender', {
      firestore,
      leaseDurationMs: 5_000,
    });

    expect(await owner.acquireLock('streamer')).toBe(true);
    const documentId = createHash('sha256').update('streamer').digest('hex');
    const lockRef = firestore.collection(collectionName).doc(documentId);
    const beforeRefresh = (await lockRef.get()).data()?.expiresAt as Timestamp;
    expect(await owner.refreshLock('streamer')).toBe(true);
    const afterRefresh = (await lockRef.get()).data()?.expiresAt as Timestamp;
    expect(afterRefresh.toMillis()).toBeGreaterThan(beforeRefresh.toMillis());
    expect(await contender.acquireLock('streamer')).toBe(false);
  });

  it('usernameのSHA-256をdocument IDにしてlease fieldsを保存する', async () => {
    const service = new DistributedLockService(projectId, collectionName, 'owner', { firestore });
    expect(await service.acquireLock('SensitiveUserName')).toBe(true);

    const documentId = createHash('sha256').update('SensitiveUserName').digest('hex');
    const snapshot = await firestore.collection(collectionName).doc(documentId).get();
    const data = snapshot.data();

    expect(snapshot.exists).toBe(true);
    expect(data?.ownerInstanceId).toBe('owner');
    expect(typeof data?.leaseId).toBe('string');
    expect(data?.leaseId.length).toBeGreaterThan(0);
    expect(data?.expiresAt).toBeInstanceOf(Timestamp);
    expect(data?.updatedAt).toBeInstanceOf(Timestamp);
  });
});
