import type { Mock } from 'bun:test';

/**
 * bun:test に無い jest の型ユーティリティを補うヘルパ。
 *
 * bun-types は `jest.Mock` は提供するが `jest.Mocked` / `jest.SpyInstance` は
 * 提供しない (bun-types/test.d.ts では Mocked がコメントアウトされている)。
 * jest からの移行でこれらを使っていた箇所を置き換えるために定義する。
 */

/**
 * オブジェクト型のメソッドをすべて Mock に置き換えた型 (jest.Mocked 相当)。
 *
 * `T &` を前置して交差型にするのは @types/jest の MockedObjectDeep と同じ理由。
 * Mock<T> は overload を持つメソッドや private プロパティを再現できないため、
 * これがないと Mocked<T> を T として渡せなくなる。
 */
export type Mocked<T> = T & {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? Mock<(...args: A) => R>
    : T[K];
};

/**
 * 引数・戻り値を問わない Mock 型 (jest.SpyInstance 相当)。
 *
 * 型引数は bun-types の `Mock` の既定型と同じ形にする。`never[]` にすると
 * toHaveBeenCalledWith の引数が never に推論されて呼び出し側が型エラーになる。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMock = Mock<(...args: any[]) => any>;
