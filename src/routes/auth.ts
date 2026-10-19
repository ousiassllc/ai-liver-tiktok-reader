// Issue #1437: `routes/index.ts` から WebSocket 認証まわりを分離。
// - shared secret 検証 (`isSharedSecretAuthorized`)
// - render token 抽出 (`extractRenderTokenFromProtocol`) と検証
//   (`isRenderTokenAuthorized`)
// - 上記が参照する `RENDER_WEBSOCKET_PROTOCOL` 定数と `RenderTokenVerifier` 型
//
// `RouterContext` は `routes/index.ts` 側で保持し、必要な依存を引数で受け取る。
import type { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';
import { extractUsername } from '../utils/url-parser';

/**
 * Issue #825: render page 認証用に render token を backend で検証するインターフェース。
 * WebSocket upgrade 中に呼ばれるので、非同期・タイムアウト付きで実装する。
 */
export interface RenderTokenVerifier {
  verifyRenderToken(
    renderToken: string,
    sessionId: string
  ): Promise<{ valid: boolean; platform?: string; liveUrl?: string }>;
}

/**
 * Issue #2782: upgrade 時に認証した接続が `connect` 本文で扱ってよい範囲。
 * 認証結果を boolean で捨てると、認証済み session-A の接続が本文で session-B や別配信者を
 * 指定できてしまう。そのため認証成功時の scope を WebSocket 接続に保持し、`connect` 本文と
 * 突き合わせる（WebSocketHandler）。
 * `null` は「その軸に制限なし」を表す。
 */
export interface WebSocketAuthScope {
  /** 接続を許可する session_id。 */
  sessionId: string | null;
  /** 接続を許可する TikTok 配信者の username（小文字）。 */
  username: string | null;
}

/** 共有 secret 経路（サーバー間用途）の scope。session / 配信者を制限しない。 */
export const UNRESTRICTED_SCOPE: WebSocketAuthScope = Object.freeze({
  sessionId: null,
  username: null,
});

// Issue #825: YouTube 側と揃えた WebSocket subprotocol 命名。
// render 経路は Sec-WebSocket-Protocol ヘッダに
// `ai-liver-render-v1` と `ai-liver-render-token.<token>` の 2 つを乗せて渡す。
// URL クエリでの露出を避けるため、subprotocol を第一の伝送路として採用する。
export const RENDER_WEBSOCKET_PROTOCOL = 'ai-liver-render-v1';
export const RENDER_WEBSOCKET_TOKEN_PROTOCOL_PREFIX = 'ai-liver-render-token.';

/**
 * WebSocket 接続時の共有シークレット検証。
 *
 * refine-sweep iter-1 backend CRITICAL:
 * /ws/events は TikTok Live 接続を任意のユーザーに張らせられるため、
 * 未認証で公開すると濫用・レート制限枯渇のリスクがある。
 * TIKTOK_READER_SHARED_SECRET が設定されている場合のみ、
 * X-Reader-Secret ヘッダまたは ?secret= クエリで受け取った値と
 * timingSafeEqual で比較して一致した接続のみ受け付ける。
 * 未設定時はshared secret経路を無効化し、呼び出し側でrender token検証へ進む。
 */
export function isSharedSecretAuthorized(request: IncomingMessage, url: URL): boolean {
  const expected = process.env.TIKTOK_READER_SHARED_SECRET;
  if (!expected) {
    return false;
  }
  const rawProvided =
    (request.headers['x-reader-secret'] as string | undefined) ||
    url.searchParams.get('secret') ||
    '';
  const provided = Array.isArray(rawProvided) ? rawProvided[0] : rawProvided;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/**
 * Issue #825: Sec-WebSocket-Protocol ヘッダから render token を取り出す。
 * render client は `ai-liver-render-v1` と `ai-liver-render-token.<token>` の 2 protocol を送るため、
 * 後者のプレフィックスから token 部分を抽出する。
 * 見つからない場合は空文字を返す。
 */
export function extractRenderTokenFromProtocol(request: IncomingMessage): string {
  const header = request.headers['sec-websocket-protocol'];
  if (!header) return '';
  const values = Array.isArray(header) ? header : header.split(',');
  for (const raw of values) {
    const trimmed = raw.trim();
    if (trimmed.startsWith(RENDER_WEBSOCKET_TOKEN_PROTOCOL_PREFIX)) {
      return trimmed.slice(RENDER_WEBSOCKET_TOKEN_PROTOCOL_PREFIX.length);
    }
  }
  return '';
}

/**
 * Issue #825: render page 用の render token 認証。
 * cloud streaming の render page は public バンドルに shared secret を埋め込めないため、
 * admin-frontend 側で発行された render token を WebSocket subprotocol 経由で渡し、backend の
 * `/api/v1/render/sessions/:session_id/bootstrap` (Bearer render_token) で検証する。
 * platform=='tiktok' の場合のみ許可する。
 *
 * Issue #2782: 認可成功時は、認証した session_id と bootstrap の `live_url` から決まる配信者を
 * `WebSocketAuthScope` として返す。`live_url` が空・解釈不能な場合は、許可する配信者を
 * 決められないため fail-closed で null を返す。
 *
 * `verifier` が null、または認証不成立の場合は null を返す。
 */
export async function authorizeRenderToken(
  request: IncomingMessage,
  url: URL,
  verifier: RenderTokenVerifier | null
): Promise<WebSocketAuthScope | null> {
  if (!verifier) {
    return null;
  }
  const token = extractRenderTokenFromProtocol(request);
  const sessionId = url.searchParams.get('session_id') || '';
  if (!token || !sessionId) {
    return null;
  }
  const result = await verifier.verifyRenderToken(token, sessionId);
  if (!result.valid) {
    return null;
  }
  const username = extractUsername(result.liveUrl ?? '').toLowerCase();
  if (!username) {
    return null;
  }
  return { sessionId, username };
}
