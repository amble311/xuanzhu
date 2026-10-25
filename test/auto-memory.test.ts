import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
import { appendLongTermTopicEntry } from "../src/workspace";
import type { ToolDefinition } from "../src/tools/types";

/**
 * 自动项目记忆：
 * - 有实际动作（≥2 次工具 / 改文件 / 跑验证）→ 写当日摘要；
 * - 代码真的被改动 → 按目录主题并入长期记忆；
 * - 模型已主动 memory_write、纯问答、只读调研 → 不写长期记忆。
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

const events = (notices: string[] = []): AgentEvents => ({
  onText: () => undefined,
  onToolStart: () => undefined,
  onToolEnd: () => undefined,
  onStatus: () => undefined,
  onNotice: (message) => notices.push(message),
  confirm: async () => true,
});

const tmpCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-auto-mem-"));

const tool = (name: string, ok = true): ToolDefinition => ({
  name,
  description: `测试用 ${name}`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      command: { type: "string" },
      content: { type: "string" },
      scope: { type: "string" },
    },
  },
  async execute() {
    return { ok, content: `${name} ok` };
  },
});

const scriptProvider = (
  script: StreamChunk[][],
): { llm: LLMProvider; calls: () => number } => {
  let call = 0;
  return {
    calls: () => call,
    llm: {
      id: "fake",
      model: "fake",
      async *chat(_options: ChatOptions): AsyncGenerator<StreamChunk> {
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

const memoryDir = (cwd: string): string => path.join(cwd, ".xuanzhu", "memory");
const readToday = (cwd: string): string => {
  const dir = memoryDir(cwd);
  const name = fs
    .readdirSync(dir)
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
    .sort()
    .at(-1);
  return name ? fs.readFileSync(path.join(dir, name), "utf8") : "";
};

const tools = [
  tool("write_file"),
  tool("bash"),
  tool("read_file"),
  tool("memory_write"),
];

describe("自动记录项目记忆", () => {
  it("改文件 + 跑验证 → 当日摘要 + 按目录并入长期记忆", async () => {
    const cwd = tmpCwd();
    const notices: string[] = [];
    const { llm } = scriptProvider([
      toolCall("write_file", { path: "src/core/a.ts" }),
      toolCall("bash", { command: "npm test" }),
      textReply("## 结论\n路由重构完成，测试通过。"),
    ]);
    const agent = new Agent(llm, configOf(), cwd, events(notices), model, {
      tools,
    });

    await agent.run("重构路由");

    const daily = readToday(cwd);
    expect(daily).toContain("工具：");
    expect(daily).toContain("write_file×1");
    expect(daily).toContain("改动：src/core/a.ts");
    expect(daily).toContain("npm test（通过）");
    expect(daily).toContain("结论：路由重构完成，测试通过。");

    const longTerm = fs.readFileSync(
      path.join(memoryDir(cwd), "MEMORY.md"),
      "utf8",
    );
    expect(longTerm).toContain("## 自动记录 · src/core");
    expect(longTerm).toContain("路由重构完成，测试通过。");
    expect(longTerm).toContain("验证 npm test");
    expect(notices.join("\n")).toContain("更新长期记忆（src/core）");
  });

  it("同样的结果重复运行不会重复写长期记忆条目", async () => {
    const cwd = tmpCwd();
    const script = [
      toolCall("write_file", { path: "src/core/a.ts" }),
      toolCall("bash", { command: "npm test" }),
      textReply("改动完成。"),
    ];
    const first = scriptProvider(script);
    await new Agent(first.llm, configOf(), cwd, events(), model, { tools }).run(
      "第一次",
    );

    const second = scriptProvider(script);
    await new Agent(second.llm, configOf(), cwd, events(), model, { tools }).run(
      "第二次",
    );

    const longTerm = fs.readFileSync(
      path.join(memoryDir(cwd), "MEMORY.md"),
      "utf8",
    );
    expect(longTerm.match(/改动完成。/g)).toHaveLength(1);
    // 当日日志仍然每轮一条，保留过程
    expect(readToday(cwd).match(/结论：改动完成。/g)?.length).toBeGreaterThan(1);
  });

  it("纯问答（没用工具）→ 不写任何记忆", async () => {
    const cwd = tmpCwd();
    const { llm } = scriptProvider([textReply("二分查找是……")]);
    await new Agent(llm, configOf(), cwd, events(), model, { tools }).run(
      "什么是二分查找",
    );
    expect(fs.existsSync(memoryDir(cwd))).toBe(false);
  });

  it("只读调研（没有改动）→ 只写当日摘要，不污染长期记忆", async () => {
    const cwd = tmpCwd();
    const { llm } = scriptProvider([
      toolCall("read_file", { path: "README.md" }),
      toolCall("read_file", { path: "package.json" }),
      textReply("项目是一个 Node 工程。"),
    ]);
    await new Agent(llm, configOf(), cwd, events(), model, { tools }).run(
      "看看项目",
    );

    expect(readToday(cwd)).toContain("结论：项目是一个 Node 工程。");
    expect(fs.existsSync(path.join(memoryDir(cwd), "MEMORY.md"))).toBe(false);
  });

  it("自动摘要会先做凭据脱敏", async () => {
    const cwd = tmpCwd();
    const { llm } = scriptProvider([
      toolCall("write_file", { path: "src/core/a.ts" }),
      toolCall("bash", { command: "API_KEY=sk-testsecret123456 npm test" }),
      textReply("使用 sk-testsecret123456 完成配置。"),
    ]);
    await new Agent(llm, configOf(), cwd, events(), model, { tools }).run(
      "配置一下",
    );

    const daily = readToday(cwd);
    expect(daily).not.toContain("sk-testsecret123456");
    expect(daily).toContain("sk-***");

    const longTerm = fs.readFileSync(
      path.join(memoryDir(cwd), "MEMORY.md"),
      "utf8",
    );
    expect(longTerm).not.toContain("sk-testsecret123456");
    expect(longTerm).toContain("sk-***");
  });

  it("模型已经主动 memory_write → 不再自动补写", async () => {
    const cwd = tmpCwd();
    const { llm } = scriptProvider([
      toolCall("memory_write", { content: "手写结论", scope: "daily" }),
      toolCall("write_file", { path: "src/a.ts" }),
      textReply("完成。"),
    ]);
    await new Agent(llm, configOf(), cwd, events(), model, { tools }).run(
      "写一下",
    );

    expect(fs.existsSync(path.join(memoryDir(cwd), "MEMORY.md"))).toBe(false);
    expect(() => readToday(cwd)).toThrow();
  });
});

describe("appendLongTermTopicEntry", () => {
  it("按主题归并，超过上限则不再追加", () => {
    const cwd = tmpCwd();
    appendLongTermTopicEntry(cwd, "src/core", "- 2026-10-25：结论 A", 12000);
    appendLongTermTopicEntry(cwd, "src/core", "- 2026-10-25：结论 B", 12000);
    appendLongTermTopicEntry(cwd, "src/tools", "- 2026-10-25：结论 C", 12000);

    const text = fs.readFileSync(
      path.join(memoryDir(cwd), "MEMORY.md"),
      "utf8",
    );
    expect(text.match(/## 自动记录 · src\/core/g)).toHaveLength(1);
    expect(text).toContain("结论 A");
    expect(text).toContain("结论 B");
    expect(text).toContain("## 自动记录 · src/tools");

    const tiny = tmpCwd();
    const result = appendLongTermTopicEntry(
      tiny,
      "src",
      "- 很长的条目",
      10,
    );
    expect(result.added).toBe(false);
  });
});
