import { describe, it, expect, beforeEach, afterEach, afterAll, mock, jest } from 'bun:test';
import type { Firestore } from '@google-cloud/firestore';
import * as realLoggerNs from '../../src/utils/logger';

const realLogger = { ...realLoggerNs };
/**
 * refine-sweep iter-4 tiktok-reader MINOR #3 の回帰テスト。
 *
 * setInterval(async () => ...) は返した Promise の rejection を setInterval 側が
 * ハンドリングしないため、内部で throw されると unhandledRejection になり
 * Node.js の設定によっては process が落ちる。修正後は同期関数から Promise を
 * 起動し、必ず .catch でエラーを吸収する。
 */
mock.module('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { DistributedLockService } from '../../src/services/distributed-lock-service';
import { logger } from '../../src/utils/logger';

function buildService(instanceId: string, now: () => number): DistributedLockService {
  return new DistributedLockService('test-project', 'test-locks', instanceId, {
    firestore: {} as Firestore,
    refreshIntervalMs: 5_000,
    lockLossTimeoutMs: 10_000,
    now,
  });
}

function seedLocalLease(
  service: DistributedLockService,
  username: string,
  lastRefreshSuccessAtMs: number,
  leaseId = 'lease-for-test',
): void {
  (service as unknown as {
    localLeases: Map<string, { leaseId: string; lastRefreshSuccessAtMs: number }>;
  }).localLeases.set(username, {
    leaseId,
    lastRefreshSuccessAtMs,
  });
}

function getLocalLeaseId(service: DistributedLockService, username: string): string | undefined {
  return (service as unknown as {
    localLeases: Map<string, { leaseId: string; lastRefreshSuccessAtMs: number }>;
  }).localLeases.get(username)?.leaseId;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('DistributedLockService.startLockRefresh', () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = 0;
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('acquireのABORTED競合は障害ログにせず取得失敗として扱う', async () => {
    const service = buildService('instance-contention', () => nowMs);
    const aborted = Object.assign(new Error('Transaction lock timeout'), { code: 10 });
    (service as any).store.acquire = jest.fn().mockRejectedValue(aborted);

    expect(await service.acquireLock('user-contention')).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Firestoreロック取得競合'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('refreshの一時エラーをhandled rejectionとして記録する', async () => {
    const service = buildService('instance-a', () => nowMs);
    seedLocalLease(service, 'user-a', nowMs);
    const refreshError = new Error('firestore unavailable');
    const refreshSpy = jest.spyOn(service, 'refreshLock').mockRejectedValue(refreshError);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      service.startLockRefresh('user-a');
      nowMs = 5_000;
      jest.advanceTimersByTime(5_000);
      await flushPromises();

      expect(refreshSpy).toHaveBeenCalledWith('user-a');
      expect((logger.error as jest.Mock).mock.calls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('ロック自動更新中の例外'),
      )).toBe(true);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      service.stopLockRefresh('user-a');
    }
  });

  it('所有権喪失または期限切れでは即座にonLockLostを呼ぶ', async () => {
    const service = buildService('instance-b', () => nowMs);
    seedLocalLease(service, 'user-b', nowMs);
    const refreshSpy = jest.spyOn(service, 'refreshLock').mockResolvedValue(false);
    const onLockLost = jest.fn();

    service.startLockRefresh('user-b', onLockLost);
    nowMs = 5_000;
    jest.advanceTimersByTime(5_000);
    await flushPromises();

    expect(onLockLost).toHaveBeenCalledTimes(1);
    refreshSpy.mockClear();
    jest.advanceTimersByTime(5_000);
    await flushPromises();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('前回refresh完了後に次回を予約してRPCを重複させない', async () => {
    const service = buildService('instance-c', () => nowMs);
    seedLocalLease(service, 'user-c', nowMs);
    let resolveRefresh!: (value: boolean) => void;
    const refreshSpy = jest.spyOn(service, 'refreshLock').mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveRefresh = resolve; }),
    );

    service.startLockRefresh('user-c');
    nowMs = 5_000;
    jest.advanceTimersByTime(5_000);
    await flushPromises();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    nowMs = 20_000;
    jest.advanceTimersByTime(15_000);
    await flushPromises();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    resolveRefresh(true);
    await flushPromises();
    jest.advanceTimersByTime(4_999);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flushPromises();
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    service.stopLockRefresh('user-c');
  });

  it('Firestoreエラーが最後の成功から10秒続くとfail-closedする', async () => {
    const service = buildService('instance-d', () => nowMs);
    seedLocalLease(service, 'user-d', nowMs);
    jest.spyOn(service, 'refreshLock').mockRejectedValue(new Error('firestore timeout'));
    const onLockLost = jest.fn();

    service.startLockRefresh('user-d', onLockLost);
    nowMs = 5_000;
    jest.advanceTimersByTime(5_000);
    await flushPromises();
    expect(onLockLost).not.toHaveBeenCalled();

    nowMs = 10_000;
    jest.advanceTimersByTime(5_000);
    await flushPromises();
    expect(onLockLost).toHaveBeenCalledTimes(1);
  });

  it('古いrefresh RPCの失敗で新しいlocal leaseを削除しない', async () => {
    const service = buildService('instance-e', () => nowMs);
    seedLocalLease(service, 'user-e', nowMs, 'old-lease');
    let resolveRefresh!: (value: boolean) => void;
    (service as any).store.refresh = jest.fn(
      () => new Promise<boolean>((resolve) => { resolveRefresh = resolve; }),
    );

    const refreshing = service.refreshLock('user-e');
    await flushPromises();
    seedLocalLease(service, 'user-e', nowMs, 'new-lease');
    resolveRefresh(false);

    expect(await refreshing).toBe(false);
    expect(getLocalLeaseId(service, 'user-e')).toBe('new-lease');
  });

  it('古いrelease RPCの完了で新しいlocal leaseを削除しない', async () => {
    const service = buildService('instance-f', () => nowMs);
    seedLocalLease(service, 'user-f', nowMs, 'old-lease');
    let resolveRelease!: (value: boolean) => void;
    (service as any).store.release = jest.fn(
      () => new Promise<boolean>((resolve) => { resolveRelease = resolve; }),
    );

    const releasing = service.releaseLock('user-f');
    await flushPromises();
    seedLocalLease(service, 'user-f', nowMs, 'new-lease');
    resolveRelease(true);

    expect(await releasing).toBe(true);
    expect(getLocalLeaseId(service, 'user-f')).toBe('new-lease');
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
});
