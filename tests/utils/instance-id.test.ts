import { describe, it, expect, beforeEach, afterAll, mock, jest, spyOn } from 'bun:test';
import axios from 'axios';
import { getInstanceId } from '../../src/utils/instance-id';
import * as realLoggerNs from '../../src/utils/logger';

/**
 * Issue #2508: getInstanceId は tests/ 配下からの import が皆無で
 * 一度も実行されていなかった (実測カバレッジ表にファイル自体が出現しない)。
 * 分散ロックのインスタンス識別ミスによる複数インスタンス競合を防ぐため、
 * 環境変数 → Cloud Run メタデータ → ランダム生成 の優先順位を検証する。
 */

const realLogger = { ...realLoggerNs };

// axios は CJS なので mock.module の factory 戻り値が esModuleInterop の
// default 解決と噛み合わない。src 側と同じインスタンスのメソッドを spyOn で
// 差し替える（backend-api-service.test.ts 系と同じ方針）。
const mockedAxios = {
  get: spyOn(axios, 'get'),
};

const loggerMock = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};
mock.module('../../src/utils/logger', () => ({ logger: loggerMock }));

describe('getInstanceId', () => {
  const originalInstanceId = process.env.INSTANCE_ID;

  beforeEach(() => {
    delete process.env.INSTANCE_ID;
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalInstanceId === undefined) {
      delete process.env.INSTANCE_ID;
    } else {
      process.env.INSTANCE_ID = originalInstanceId;
    }
  });

  it('INSTANCE_ID 環境変数が設定されている場合はそれを返し、メタデータへ問い合わせない', async () => {
    process.env.INSTANCE_ID = 'env-instance-42';

    const result = await getInstanceId();

    expect(result).toBe('env-instance-42');
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith('インスタンスID（環境変数）: env-instance-42');
  });

  it('環境変数が無く Cloud Run メタデータ取得に成功した場合はメタデータ値を返す', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: 9876543210987654321n as unknown as string });

    const result = await getInstanceId();

    expect(result).toBe('9876543210987654321');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'http://metadata.google.internal/computeMetadata/v1/instance/id',
      { headers: { 'Metadata-Flavor': 'Google' }, timeout: 1000 },
    );
    expect(loggerMock.info).toHaveBeenCalledWith('インスタンスID（メタデータ）: 9876543210987654321');
  });

  it('メタデータ取得が失敗した場合はローカル用のランダムIDにフォールバックする', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await getInstanceId();

    expect(result).toMatch(/^local-[0-9a-f]{8}$/);
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('インスタンスID（自動生成）: '));
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('フォールバック生成のIDは呼び出しごとに異なる', async () => {
    mockedAxios.get.mockRejectedValue(new Error('ECONNREFUSED'));

    const first = await getInstanceId();
    const second = await getInstanceId();

    expect(first).not.toBe(second);
  });
});

afterAll(() => {
  mock.module('../../src/utils/logger', () => realLogger);
});
