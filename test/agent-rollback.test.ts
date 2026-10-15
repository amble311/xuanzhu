import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import {
  DEFAULT_CONFIG,
  type ModelEntry,
  type XuanZhuConfig,
} from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
import type { ToolDefinition } from "../src/tools/types";

/**
 * 中断（`Ctrl+D` / `Ctrl+C`）后**本轮整体回滚**：turn 里的消息一条都不进历史。
 *
 * 回归背景：曾经中断时只丢弃「对不齐的 assistant」，保留 user 与已完成的工具记录，
 * 于是历史里留下一条没有最终答复的 user 轮次；用户中断后发新消息，模型会先把旧任务
 * 答完（表现为「发了新消息却仍在回复被中断的那条」）。
 */

const model: ModelEntry = {
  id: "fake/fake",
  provider: "fake",
  model: "fake",
  contextWindow: 100000,
};

const configOf = (): XuanZhuConfig => ({
  ...DEFAULT_CONFIG,
  provider: "fake",
  model: "fake",
  models: [model],
});

const events = (): AgentEvents => ({
  onText: () => undefined,
  onToolStart: () => undefined,
  onToolEnd: () => undefined,
  onStatus: () => undefined,
  confirm: async () => true,
});

/** 每个用例用独立临时目录，避免读到真实项目规则 / 记忆 */
const tmpCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-turn-"));

/** 挂住当前请求，直到被中断 —— 模拟「模型输出到一半用户按了 Ctrl+D」 */
const waitAbort = (o: ChatOptions): Promise<void> =>
  new Promise<void>((resolve) => {
    if (o.signal?.aborted) return resolve();
    o.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

/** 吐一句正文就挂住（纯文本轮次） */
const plainProvider = (): LLMProvider => ({
  id: "fake",
  model: "fake",
  async *chat(o: ChatOptions): AsyncGenerator<StreamChunk> {
    yield { type: "text", text: "半截回答" };
    await waitAbort(o);
  },
});

const fakeTool: ToolDefinition = {
  name: "fake_tool",
  description: "测试用",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { ok: true, content: "工具结果", summary: "ok" };
  },
};

/** 第一轮调一次工具，第二轮吐一句正文后挂住 */
const toolProvider = (): LLMProvider => {
  let call = 0;
  return {
    id: "fake",
    model: "fake",
    async *chat(o: ChatOptions): AsyncGenerator<StreamChunk> {
      call += 1;
      if (call === 1) {
        yield {
          type: "tool_call",
          toolCall: { id: "c1", name: "fake_tool", arguments: "{}" },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", text: "半截回答" };
      await waitAbort(o);
    },
  };
};

/** 让本轮跑到「已产出内容或已执行工具」后再中断 */
const runThenAbort = async (agent: Agent, delayMs: number): Promise<void> => {
  const controller = new AbortController();
  const running = agent.run("旧问题", controller.signal);
  await new Promise((r) => setTimeout(r, delayMs));
  controller.abort();
  await running;
};

describe("中断后本轮整体回滚", () => {
  it("纯文本：历史不留下任何东西", async () => {
    const agent = new Agent(plainProvider(), configOf(), tmpCwd(), events(), model);
    await runThenAbort(agent, 30);
    // 本轮什么都没执行 → 没有可交代的，不留说明
    expect(agent.messages).toHaveLength(0);
  });

  it("已执行过工具：旧 user 与工具记录一并回滚，只留一条中止说明", async () => {
    const agent = new Agent(
      toolProvider(),
      configOf(),
      tmpCwd(),
      events(),
      model,
      { tools: [fakeTool] },
    );
    await runThenAbort(agent, 60);

    // 关键：不能留下「user 提问 + tool 结果」却没有最终答复的悬空轮次
    expect(agent.messages).toHaveLength(1);
    const note = agent.messages[0];
    expect(note.role).toBe("system");
    expect(note.content).toContain("[上一轮已中止]");
    expect(note.content).toContain("被用户中断");
    // 交代清楚执行过什么，避免模型重复执行有副作用的操作
    expect(note.content).toContain("fake_tool({})");
    expect(agent.messages.some((m) => m.content === "旧问题")).toBe(false);
    // 这份记录是「已执行」而不是待办：不许模型顺着它继续做被中止的任务
    // （2026-10-14 回归：用户只发了句「在吗」，模型却接着把旧任务做完）
    expect(note.content).toContain("不是待办清单");
    expect(note.content).toContain("最新的那条消息");
  });
});
