// tsconfig の moduleResolution を TypeScript 6 対応の値に固定する回帰テスト (Issue #1866)。
//
// `moduleResolution: "node"` は TypeScript 6 で削除される非推奨の別名で、
// 削除後は設定エラーになり build と CI の typecheck が落ちる。
// tsc の option table 上 "node" と "node10" はどちらも ModuleResolutionKind.Node10 に
// 解決されるため出力は変わらないが、宣言値が "node" へ戻されると
// TypeScript を上げた時点で初めて壊れ、原因が分かりにくい。
// 宣言値と extends 解決後の実効値の双方を固定して、その差し戻しを検知する。

import { describe, expect, it } from 'bun:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEPRECATED_ALIAS = 'node'

/**
 * tsconfig を JSONC として読む（コメントを含むため JSON.parse は使えない）。
 *
 * @param {string} fileName パッケージルートからの相対パス
 * @returns {{ configFilePath: string, config: any }}
 */
function readConfig(fileName) {
  const configFilePath = resolve(PACKAGE_ROOT, fileName)
  const { config, error } = ts.readConfigFile(configFilePath, ts.sys.readFile)
  expect(error).toBeUndefined()
  return { configFilePath, config }
}

/**
 * extends を解決した実効オプションを得る。
 *
 * @param {string} fileName パッケージルートからの相対パス
 * @returns {import('typescript').CompilerOptions}
 */
function resolveOptions(fileName) {
  const { configFilePath, config } = readConfig(fileName)
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, PACKAGE_ROOT, undefined, configFilePath)
  expect(parsed.errors).toEqual([])
  return parsed.options
}

describe('tsconfig moduleResolution (Issue #1866)', () => {
  it('tsconfig.json は非推奨の "node" ではなく "node10" を宣言する', () => {
    const declared = readConfig('tsconfig.json').config.compilerOptions.moduleResolution

    expect(declared).not.toBe(DEPRECATED_ALIAS)
    expect(declared).toBe('node10')
  })

  it('tsconfig.build.json は extends 経由でも Node10 に解決される', () => {
    expect(resolveOptions('tsconfig.build.json').moduleResolution).toBe(ts.ModuleResolutionKind.Node10)
  })

  it('build の出力形式は CommonJS のままである', () => {
    expect(resolveOptions('tsconfig.build.json').module).toBe(ts.ModuleKind.CommonJS)
  })
})
