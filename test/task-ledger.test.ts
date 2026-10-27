import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import {
  createTaskLedger,
  loadTaskLedger,
  saveTaskLedger,
  taskLedgerPath,
} from "../src/core/task-ledger";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
import { todoWriteTool } from "../src/tools/todo";
import type { ToolDefinition } from "../src/tools/types";

/**
 * 第二期：任务账本、滚动摘要（/compact）、工作集（/focus）。
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
  onTodos: () => undefined,
  confirm: async () => true,
});

const tmpCwd = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "xzh-task-ledger-"));

const tool = (name: string): ToolDefinition => ({
  name,
  description: `测试用 ${name}`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      command: { type: "string" },
      todos: { type: "array" },
    },
  },
  async execute() {
    return { ok: true, content: `${name} ok` };
  },
});

const scriptProvider = (
  script: StreamChunk[][],
): { llm: LLMProvider; seen: ChatOptions[] } => {
  const seen: ChatOptions[] = [];
  let call = 0;
  return {
    seen,
    llm: {
      id: "fake",
      model: "fake",
      async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
        seen.push(options);
        const chunks = script[Math.min(call, script.length - 1)];
        call += 1;
        for (const chunk of chunks) yield chunk;
      },
    },
  };
};

const toolCall = (name: string, args: Record<string, unknown>): StreamChunk[] => [
  {
    type: "tool_call",
    toolCall: { id: `c-${name}`, name, arguments: JSON.stringify(args) },
  },
  { type: "done", finishReason: "tool_calls" },
];

const textReply = (text: string): StreamChunk[] => [
  { type: "text", text },
  { type: "done", finishReason: "stop" },
];

const tools = [
  todoWriteTool,
  tool("write_file"),
  tool("bash"),
];

describe("任务账本", () => {
  it("一轮 run 记录标题、结论、计划、改动文件与验证", async () => {
    const cwd = tmpCwd();
    const { llm } = scriptProvider([
      toolCall("todo_write", {
        todos: [{ content: "实现 A", status: "in_progress" }],
      }),
      toolCall("write_file", { path: "src/a.ts" }),
      toolCall("bash", { command: "npm test" }),
      textReply("A 已实现，测试通过。"),
    ]);
    const agent = new Agent(llm, configOf(), cwd, events(), model, { tools });

    await agent.run("帮我实现 A");
    const task = loadTaskLedger(cwd);
    expect(task).toBeTruthy();
    expect(task?.title).toContain("帮我实现 A");
    expect(task?.status).toBe("active");
    expect(task?.lastConclusion).toContain("A 已实现");
    expect(task?.plan[0]).toMatchObject({ content: "实现 A", status: "in_progress" });
    expect(task?.changedFiles).toContain("src/a.ts");
    expect(task?.verification?.command).toBe("npm test");
  });

  it("新进程启动时把遗留的 active 降级为 paused", () => {
    const cwd = tmpCwd();
    const ledger = createTaskLedger("旧任务");
    saveTaskLedger(cwd, ledger);

    const agent = new Agent(
      scriptProvider([textReply("hi")]).llm,
      configOf(),
      cwd,
      events(),
      model,
    );
    expect(agent.getTaskLedger()?.status).toBe("paused");
    expect(loadTaskLedger(cwd)?.status).toBe("paused");
  });

  it("中断且 0 次工具调用 → abandoned（误发），不自动继续", async () => {
    const cwd = tmpCwd();
    const controller = new AbortController();
    const llm: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(): AsyncGenerator<StreamChunk> {
        controller.abort();
        yield { type: "text", text: "半截" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const agent = new Agent(llm, configOf(), cwd, events(), model);

    await agent.run("误发的指令", controller.signal);
    expect(loadTaskLedger(cwd)?.status).toBe("abandoned");
  });

  it("taskLedger:false（子代理）不写主任务账本", async () => {
    const cwd = tmpCwd();
    const agent = new Agent(
      scriptProvider([textReply("子任务结果")]).llm,
      configOf(),
      cwd,
      events(),
      model,
      { taskLedger: false, autoMemory: false },
    );

    await agent.run("子任务");
    expect(loadTaskLedger(cwd)).toBeNull();
  });

  it("/focus 维护工作集并持久化", () => {
    const cwd = tmpCwd();
    const file = path.join(cwd, "src", "a.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const a = 1;\n", "utf8");

    const agent = new Agent(
      scriptProvider([textReply("hi")]).llm,
      configOf(),
      cwd,
      events(),
      model,
    );
    expect(agent.addFocusFile("src/a.ts").ok).toBe(true);
    expect(agent.getFocusFiles()).toEqual(["src/a.ts"]);
    expect(loadTaskLedger(cwd)?.focusFiles).toEqual(["src/a.ts"]);

    expect(agent.removeFocusFile("src/a.ts")).toBe(true);
    expect(agent.getFocusFiles()).toEqual([]);
  });
});

describe("/compact 滚动摘要", () => {
  it("旧历史被摘要替换，只保留最近几轮，并写入账本", async () => {
    const cwd = tmpCwd();
    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `第 ${i + 1} 条对话内容`,
    }));
    const { llm, seen } = scriptProvider([textReply("已完成 A；下一步 B。")]);
    const agent = new Agent(llm, configOf(), cwd, events(), model);
    agent.restoreSession(messages, path.join(cwd, "session.jsonl"));

    const result = await agent.compactHistory();
    expect(result.compacted).toBe(true);
    expect(result.before).toBe(12);
    expect(result.after).toBeLessThan(result.before);
    expect(result.summary).toContain("已完成 A");
    expect(agent.messages[0].role).toBe("system");
    expect(agent.messages[0].content).toContain("对话摘要");
    expect(agent.messages[0].content).toContain("已完成 A");
    // 摘要请求本身不走工具
    expect(seen[0].tools).toEqual([]);
    expect(loadTaskLedger(cwd)?.summary).toContain("已完成 A");
  });

  it("历史很短时不调用模型", async () => {
    const cwd = tmpCwd();
    const { llm, seen } = scriptProvider([textReply("不该被调用")]);
    const agent = new Agent(llm, configOf(), cwd, events(), model);
    agent.restoreSession(
      [{ role: "user", content: "你好" }],
      path.join(cwd, "session.jsonl"),
    );

    const result = await agent.compactHistory();
    expect(result.compacted).toBe(false);
    expect(seen).toHaveLength(0);
  });
});
