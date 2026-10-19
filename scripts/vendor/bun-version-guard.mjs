// bun の下限バージョンを検査する共有ガード（Issue #1846, #1865, #1864）。
//
// 各パッケージの package.json の `engines.bun` を唯一の宣言箇所として読み、
// 実行中の bun がそれを下回るなら理由を表示してテスト実行前に停止する。
//
// npm の engine 検査は `node` / `npm` キーしか見ないため、`engines.bun` を宣言しても
// npm は何も警告しない（`engine-strict=true` でも同じ）。宣言を実効化するのがこの検査。
//
// 各パッケージの bunfig.toml の `[test] preload` から呼ぶ。preload は `bun test` 自身が
// 読み込むため、`bun run test` / `npm test` だけでなく `bun test` の直接実行でもガードが効く
// （pretest 方式は前者しか通らず迂回できた: #1865）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * セマンティックバージョン文字列を数値配列へ変換する。
 * 先頭の `v` と prerelease / build 表記（`-` / `+` 以降）は無視する。
 *
 * @param {unknown} version 例: `'v1.3.10'`, `'1.3.11'`, `'1.4.0-canary.1'`
 * @returns {[number, number, number] | null} パースできなければ null
 */
export function parseVersion(version) {
  if (typeof version !== 'string') return null

  const core = version.trim().replace(/^v/, '').split(/[-+]/, 1)[0]
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(core)
  if (matched === null) return null

  return [Number(matched[1]), Number(matched[2]), Number(matched[3])]
}

/**
 * `actual` が `minimum` 以上かを判定する。
 *
 * @param {unknown} actual 検査対象のバージョン
 * @param {unknown} minimum 下限バージョン
 * @returns {boolean | null} 満たすなら true、下回るなら false、パース不能なら null
 */
export function satisfiesMinimum(actual, minimum) {
  const actualParts = parseVersion(actual)
  const minimumParts = parseVersion(minimum)
  if (actualParts === null || minimumParts === null) return null

  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index] !== minimumParts[index]) {
      return actualParts[index] > minimumParts[index]
    }
  }
  return true
}

/**
 * package.json の `engines.bun` から下限バージョンを取り出す。
 *
 * 本リポジトリは下限の宣言にしか `engines.bun` を使わないため、
 * 対応するのは `>=x.y.z` 表記のみ。他の range 表記は「宣言なし」として扱い、
 * 誤って緩い判定をするより検知できないことを明示する。
 *
 * @param {string} packageRoot package.json があるディレクトリ
 * @returns {{ name: string, minimum: string | null, declared: string | undefined }}
 */
export function readBunEngine(packageRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const declared = manifest?.engines?.bun
  const matched = typeof declared === 'string' ? /^>=\s*(\d+\.\d+\.\d+)$/.exec(declared.trim()) : null

  return {
    name: typeof manifest?.name === 'string' ? manifest.name : packageRoot,
    minimum: matched === null ? null : matched[1],
    declared,
  }
}

/**
 * 下限を満たさないときに表示する診断メッセージを組み立てる。
 *
 * CI が pin しているバージョンをここに直書きすると check.yml と二重管理になるため、
 * 具体的な値ではなく参照先を示す。
 */
function buildTooOldMessage({ name, minimum, actual, reason }) {
  return [
    `[bun-version-guard] ${name} は bun ${minimum} 以上が必要ですが、実行中の bun は ${actual} です。`,
    ...(reason === undefined ? [] : [reason]),
    `下限は ${name}/package.json の engines.bun に宣言されています。`,
    'CI は .github/workflows/check.yml で pin した bun を使うため、この失敗はローカル環境固有です。',
    "更新方法: 'bun upgrade'",
  ].join('\n')
}

/**
 * 実行中の bun が下限を満たすか検査し、満たさない場合は理由を表示して停止する。
 *
 * 依存を注入できるようにしているのは、実際に古い bun を用意しなくても
 * 「下限未満なら停止する」ことをテストで検証できるようにするため。
 *
 * @param {object} options
 * @param {string} options.packageRoot 検査対象パッケージのルート
 * @param {string} [options.reason] そのパッケージ固有の、下限が必要な理由
 * @param {unknown} [options.version] 検査するバージョン（既定: 実行中の `Bun.version`）
 * @param {(message: string) => void} [options.onMessage] 診断メッセージの出力先
 * @param {(code: number) => void} [options.onTooOld] 下限未満だったときの停止処理
 * @returns {'ok' | 'too-old' | 'unknown' | 'not-bun' | 'undeclared'} 判定結果
 */
export function assertMinimumBunVersion({
  packageRoot,
  reason,
  version,
  onMessage = message => console.error(message),
  onTooOld = code => process.exit(code),
}) {
  const { name, minimum, declared } = readBunEngine(packageRoot)

  if (minimum === null) {
    onMessage(
      `[bun-version-guard] ${name} の engines.bun が '>=x.y.z' 形式ではないため` +
        `（宣言値: ${JSON.stringify(declared)}）、下限を検査できません。`
    )
    return 'undeclared'
  }

  const detected = typeof Bun === 'undefined' ? undefined : Bun.version
  const actual = version === undefined ? detected : version

  if (actual === undefined) {
    onMessage('[bun-version-guard] bun ランタイムで実行されていないため、バージョンを判定できません。')
    return 'not-bun'
  }

  const result = satisfiesMinimum(actual, minimum)
  if (result === null) {
    onMessage(
      `[bun-version-guard] bun のバージョン '${actual}' を解釈できないため、` +
        `${minimum} 以上かを判定できません。`
    )
    return 'unknown'
  }

  if (result === false) {
    onMessage(buildTooOldMessage({ name, minimum, actual, reason }))
    onTooOld(1)
    return 'too-old'
  }

  return 'ok'
}
