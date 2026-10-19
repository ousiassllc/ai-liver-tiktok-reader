import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import axios from 'axios';
import { createServer, Server as HttpServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('HTTP Server Integration Test', () => {
  let httpServer: HttpServer;
  const TEST_PORT = 18473; // テスト用のポート

  const handleHttpRequest = (req: any, res: any) => {
    const url = req.url || '/';

    // ルートまたは /test へのアクセスでテストクライアントを返す
    if (url === '/' || url === '/test') {
      const testClientHtml = readFileSync(join(__dirname, '../../test-client.html'), 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(testClientHtml);
      return;
    }

    // それ以外は404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found\n\nAvailable endpoints:\n- GET / or /test (Test Client UI)\n- WebSocket ws://localhost:' + TEST_PORT + '/ws/events');
  };

  beforeAll((done) => {
    httpServer = createServer(handleHttpRequest);
    httpServer.listen(TEST_PORT, () => {
      done();
    });
  });

  afterAll((done) => {
    httpServer.close(() => {
      done();
    });
  });

  describe('GET /', () => {
    it('should return test-client.html with 200 status', async () => {
      const response = await axios.get(`http://localhost:${TEST_PORT}/`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.data).toContain('TikTok Reader');
      expect(response.data).toContain('<!DOCTYPE html>');
    });

    it('should have no-cache header', async () => {
      const response = await axios.get(`http://localhost:${TEST_PORT}/`);

      expect(response.headers['cache-control']).toBe('no-cache');
    });

    it('should contain WebSocket connection code', async () => {
      const response = await axios.get(`http://localhost:${TEST_PORT}/`);

      expect(response.data).toContain('WebSocket');
      expect(response.data).toContain('ws://');
    });

    it('should contain TikTok Reader title', async () => {
      const response = await axios.get(`http://localhost:${TEST_PORT}/`);

      expect(response.data).toContain('TikTok Reader');
      expect(response.data).toContain('動作確認用');
    });
  });

  describe('GET /test', () => {
    it('should return same content as root path', async () => {
      const rootResponse = await axios.get(`http://localhost:${TEST_PORT}/`);
      const testResponse = await axios.get(`http://localhost:${TEST_PORT}/test`);

      expect(testResponse.status).toBe(200);
      expect(testResponse.data).toBe(rootResponse.data);
    });
  });

  describe('GET /invalid-path', () => {
    it('should return 404 for invalid path', async () => {
      try {
        await axios.get(`http://localhost:${TEST_PORT}/invalid-path`);
        expect.unreachable('Should have thrown 404 error');
      } catch (error: any) {
        expect(error.response.status).toBe(404);
        expect(error.response.headers['content-type']).toContain('text/plain');
        expect(error.response.data).toContain('404 Not Found');
      }
    });

    it('should include available endpoints in 404 response', async () => {
      try {
        await axios.get(`http://localhost:${TEST_PORT}/some/random/path`);
        expect.unreachable('Should have thrown 404 error');
      } catch (error: any) {
        expect(error.response.data).toContain('Available endpoints');
        expect(error.response.data).toContain('GET / or /test');
        expect(error.response.data).toContain('WebSocket');
      }
    });
  });

  describe('Multiple requests', () => {
    it('should handle multiple concurrent requests', async () => {
      const requests = Array(10).fill(null).map(() =>
        axios.get(`http://localhost:${TEST_PORT}/`)
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.data).toContain('TikTok Reader');
      });
    });

    it('should handle mix of valid and invalid requests', async () => {
      const requests = [
        axios.get(`http://localhost:${TEST_PORT}/`),
        axios.get(`http://localhost:${TEST_PORT}/test`),
        axios.get(`http://localhost:${TEST_PORT}/invalid`).catch(e => e.response),
        axios.get(`http://localhost:${TEST_PORT}/`),
      ];

      const responses = await Promise.all(requests);

      expect(responses[0].status).toBe(200);
      expect(responses[1].status).toBe(200);
      expect(responses[2].status).toBe(404);
      expect(responses[3].status).toBe(200);
    });
  });

  describe('Request methods', () => {
    it('should handle POST request to root (returns test client)', async () => {
      const response = await axios.post(`http://localhost:${TEST_PORT}/`, {});

      // POSTでも同じハンドラーが呼ばれるのでHTMLが返る
      expect(response.status).toBe(200);
      expect(response.data).toContain('TikTok Reader');
    });

    it('should handle HEAD request', async () => {
      const response = await axios.head(`http://localhost:${TEST_PORT}/`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });
  });

  describe('Error handling', () => {
    it('should handle large number of requests without crashing', async () => {
      // Bun の Node HTTP 互換層では、同一プロセス内の server に 100 接続を
      // 同時生成すると OS/ランタイム都合の ECONNRESET が発生し得る。
      // 10 並列を 10 バッチ流し、総リクエスト数 100 と並列処理の両方を検証する。
      const responses = [];
      for (let batch = 0; batch < 10; batch += 1) {
        const batchResponses = await Promise.all(
          Array.from({ length: 10 }, () => axios.get(`http://localhost:${TEST_PORT}/`))
        );
        responses.push(...batchResponses);
      }

      expect(responses).toHaveLength(100);
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });
    });
  });
});
