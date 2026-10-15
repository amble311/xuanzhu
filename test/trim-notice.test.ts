import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import { buildSystemPrompt } from "../src/core/prompt";
import {
  DEFAULT_CONFIG,
  type ModelEntry,
  type XuanZhuConfig,
} from "../src/config/store";
import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  StreamChunk,
} from "../src/llm/types";

/**
 * 历史被裁剪后必须**告诉模型「你看的不是完整历史」**。
 *
 * 回归背景（2026-10-14）：用户只发了句「在吗」，模型却接着执行上一轮被中断的任务
 * （起 API 服务、查登录凭据）—— 因为历史里那段没有结论的旧任务看起来就像"在等我继续"。
 * 裁剪是静默的（裁完就把丢掉的段落忘了），于是模型拿残片当依据。
 *
 * 这条提醒必须由**确定性机制**送出（`Agent` 记录「裁过历史」并在每次请求里附上），
 * 而不是只在提示词里写一句「不要接着做旧任务」等模型自觉。
 */

const tmpCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-trim-"));

const modelOf = (contextWindow: number): ModelEntry => ({
  id: "ollama/llama3",
  provider: "ollama",
  model: "llama3",
  contextWindow,
});

const configOf = (entry: ModelEntry): XuanZhuConfig => ({
  ...DEFAULT_CONFIG,
  provider: entry.provider,
  model: entry.model,
  models: [entry],
});

const events = (): AgentEvents => ({
  onText: () => undefined,
  onToolStart: () => undefined,
  onToolEnd: () => undefined,
  onStatus: () => undefined,
  confirm: async () => true,
});

/** 假 provider：把每次请求真正发出的消息数组记下来，然后正常收尾 */
const captureProvider = (sink: ChatMessage[][]): LLMProvider => ({
  id: "ollama",
  model: "llama3",
  async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
    sink.push(options.messages);
    yield { type: "text", text: "好的" };
    yield { type: "done", finishReason: "stop" };
  },
});

const NOTE_MARK = "不是完整历史";
const notesIn = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter(
    (message) => message.role === "system" && message.content.includes(NOTE_MARK),
  );

/**
 * 一段远超对话预算的中文历史（CJK 约 1 token/字符）。
 *
 * 取 5 万字符是有意的：窗口 12000 时预算只有几千 token，
 * 这样上一轮的历史**必然**放不下，从而触发「整条被丢掉」的路径。
 */
const LONG_HISTORY = "这是一段很长的旧对话记录，里面有个没做完的旧任务。".repeat(2000);

describe("历史被裁剪后提醒模型「这不是完整历史」", () => {
  it("裁剪发生时附上提醒，只附一条，且不随轮次累积", async () => {
    const entry = modelOf(12_000);
    const sink: ChatMessage[][] = [];
    const agent = new Agent(
      captureProvider(sink),
      configOf(entry),
      tmpCwd(),
      events(),
      entry,
    );

    // 第一轮：历史里只有这一条超长消息，没有「丢掉整条」，因此不加提醒
    await agent.run(LONG_HISTORY);
    expect(notesIn(sink[0])).toHaveLength(0);

    // 第二轮：上一轮的历史放不下被整条丢掉 → 必须提醒「不是完整历史」
    await agent.run("在吗");
    expect(notesIn(sink[1])).toHaveLength(1);
    // 位置在会话最前面（它是 system 消息，紧跟在系统提示词之后）
    expect(sink[1][1].content).toContain(NOTE_MARK);
    // 正文里明确写了「不代表要接着做」和「先回答当前这条消息」
    expect(sink[1][1].content).toContain("不代表要接着做");
    expect(sink[1][1].content).toContain("当前这条消息");

    // 第三轮：提醒仍然只有一条（它只加在请求副本上，不会被提交进历史）
    await agent.run("谢谢");
    expect(notesIn(sink[2])).toHaveLength(1);
    expect(agent.messages.some((message) => message.content.includes(NOTE_MARK))).toBe(
      false,
    );
  });

  it("没有裁剪过就不加提醒（避免无谓地让模型畏手畏脚）", async () => {
    const entry = modelOf(200_000);
    const sink: ChatMessage[][] = [];
    const agent = new Agent(
      captureProvider(sink),
      configOf(entry),
      tmpCwd(),
      events(),
      entry,
    );

    await agent.run("在吗");
    await agent.run("再看一下 README");
    expect(sink).toHaveLength(2);
    expect(notesIn(sink[0])).toHaveLength(0);
    expect(notesIn(sink[1])).toHaveLength(0);
  });

  it("系统提示词写明「用户最新一条消息就是本轮要做的事」", () => {
    const prompt = buildSystemPrompt("/tmp/demo", undefined, null, null);
    expect(prompt).toContain("用户最新一条消息就是本轮要做的事");
    // 寒暄不续跑旧任务；但明确说「继续」时仍要接着做
    expect(prompt).toContain("顺手把上文里没做完的旧任务接着做完");
    expect(prompt).toContain("明确要求继续");
    expect(prompt).toContain("[上下文提醒]");
  });
});
