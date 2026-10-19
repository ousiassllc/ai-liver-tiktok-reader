// bunfig.toml の [test] preload から読み込まれる、テストのデフォルトタイムアウト設定の入口。
// 値と理由は ./vendor/bun-test-timeout.mjs。ai-liver monorepo の tools/bun-test-timeout と
// 同一内容の複製で、reader 単独の checkout でも動くよう同梱している
// （一致は tools/bun-test-timeout/bun-test-timeout.test.mjs が検査する）。
//
// bunfig.toml の `[test] timeout` は bun に無視されるため、ここで設定しないと
// `bun test` の直接実行が既定の 5000ms になる（Issue #1874）。
import { applyDefaultTestTimeout } from './vendor/bun-test-timeout.mjs'

applyDefaultTestTimeout()
