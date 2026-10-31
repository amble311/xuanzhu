import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvents } from "../src/core/agent";
import { DEFAULT_CONFIG, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";

describe("真实 token usage 事件", () => {
  it("把服务端 usage 透传给界面，并保留上下文占用校正", async () => {
    const usages: Array<{ inputTokens?: number; outputTokens?: number }> = [];
    const events: AgentEvents = {
      onText: () => undefined,
      onToolStart: () => undefined,
      onToolEnd: () => undefined,
      onStatus: () => undefined,
      onUsage: (usage) => usages.push(usage),
      confirm: async () => true,
    };
    const config: XuanZhuConfig = {
      ...DEFAULT_CONFIG,
      provider: "fake",
      model: "fake",
      models: [
        {
          id: "fake/fake",
          provider: "fake",
          model: "fake",
          contextWindow: 100_000,
        },
      ],
    };
    const provider: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(_options: ChatOptions): AsyncGenerator<StreamChunk> {
        yield { type: "text", text: "ok" };
        yield {
          type: "done",
          finishReason: "stop",
          usage: {
            inputTokens: 1234,
            outputTokens: 56,
            cachedInputTokens: 900,
            cacheWriteInputTokens: 100,
          },
        };
      },
    };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-usage-"));
    const agent = new Agent(provider, config, cwd, events);
    await agent.run("hello");

    expect(usages).toEqual([
      {
        inputTokens: 1234,
        outputTokens: 56,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 100,
      },
    ]);
    expect(agent.getContextReport().ratio).toBeGreaterThan(0);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
