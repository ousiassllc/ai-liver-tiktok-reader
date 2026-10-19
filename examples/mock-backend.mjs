// reader 単独で動かすための mock backend（Issue #2782）。
//
// reader が backend に対して持つ契約はこの 4 つだけで、ai-liver 本体の実装は不要:
//   GET  /api/v1/render/sessions/:id/bootstrap                 Bearer render token → 200 {platform, live_url}
//   POST /api/v1/internal/tiktok-reader/gift                   X-Ingress-Token
//   POST /api/v1/internal/tiktok-reader/session/:id/comment    X-Ingress-Token
//   POST /api/v1/internal/tiktok-reader/session/:id/viewer-count  X-Ingress-Token
//
// 受信したイベントは `received` に溜め、GET /received で確認できる。
// 起動: node examples/mock-backend.mjs
//   MOCK_BACKEND_PORT (既定 8471), MOCK_INGRESS_TOKEN, MOCK_SESSION_ID,
//   MOCK_RENDER_TOKEN, MOCK_LIVE_URL
import { createServer } from 'node:http'

/**
 * @param {{ ingressToken: string, sessions: Record<string, { renderToken: string, liveUrl: string }> }} options
 */
export function createMockBackend({ ingressToken, sessions }) {
  const received = []

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }

  const readBody = req =>
    new Promise(resolve => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
        } catch {
          resolve(null)
        }
      })
    })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    const bootstrap = /^\/api\/v1\/render\/sessions\/([^/]+)\/bootstrap$/.exec(path)
    if (req.method === 'GET' && bootstrap) {
      const session = sessions[decodeURIComponent(bootstrap[1])]
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      if (!session || !bearer || bearer !== session.renderToken) return json(res, 401, { error: 'unauthorized' })
      return json(res, 200, { platform: 'tiktok', live_url: session.liveUrl })
    }

    if (req.method === 'GET' && path === '/received') return json(res, 200, received)

    if (path.startsWith('/api/v1/internal/tiktok-reader/') && req.method === 'POST') {
      if (req.headers['x-ingress-token'] !== ingressToken) return json(res, 401, { error: 'unauthorized' })
      const route = path.slice('/api/v1/internal/tiktok-reader/'.length)
      const kind = route === 'gift' ? 'gift' : /^session\/[^/]+\/(comment|viewer-count)$/.exec(route)?.[1]
      if (!kind) return json(res, 404, { error: 'not found' })
      received.push({ kind, path, body: await readBody(req) })
      return json(res, kind === 'viewer-count' ? 204 : 200, kind === 'viewer-count' ? undefined : {})
    }

    return json(res, 404, { error: 'not found' })
  })

  return { server, received }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env
  const sessionId = env.MOCK_SESSION_ID ?? 'dev-session'
  const { server } = createMockBackend({
    ingressToken: env.MOCK_INGRESS_TOKEN ?? 'dev-ingress-token',
    sessions: {
      [sessionId]: {
        renderToken: env.MOCK_RENDER_TOKEN ?? 'dev-render-token',
        liveUrl: env.MOCK_LIVE_URL ?? 'https://www.tiktok.com/@your-streamer/live',
      },
    },
  })
  const port = Number(env.MOCK_BACKEND_PORT ?? 8471)
  server.listen(port, () => console.log(`mock backend listening on :${port} (session ${sessionId})`))
}
