// `bun test` のデフォルトタイムアウトを宣言する共有モジュール（Issue #1874）。
//
// なぜ bunfig.toml ではなくここで設定するのか:
// bunfig.toml の `[test] timeout` は bun に認識されない。未知のキーは警告も出ずに
// 無視されるため、`tiktok-reader` / `stream-renderer` の `timeout = 10000` は
// 一度も効いていなかった（bun 1.3.14 で実測: timeout を宣言しても既定の 5000ms で
// タイムアウトする）。package.json の `--timeout` フラグが常に勝っていたのではなく、
// bunfig 側の値は最初から死んでいた。
//
// そのため「bunfig に寄せる」ことはできず、かといって CLI フラグに寄せると
// `bun test` の直接実行が既定の 5000ms に落ちて `bun run test` と挙動が食い違う。
// `[test] preload` から `setDefaultTimeout()` を呼べば、どちらの経路でも同じ値が
// 適用され、宣言箇所も 1 つで済む。

import { setDefaultTimeout } from 'bun:test'

/**
 * テスト 1 件あたりのデフォルトタイムアウト（ミリ秒）。
 *
 * 15000 は移行前に package.json の `--timeout 15000` として実際に効いていた値。
 * bunfig の 10000 は前述のとおり一度も適用されていないため、これを採用すると
 * 実効タイムアウトを 15s から 10s へ縮める変更になってしまう。CI の実挙動を
 * 変えないため、実際に効いていた 15000 を唯一の宣言値とする。
 */
export const DEFAULT_TEST_TIMEOUT_MS = 15000

/**
 * 実行中の `bun test` にデフォルトタイムアウトを適用する。
 *
 * 通常は各パッケージの `bunfig.toml` の `[test] preload` 経由で呼ばれる。
 * `tools/` 配下のテストはリポジトリルートから走り、ルートには bunfig.toml が無い
 * （置くとこのツール自身の負の対照が壊れる）ため、テストファイルの先頭から直接呼ぶ経路もある。
 * 現在の該当ファイルは tools/bun-test-timeout/README.md の
 * 「preload を経由しない呼び出し」節を参照（Issue #2168, #2346）。
 */
export function applyDefaultTestTimeout(timeoutMs = DEFAULT_TEST_TIMEOUT_MS) {
  setDefaultTimeout(timeoutMs)
  return timeoutMs
}
