// bunfig.toml の [test] preload から読み込まれる、bun 下限バージョンガードの入口。
// 検査本体は ./vendor/bun-version-guard.mjs。ai-liver monorepo の tools/bun-version-guard と
// 同一内容の複製で、reader 単独の checkout でも動くよう同梱している
// （一致は tools/bun-version-guard/bun-version-guard.test.mjs が検査する）。
import { assertMinimumBunVersion } from './vendor/bun-version-guard.mjs'

assertMinimumBunVersion({
  packageRoot: import.meta.dir + '/..',
  reason:
    "テストは 'bun test --isolate' を使いますが、--isolate は 1.3.11 以降のフラグです。\n" +
    'それ以前の bun はこのフラグをエラーにせず黙って無視するため、mock.module の差し替えが\n' +
    'テストファイル間に漏れ、コードが正しくても 10 件前後が誤って fail します（Issue #1846）。',
})
