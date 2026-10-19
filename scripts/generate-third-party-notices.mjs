// 本番依存（package-lock.json の dev でないもの）のライセンス表示を標準出力へ書き出す。
//
// 使い方: `npm ci --omit=dev` 済みの node_modules が必要。
//   node scripts/generate-third-party-notices.mjs > THIRD_PARTY_NOTICES.txt
// Dockerfile の runtime ステージが同じ手順で THIRD_PARTY_NOTICES.txt をイメージに入れる
// （Issue #2782: 既存の著作権・ライセンス表示を runtime image に保存する）。
//
// 各パッケージの宣言ライセンスと、同梱の LICENSE / NOTICE ファイル本文をそのまま出す。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

const LICENSE_FILE = /^(licen[cs]e|notice|copying)(\.|$)/i

const declaredLicense = pkg => {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(item => item.type).join(' OR ')
  return 'UNKNOWN'
}

const entries = Object.entries(lock.packages)
  .filter(([path, info]) => path.startsWith('node_modules/') && info.dev !== true)
  .sort(([a], [b]) => a.localeCompare(b))

const out = []
out.push('THIRD-PARTY NOTICES (tiktok-reader production dependencies)\n')
out.push(`Generated from package-lock.json: ${entries.length} packages.\n`)

for (const [path, info] of entries) {
  const dir = join(root, path)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue // optional dependency が当該環境に入っていない場合
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  out.push('='.repeat(78))
  out.push(`${manifest.name}@${manifest.version}`)
  out.push(`License: ${declaredLicense(manifest)}`)
  if (info.resolved) out.push(`Source: ${info.resolved}`)
  out.push('')
  for (const file of readdirSync(dir).filter(name => LICENSE_FILE.test(name)).sort()) {
    out.push(`--- ${file} ---`)
    out.push(readFileSync(join(dir, file), 'utf8').trimEnd())
    out.push('')
  }
}

process.stdout.write(out.join('\n') + '\n')
