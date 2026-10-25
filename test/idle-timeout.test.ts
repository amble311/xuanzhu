import { describe, expect, it } from "vitest";
import { withIdleTimeout } from "../src/llm/http";

/**
 * `withIdleTimeout` —— 2026-10-25「本地端点连上但不吐数据 → TUI 永久卡死」的修复。
 *
 * 四个关键行为：
 * 1. 正常流不被误杀；
 * 2. 等首字节阶段超时会中断；
 * 3. 流中途断供也会中断（AbortSignal 覆盖不到）；
 * 4. 超时后的清理**不等待** `iterator.return()`（生成器可能正卡在永不 resolve 的 await 里）。
 */

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** 一个永远不产出、也不结束的迭代器 */
const stuckSource: AsyncIterable<number> = {
  [Symbol.asyncIterator]() {
    return {
      next: () => new Promise<IteratorResult<number>>(() => undefined),
    };
  },
};

describe("withIdleTimeout", () => {
  it("正常流照常产出，不会被超时误杀", async () => {
    const source: AsyncIterable<number> = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield 2;
      },
    };

    await expect(collect(withIdleTimeout(source, 200))).resolves.toEqual([1, 2]);
  });

  it("等首字节阶段没有任何数据 → 抛出 timeout 错误", async () => {
    await expect(collect(withIdleTimeout(stuckSource, 20))).rejects.toThrow(
      /timeout/i,
    );
  });

  it("流中途不再来数据 → 同样中断（已收到的部分不受影响）", async () => {
    const received: number[] = [];
    const source: AsyncIterable<number> = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        // 模拟「响应已开始、后续 chunk 永远不来」
        await new Promise(() => undefined);
      },
    };

    await expect(
      (async () => {
        for await (const value of withIdleTimeout(source, 20)) {
          received.push(value);
        }
      })(),
    ).rejects.toThrow(/timeout/i);
    expect(received).toEqual([1]);
  });

  it("超时后不等待 iterator.return()（否则仍会挂死）", async () => {
    let returnCalled = false;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<number>>(() => undefined),
          return: () => {
            returnCalled = true;
            // 清理本身也可能卡住 —— 调用方绝不能 await 它
            return new Promise<IteratorResult<number>>(() => undefined);
          },
        };
      },
    };

    const started = Date.now();
    await expect(collect(withIdleTimeout(source, 20))).rejects.toThrow(/timeout/i);

    expect(returnCalled).toBe(true);
    // 若等待了 return()，这里会一直挂到 vitest 超时
    expect(Date.now() - started).toBeLessThan(500);
  });
});
