import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Issue #2347: `tiktok-live-connector@2.1.0` は package.json で `protobufjs@^6.11.2` を
 * 宣言しているが、配布コードからは一度も require しない（実際のデコードは
 * `@bufbuild/protobuf`）。この死んだ依存だけが `npm audit` に critical 1 / high 1 として
 * 残り続けていた。
 *
 * connector 本体を 2.4.4 へ上げる選択肢は採らず（理由は README / docs 参照）、
 * package.json の `overrides` で nested protobufjs を修正版の系列へ寄せて解消している。
 * overrides が将来の lock 再生成で落ちると audit が無言で赤に戻るため、lock に
 * 脆弱版の protobufjs が現れないことをテストで固定する。
 *
 * 閾値 7.6.3 の根拠（protobufjs に紐づく全 advisory の 7.x 系 first_patched の最大値）:
 * - GHSA-xq3m-2v4x-88gg (critical) -> 7.5.5
 * - GHSA-66ff-xgx4-vchm / GHSA-685m-2w69-288q (high) -> 7.5.6
 * - GHSA-f38q-mgvj-vph7 -> 7.6.3
 */

const MIN_PATCHED_PROTOBUFJS = '7.6.3';

/** `1.2.3` 形式のみを比較する。prerelease は lock に現れないため扱わない。 */
function compareVersions(a: string, b: string): number {
  const toParts = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10));
  const left = toParts(a);
  const right = toParts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * `^7.6.5` のような range の下限バージョンを取り出す。下限を持たない指定
 * (`*` / `latest` / `>7.6.2` など) は undefined を返し、呼び出し側で落とす。
 */
function lowerBoundOf(range: string): string | undefined {
  return /^\s*(?:\^|~|>=|=)?\s*(\d+\.\d+\.\d+)\s*$/.exec(range)?.[1];
}

type Lockfile = {
  packages?: Record<string, { version?: string }>;
};

type PackageJson = {
  dependencies: Record<string, string>;
  overrides?: Record<string, Record<string, string>>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as PackageJson;
}

function readInstalledProtobufjsVersions(): Array<{ path: string; version: string }> {
  const lockPath = join(__dirname, '../../package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lockfile;
  return Object.entries(lock.packages ?? {})
    .filter(([path]) => path.endsWith('node_modules/protobufjs'))
    .map(([path, entry]) => ({ path, version: entry.version ?? '0.0.0' }));
}

describe('protobufjs advisory regression (Issue #2347)', () => {
  it('compareVersions が major/minor/patch を桁ごとに比較する', () => {
    expect(compareVersions('6.11.6', '7.6.3')).toBeLessThan(0);
    expect(compareVersions('7.6.5', '7.6.3')).toBeGreaterThan(0);
    expect(compareVersions('7.6.3', '7.6.3')).toBe(0);
    // 文字列比較なら '10' < '9' となる桁上がりを取り違えないこと。
    expect(compareVersions('7.10.0', '7.9.0')).toBeGreaterThan(0);
  });

  it('package-lock.json に protobufjs が解決されている', () => {
    // 依存ツリーから protobufjs が消えた場合、下の「脆弱版なし」テストは
    // 空集合で自明に通ってしまう。ガードが生きていることを先に確かめる。
    expect(readInstalledProtobufjsVersions().length).toBeGreaterThan(0);
  });

  it('脆弱な protobufjs (< 7.6.3) が依存ツリーに残っていない', () => {
    const vulnerable = readInstalledProtobufjsVersions().filter(
      ({ version }) => compareVersions(version, MIN_PATCHED_PROTOBUFJS) < 0,
    );

    expect(vulnerable).toEqual([]);
  });

  it('lowerBoundOf が range の下限だけを取り出す', () => {
    expect(lowerBoundOf('^7.6.5')).toBe('7.6.5');
    expect(lowerBoundOf('~7.6.5')).toBe('7.6.5');
    expect(lowerBoundOf('>=7.6.5')).toBe('7.6.5');
    expect(lowerBoundOf('7.6.5')).toBe('7.6.5');
    // 下限を持たない / 判定できない指定は「安全側に倒せない」ので undefined。
    expect(lowerBoundOf('*')).toBeUndefined();
    expect(lowerBoundOf('latest')).toBeUndefined();
    expect(lowerBoundOf('>7.6.2')).toBeUndefined();
  });

  it('tiktok-live-connector は本番検証済みの 2.1.0 に固定されたまま', () => {
    // overrides はあくまで connector を 2.1.0 に留め置くための代替手段であり、
    // 「protobufjs だけ直したので connector も上げてよい」と誤読されないよう固定を明示する。
    expect(readPackageJson().dependencies['tiktok-live-connector']).toBe('2.1.0');
  });

  it('overrides の protobufjs が修正版以上のレンジを宣言している', () => {
    // 存在確認だけだと、誰かが `^6.11.2` へ書き戻しても lock を再生成するまで通る
    // （lock 側の検査は現に解決済みのツリーしか見ないため）。宣言そのものを閾値で縛る。
    const range = readPackageJson().overrides?.['tiktok-live-connector']?.protobufjs;

    expect(range).toBeDefined();

    const lowerBound = lowerBoundOf(range as string);

    expect(lowerBound).toBeDefined();
    expect(compareVersions(lowerBound as string, MIN_PATCHED_PROTOBUFJS)).toBeGreaterThanOrEqual(0);
  });
});
