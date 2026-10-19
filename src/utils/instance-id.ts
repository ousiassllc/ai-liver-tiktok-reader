import axios from 'axios';
import { logger } from './logger';
import { randomUUID } from 'crypto';

/**
 * インスタンスIDを取得
 * 優先順位: 環境変数 → Cloud Runメタデータ → ランダム生成
 */
export async function getInstanceId(): Promise<string> {
  if (process.env.INSTANCE_ID) {
    logger.info(`インスタンスID（環境変数）: ${process.env.INSTANCE_ID}`);
    return process.env.INSTANCE_ID;
  }

  try {
    const response = await axios.get(
      'http://metadata.google.internal/computeMetadata/v1/instance/id',
      { headers: { 'Metadata-Flavor': 'Google' }, timeout: 1000 }
    );
    const instanceId = String(response.data);
    logger.info(`インスタンスID（メタデータ）: ${instanceId}`);
    return instanceId;
  } catch {
    // ローカル環境
  }

  const instanceId = `local-${randomUUID().slice(0, 8)}`;
  logger.info(`インスタンスID（自動生成）: ${instanceId}`);
  return instanceId;
}
