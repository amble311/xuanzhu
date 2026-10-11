import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  StreamEmitter,
  withRetry,
} from "../src/llm/stream-retry";
import type { ChatOptions, StreamChunk } from "../src/llm/types";

const options = (signal?: AbortSignal): ChatOptions => ({
  messages: [],
  tools: [],
  signal,
});

/** 可重试的瞬时网络错误 */
const retryable = (): Error =>
  Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

/** 不可重试的错误（400） */
const fatal = (): Error =>
  Object.assign(new Error("bad request"), { status: 400 });

async function drain(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const textOf = (chunks: StreamChunk[]): string =>
  chunks
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

const reasoningOf = (chunks: StreamChunk[]): string =>
  chunks
    .filter((c): c is { type: "reasoning"; text: string } => c.type === "reasoning")
    .map((c) => c.text)
    .join("");

describe("withRetry —— 未产出内容前的重试", () => {
  it("首次失败、第二次成功，内容只交付一次", async () => {
    let calls = 0;
    const run = (emit: StreamEmitter) =>
      (async function* () {
        calls++;
        if (calls === 1) throw retryable();
        const out = emit.text("done");
        if (out) yield { type: "text", text: out } as StreamChunk;
      })();

    const chunks = await drain(
      withRetry(options(), run, { backoffMs: () => 0 }),
    );
    expect(calls).toBe(2);
    expect(textOf(chunks)).toBe("done");
  });

  it("全部尝试都失败时抛出最后一次错误", async () => {
    let calls = 0;
    const run = () =>
      (async function* () {
        calls++;
        throw retryable();
      })();

    await expect(
      drain(withRetry(options(), run, { backoffMs: () => 0 })),
    ).rejects.toThrow("socket hang up");
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it("不可重试的错误立即抛出，不重试", async () => {
    let calls = 0;
    const run = () =>
      (async function* () {
        calls++;
        throw fatal();
      })();

    await expect(
      drain(withRetry(options(), run, { backoffMs: () => 0 })),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  it("已中断的 signal 不再重试", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const run = () =>
      (async function* () {
        calls++;
        throw retryable();
      })();

    await expect(
      drain(withRetry(options(controller.signal), run, { backoffMs: () => 0 })),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("onRetry 回调带 resumed=false", async () => {
    const infos: boolean[] = [];
    let calls = 0;
    const run = () =>
      (async function* () {
        calls++;
        if (calls === 1) throw retryable();
      })();

    await drain(
      withRetry(
        { ...options(), onRetry: (_a, _m, _e, info) => infos.push(info.resumed) },
        run,
        { backoffMs: () => 0 },
      ),
    );
    expect(infos).toEqual([false]);
  });
});

describe("withRetry —— 输出中途断连的续传", () => {
  it("跳过已交付的重复前缀，只续传新增部分", async () => {
    let calls = 0;
    const run = (emit: StreamEmitter) =>
      (async function* () {
        calls++;
        if (calls === 1) {
          const out = emit.text("Hello, wor");
          if (out) yield { type: "text", text: out } as StreamChunk;
          throw retryable();
        }
        // 重跑：前 11 个字符与上次完全一致
        for (const piece of ["Hello", ", world!"]) {
          const out = emit.text(piece);
          if (out) yield { type: "text", text: out } as StreamChunk;
        }
      })();

    const chunks = await drain(
      withRetry(options(), run, { backoffMs: () => 0 }),
    );
    expect(calls).toBe(2);
    // 没有重复，拼接后是完整的一句话
    expect(textOf(chunks)).toBe("Hello, world!");
  });

  it("重跑前缀不一致时放弃续传，抛回原始网络错误", async () => {
    let calls = 0;
    const run = (emit: StreamEmitter) =>
      (async function* () {
        calls++;
        if (calls === 1) {
          const out = emit.text("Hello, wor");
          if (out) yield { type: "text", text: out } as StreamChunk;
          throw retryable();
        }
        const out = emit.text("Goodbye world");
        if (out) yield { type: "text", text: out } as StreamChunk;
      })();

    await expect(
      drain(withRetry(options(), run, { backoffMs: () => 0 })),
    ).rejects.toThrow("socket hang up");
    expect(calls).toBe(2);
  });

  it("前缀只重建了一部分就结束时，同样放弃续传", async () => {
    let calls = 0;
    const run = (emit: StreamEmitter) =>
      (async function* () {
        calls++;
        if (calls === 1) {
          const out = emit.text("abcdef");
          if (out) yield { type: "text", text: out } as StreamChunk;
          throw retryable();
        }
        const out = emit.text("abc");
        if (out) yield { type: "text", text: out } as StreamChunk;
      })();

    await expect(
      drain(withRetry(options(), run, { backoffMs: () => 0 })),
    ).rejects.toThrow("socket hang up");
  });

  it("续传时丢弃重跑的思考内容（保留第一遍的）", async () => {
    let calls = 0;
    const run = (emit: StreamEmitter) =>
      (async function* () {
        calls++;
        if (calls === 1) {
          const think = emit.reasoning("先想一下…");
          if (think) yield { type: "reasoning", text: think } as StreamChunk;
          const out = emit.text("答案前半");
          if (out) yield { type: "text", text: out } as StreamChunk;
          throw retryable();
        }
        const think = emit.reasoning("这次想得不一样");
        if (think) yield { type: "reasoning", text: think } as StreamChunk;
        const out = emit.text("答案前半与后半");
        if (out) yield { type: "text", text: out } as StreamChunk;
      })();

    const chunks = await drain(
      withRetry(options(), run, { backoffMs: () => 0 }),
    );
    expect(reasoningOf(chunks)).toBe("先想一下…");
    expect(textOf(chunks)).toBe("答案前半与后半");
  });

  it("onRetry 回调在续传时带 resumed=true", async () => {
    const infos: boolean[] = [];
    let calls = 0;
    const run = (emit: StreamEmitter) =>
      (async function* () {
        calls++;
        if (calls === 1) {
          const out = emit.text("部分内容");
          if (out) yield { type: "text", text: out } as StreamChunk;
          throw retryable();
        }
        const out = emit.text("部分内容完整了");
        if (out) yield { type: "text", text: out } as StreamChunk;
      })();

    const chunks = await drain(
      withRetry(
        { ...options(), onRetry: (_a, _m, _e, info) => infos.push(info.resumed) },
        run,
        { backoffMs: () => 0 },
      ),
    );
    expect(infos).toEqual([true]);
    expect(textOf(chunks)).toBe("部分内容完整了");
  });

  it("已交付工具调用后不再重跑（避免副作用重复）", async () => {
    let calls = 0;
    const run = (emit: StreamEmitter) =>
      (async function* () {
        calls++;
        if (emit.toolCall()) {
          yield {
            type: "tool_call",
            toolCall: { id: "1", name: "bash", arguments: "{}" },
          } as StreamChunk;
        }
        throw retryable();
      })();

    await expect(
      drain(withRetry(options(), run, { backoffMs: () => 0 })),
    ).rejects.toThrow("socket hang up");
    expect(calls).toBe(1);
  });
});
