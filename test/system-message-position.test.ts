import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, hoistSystemNotes, type AgentEvents } from "../src/core/agent";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { ChatMessage, ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";

/**
 * 历史中间的 `system` 消息必须提前。
 *
 * 2026-10-25 实测事故：上一轮被 Ctrl+D 中止后，历史里留下一条 `role: system` 的
 * 「[上一轮已中止]」；llama.cpp 的 chat template 要求 system 只能出现在最前面，
 * 于是下一轮直接 500：
 * `Jinja Exception: System message must be at the beginning.`
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

const tmpFile = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xzh-sysmsg-")), "session.jsonl");

const note = (text: string): ChatMessage => ({ role: "system", content: text });

describe("hoistSystemNotes", () => {
  it("把历史中间的 system 提前，开头的 system 保持原位", () => {
    const conversation: ChatMessage[] = [
      note("[trim notice]"),
      { role: "user", content: "在吗" },
      { role: "assistant", content: "在的" },
      note("[上一轮已中止]"),
      { role: "user", content: "继续" },
    ];

    const hoisted = hoistSystemNotes(conversation);

    expect(hoisted.notes).toEqual(["[上一轮已中止]"]);
    expect(hoisted.conversation).toEqual([
      note("[trim notice]"),
      { role: "user", content: "在吗" },
      { role: "assistant", content: "在的" },
      { role: "user", content: "继续" },
    ]);
  });

  it("多条中间 system 按原顺序保留", () => {
    const conversation: ChatMessage[] = [
      { role: "user", content: "u1" },
      note("n1"),
      { role: "assistant", content: "a1" },
      note("n2"),
      { role: "user", content: "u2" },
    ];

    const hoisted = hoistSystemNotes(conversation);
    expect(hoisted.notes).toEqual(["n1", "n2"]);
    expect(hoisted.conversation.some((message) => message.role === "system")).toBe(false);
  });

  it("没有 system 时原样返回", () => {
    const conversation: ChatMessage[] = [{ role: "user", content: "hi" }];
    const hoisted = hoistSystemNotes(conversation);
    expect(hoisted.notes).toEqual([]);
    expect(hoisted.conversation).toEqual(conversation);
  });
});

describe("请求组装：system 始终在最前面", () => {
  it("历史里有「[上一轮已中止]」时，它被并入系统提示词而不是留在中间", async () => {
    const seen: ChatOptions[] = [];
    const llm: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
        seen.push(options);
        yield { type: "text", text: "好的" };
        yield { type: "done", finishReason: "stop" };
      },
    };

    const agent = new Agent(llm, configOf(), path.dirname(tmpFile()), events(), model);
    agent.restoreSession(
      [
        { role: "user", content: "上次任务" },
        { role: "assistant", content: "做到一半" },
        note("[上一轮已中止] 已执行：list_dir、bash"),
        { role: "user", content: "在吗" },
      ],
      tmpFile(),
    );

    await agent.run("在吗");

    const messages = seen[0].messages;
    // 所有 system 都必须在最前面，之后不能再出现 system
    const firstNonSystem = messages.findIndex((message) => message.role !== "system");
    expect(firstNonSystem).toBeGreaterThan(0);
    expect(
      messages.slice(0, firstNonSystem).every((message) => message.role === "system"),
    ).toBe(true);
    expect(
      messages.some(
        (message, index) => index >= firstNonSystem && message.role === "system",
      ),
    ).toBe(false);
    // 内容仍保留在系统提示词里（没有丢）
    expect(messages[0].content).toContain("[上一轮已中止]");
  });
});
