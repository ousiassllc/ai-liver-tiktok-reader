// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

// Issue #2658: backend/admin-frontend に続き tiktok-reader へも ESLint を導入する。
// tsc --noEmit では検出できない未使用変数・Promise 未 await・`any` 濫用等を
// CI (tiktok-reader-check) と pre-push で検知する。
export default tseslint.config(
  {
    // scripts/vendor は monorepo の tools/ からの逐語複製（一致はテストで検査）なので lint しない。
    ignores: ['dist/**', 'coverage/**', 'scripts/vendor/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // 初回導入時点で tests/**/*.test.ts および *-test-setup.ts に
    // 139 件の no-explicit-any (WebSocket/gift 等イベントペイロードのモック
    // fixture が型不定) と 11 件の no-require-imports (bun の mock.module は
    // ESM import を hoist するため、モック登録後に require() で再取得しないと
    // 実体を得られない) が集中していた。src/ 配下は 0 件で既にクリーンなため、
    // 本番コードの厳格さは維持しつつ、テストのみ可視性を残す warn にとどめる。
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
    },
  },
)
