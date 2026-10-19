// Issue #641: tiktok-reader は WebSocket 経由でギフト/コメント等のイベントを
// admin-frontend / backend に転送するだけの薄い pass-through 層であり、
// AI 応答生成・会話履歴保存 (`POST /conversation`) や rally 追随
// (`POST /rally/gift-followup`) の pipeline は保持していない。
//
// 仕様書 §3-1 の「gift 受信 → primary 応答 → secondary 追随」の 2 ターン rally は
// admin public render route 側の配信 pipeline で完結する。tiktok-reader が触るのは
// `POST /gift` (ギフトログ登録) と `POST /session/:id/viewer-count` のみで、
// `triggered_by='gift'` を含む会話履歴保存は行わない。
//
// もし将来 tiktok-reader に AI 生成 pipeline を持ち込むことになれば、本ファイルの
// 直下に `createConversationForGift` / `createRallyGiftFollowup` を追加し、
// 仕様書 §3-1 のフローを実装する。
import axios from 'axios';
import { CommentApiPayload, GiftApiPayload, ViewerCountApiPayload } from '../types/api';
import { logger } from '../utils/logger';
import { hashForLog } from '../utils/hash-for-log';

// Issue #726: tiktok-reader は Cloud Run バックグラウンドワーカーで admin セッション
// Cookie を持たないため、backend の adminProtected 配下の POST /gift と
// POST /session/{id}/viewer-count を直接叩くと常に 401 になる。
// 新設した service-to-service ingress endpoint (/internal/tiktok-reader/*) を
// BACKEND_INGRESS_TOKEN 共有シークレットで認証して呼ぶ。
const INGRESS_TOKEN_HEADER = 'X-Ingress-Token';

/**
 * Issue #825: cloud streaming の render page が /ws/events に接続する際、
 * 静的な TIKTOK_READER_SHARED_SECRET を持てない (public バンドルに埋め込むと露出するため)。
 * その代替として、admin render runtime から受け取った render token を backend に問い合わせて
 * 有効性を検証する。バリデーションは backend の `/api/v1/render/sessions/:session_id/bootstrap`
 * (Bearer render_token) を叩き、200 と platform=='tiktok' を確認する。
 */
export interface RenderTokenVerificationResult {
  valid: boolean;
  platform?: string;
  /**
   * bootstrap 応答の `live_url`。render token の接続を許可する配信者を決めるために使う
   * （Issue #2782）。bootstrap の他のフィールドは reader では使わない。
   */
  liveUrl?: string;
}

export class BackendApiService {
  /** `BACKEND_API_URL`（`/api/v1` まで含む）。未設定なら backend 連携は無効（Issue #2782）。 */
  private baseUrl: string | null;
  private ingressToken: string;
  private readonly renderVerifyTimeoutMs: number;

  constructor() {
    // Issue #2782: 単独利用で private な既定 endpoint へ自動通信しないよう、既定値は持たない。
    // BACKEND_API_URL を明示したときだけ render token 検証とイベント転送を行う。
    this.baseUrl = process.env.BACKEND_API_URL?.trim() || null;
    this.ingressToken = process.env.BACKEND_INGRESS_TOKEN || '';
    // Issue #825: WS upgrade 中に呼ぶため短めのタイムアウト (env で上書き可)。
    const raw = process.env.BACKEND_RENDER_VERIFY_TIMEOUT_MS;
    const parsed = raw ? parseInt(raw, 10) : NaN;
    this.renderVerifyTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
  }

  /** BACKEND_API_URL が設定され、backend 連携が有効か。 */
  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * Issue #825: render token が指定 session_id に対して有効か backend に問い合わせる。
   * 200 かつ `platform === 'tiktok'` の場合のみ valid=true を返す。
   * ネットワーク失敗・4xx/5xx はすべて valid=false（fail-closed）。
   */
  async verifyRenderToken(
    renderToken: string,
    sessionId: string
  ): Promise<RenderTokenVerificationResult> {
    if (!renderToken || !sessionId || !this.baseUrl) {
      // backend 連携が未設定なら render token は検証できないため fail-closed。
      return { valid: false };
    }
    const url = `${this.baseUrl}/render/sessions/${encodeURIComponent(sessionId)}/bootstrap`;
    try {
      const res = await axios.get<{ platform?: string; live_url?: string }>(url, {
        timeout: this.renderVerifyTimeoutMs,
        headers: {
          Authorization: `Bearer ${renderToken}`
        },
        validateStatus: (status) => status < 500
      });
      if (res.status !== 200) {
        logger.warn('render token 検証失敗（backend 応答）', {
          status: res.status,
          session_id: sessionId
        });
        return { valid: false };
      }
      const platform = res.data?.platform;
      return { valid: platform === 'tiktok', platform, liveUrl: res.data?.live_url };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('render token 検証で backend 呼び出しに失敗:', {
          url,
          status: error.response?.status,
          message: error.message
        });
      } else {
        logger.error('render token 検証で予期しないエラー:', error);
      }
      return { valid: false };
    }
  }

  /**
   * Issue #726: service-to-service 認証用の共通ヘッダを組み立てる。
   * BACKEND_INGRESS_TOKEN が空文字の場合はヘッダを付与しない (backend 側で 401 になる)。
   * この場合は startup 時に warn を出すのが理想だが、環境変数未設定でもプロセスを
   * 落とさないため fail-open で送信を試み backend 側で 401 になった時点でログに残す。
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.ingressToken) {
      headers[INGRESS_TOKEN_HEADER] = this.ingressToken;
    }
    return headers;
  }

  async sendGift(data: GiftApiPayload): Promise<void> {
    // Issue #726: /gift → /internal/tiktok-reader/gift に変更 (ingress endpoint)。
    if (!this.baseUrl) return;
    const url = `${this.baseUrl}/internal/tiktok-reader/gift`;
    try {
      await axios.post(url, data, {
        timeout: 5000,
        headers: this.buildHeaders()
      });

      logger.info('ギフト情報をBackend APIに送信しました', {
        session_id: data.session_id,
        // PII を平文ログに残さないため user_name はハッシュのみ記録する（Issue #2782）。
        userHash: hashForLog(data.user_name),
        gift: data.gift_type,
        amount: data.gift_amount
      });
    } catch (error) {
      // エラーでも処理は継続（admin render 通知は別で行われる）
      if (axios.isAxiosError(error)) {
        logger.error('Backend APIへのギフト送信に失敗:', {
          url,
          status: error.response?.status,
          message: error.message
        });
      } else {
        logger.error('Backend APIへのギフト送信に失敗:', error);
      }
    }
  }

  /**
   * TikTok Live の WebcastEvent.ROOM_USER から取得した viewerCount を
   * POST /session/{sessionId}/viewer-count で backend に push する（Issue #615）。
   *
   * spec (docs/content/docs/specifications/live-monitoring/api.md §3):
   *   「TikTok 配信時は tiktok-reader の最新 viewerCount をバックエンドが受け取って保存」
   * backend 側は 204 No Content を返す。失敗しても WebSocket 経由の通知は継続するため
   * ここでは throw せずログに残すのみ（sendGift と同じ fail-open ポリシー）。
   */
  async sendViewerCount(sessionId: string, count: number | null): Promise<void> {
    // Issue #726: /session/{id}/viewer-count → /internal/tiktok-reader/session/{id}/viewer-count
    // (adminProtected 配下から service-to-service ingress endpoint に切替)。
    if (!this.baseUrl) return;
    const url = `${this.baseUrl}/internal/tiktok-reader/session/${sessionId}/viewer-count`;
    const payload: ViewerCountApiPayload = { count };
    try {
      await axios.post(url, payload, {
        timeout: 5000,
        headers: this.buildHeaders()
      });
      logger.info('視聴者数をBackend APIに送信しました', {
        session_id: sessionId,
        count
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('Backend APIへの視聴者数送信に失敗:', {
          url,
          status: error.response?.status,
          message: error.message
        });
      } else {
        logger.error('Backend APIへの視聴者数送信に失敗:', error);
      }
    }
  }

  /**
   * TikTok Live の WebcastEvent.CHAT で受信したコメントを
   * POST /internal/tiktok-reader/session/{sessionId}/comment で backend に push する（Issue #2154）。
   *
   * backend は受信したコメントを `session_comments` に記録し、MCP の `pick_ai_comments`
   * がそこから AI に渡す候補を選ぶ。YouTube は backend 内のポーラーが直接書き込めるが、
   * TikTok のコメントは本サービスしか受信できないため、この転送が唯一の供給経路になる。
   *
   * 視聴者への WebSocket 配信が主目的であり、転送失敗で配信を止めてはならないため
   * ここでは throw せずログに残すのみ（sendGift / sendViewerCount と同じ fail-open ポリシー）。
   */
  async sendComment(sessionId: string, payload: CommentApiPayload): Promise<void> {
    // sessionId は WebSocket 接続時のクエリ由来でありパス区切りを含み得るため、
    // verifyRenderToken と同じく encodeURIComponent で URL に埋め込む。
    if (!this.baseUrl) return;
    const url = `${this.baseUrl}/internal/tiktok-reader/session/${encodeURIComponent(sessionId)}/comment`;
    try {
      await axios.post(url, payload, {
        timeout: 5000,
        headers: this.buildHeaders()
      });
      // PII を平文ログに残さないため username は出力せず、長さのみ記録する
      // （tiktok-event-handlers の「コメント配信」ログと同じ方針）。
      logger.info('コメントをBackend APIに送信しました', {
        session_id: sessionId,
        platform_comment_id: payload.platform_comment_id,
        text_len: payload.text.length
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('Backend APIへのコメント送信に失敗:', {
          url,
          status: error.response?.status,
          message: error.message
        });
      } else {
        logger.error('Backend APIへのコメント送信に失敗:', error);
      }
    }
  }
}
