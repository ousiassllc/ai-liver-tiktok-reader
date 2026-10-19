import { IncomingMessage, ServerResponse } from 'http';
import { DistributedLockService } from '../services/distributed-lock-service';
import { PubSubService } from '../services/pubsub-service';
import { ConnectionManager } from '../services/connection-manager';

interface HealthDependencies {
  lockService: DistributedLockService | null;
  pubsubService: PubSubService | null;
  connectionManager: ConnectionManager | null;
  instanceId: string;
}

export class HealthHandler {
  private deps: HealthDependencies;

  constructor(deps: HealthDependencies) {
    this.deps = deps;
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '';

    if (url === '/health' || url === '/healthz') {
      this.handleHealth(res);
    } else if (url === '/ready' || url === '/readiness') {
      await this.handleReadiness(res);
    } else if (url === '/status') {
      this.handleStatus(res);
    } else if (url === '/source') {
      this.handleSource(res);
    } else {
      this.sendJson(res, 404, { error: 'Not Found' });
    }
  }

  private handleHealth(res: ServerResponse): void {
    this.sendJson(res, 200, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      instanceId: this.deps.instanceId,
    });
  }

  private async handleReadiness(res: ServerResponse): Promise<void> {
    const checks = {
      lockStore: this.deps.lockService ? await this.deps.lockService.isHealthy() : false,
      pubsub: this.deps.pubsubService ? this.deps.pubsubService.isHealthy() : false,
    };

    const allHealthy = Object.values(checks).every((v) => v);

    this.sendJson(res, allHealthy ? 200 : 503, {
      status: allHealthy ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
      instanceId: this.deps.instanceId,
    });
  }

  private handleStatus(res: ServerResponse): void {
    const status = this.deps.connectionManager
      ? this.deps.connectionManager.getStatus()
      : { connections: 0, clients: 0, leaders: 0 };

    this.sendJson(res, 200, {
      ...status,
      timestamp: new Date().toISOString(),
      instanceId: this.deps.instanceId,
    });
  }

  /**
   * Issue #2782: AGPL 13 条の対応ソース案内。この HTTP / WebSocket サーバーを使う利用者が
   * 稼働版に対応するソースへ辿り着けるよう、ライセンス・稼働版の識別子・ソース URL を返す。
   * `version` は SOURCE_COMMIT（Docker build arg 由来）、`sourceUrl` は TIKTOK_READER_SOURCE_URL。
   */
  private handleSource(res: ServerResponse): void {
    this.sendJson(res, 200, {
      license: 'AGPL-3.0-only',
      version: process.env.SOURCE_COMMIT || 'unknown',
      sourceUrl: process.env.TIKTOK_READER_SOURCE_URL || null,
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, data: Record<string, unknown>): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
