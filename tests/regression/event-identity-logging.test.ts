import { afterEach, expect, it, mock, spyOn } from 'bun:test';
import { WebSocket } from 'ws';
import { WebSocketHandler } from '../../src/handlers/websocket-handler';
import { UNRESTRICTED_SCOPE } from '../../src/routes/auth';
import { BackendApiService } from '../../src/services/backend-api-service';
import { ConnectionLimitError } from '../../src/services/connection-limits';
import type { ConnectionManager } from '../../src/services/connection-manager';
import { handleCommentEvent } from '../../src/services/tiktok-event-handlers';
import { hashForLog } from '../../src/utils/hash-for-log';

afterEach(() => mock.restore());

it('通常コメントのログは識別子をハッシュ化し、配信と backend 転送は元の値を保持する', () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const backend = new BackendApiService();
  const forward = spyOn(backend, 'sendComment').mockResolvedValue();
  const send = mock<(message: string) => void>(() => {});
  const uniqueId = 'private-viewer-handle';
  const nickname = 'private-viewer-name';
  const avatarUrl = 'https://example.com/private-viewer-avatar.jpg';

  handleCommentEvent({
    msgId: 'comment-1',
    user: { uniqueId, nickname, profilePictureUrl: avatarUrl },
    comment: 'hello',
  }, send, backend, 'session-1');

  const logs = JSON.stringify(log.mock.calls);
  for (const identity of [uniqueId, nickname, avatarUrl]) {
    expect(logs).not.toContain(identity);
    expect(logs).toContain(hashForLog(identity)!);
  }
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0][0]).data).toMatchObject({
    platformUserId: uniqueId, tiktokUserId: uniqueId, username: nickname, avatarUrl,
  });
  expect(forward).toHaveBeenCalledWith('session-1', expect.objectContaining({
    platform_comment_id: 'comment-1', platform_user_id: uniqueId, username: nickname, text: 'hello',
  }));
});

it.each(['total', 'per_user'] as const)('接続上限 %s のログは配信者をハッシュ化し、拒否応答を保持する', async reason => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const username = 'private-streamer-handle';
  const manager = {
    addClient: mock(async () => { throw new ConnectionLimitError(reason, 1, 1); }),
  };
  const ws = { readyState: WebSocket.OPEN, send: mock<(message: string) => void>(() => {}), close: mock() };
  const handler = new WebSocketHandler(manager as unknown as ConnectionManager, UNRESTRICTED_SCOPE);

  await handler.handleMessage(ws as unknown as WebSocket, JSON.stringify({
    type: 'connect', liveUrl: `@${username}`, sessionId: 'session-1',
  }));

  expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain(username);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('接続数上限に達したため接続を拒否'), {
    usernameHash: hashForLog(username), reason, limit: 1, current: 1,
  });
  expect(ws.send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
    type: 'error', data: { code: 'CONNECTION_LIMIT_EXCEEDED', reason },
  });
  expect(ws.close).toHaveBeenCalledWith(1013, 'connection limit exceeded');
});
