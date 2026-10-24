import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import {
  buildSelfState,
  finishGatePrompt,
  isVerificationCommand,
} from "../src/core/state";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
import { todoWriteTool } from "../src/tools/todo";
import type { ToolDefinition } from "../src/tools/types";

/**
 * 只读状态块 + 验证门。
 *
 * 状态块是纯函数（`buildSelfState`），直接断言内容与长度上限；
 * 验证门在 `Agent.run` 里，用脚本化的 provider 复现「改文件 → 直接答复」与
 * 「改文件 → 跑测试 → 答复」两条路径。
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

const tmpCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-state-"));

const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "测试用写文件",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async execute(args) {
    return { ok: true, content: `已写入 ${String(args.path)}` };
  },
};

const editFileTool: ToolDefinition = {
  name: "edit_file",
  description: "测试用改文件",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async execute(args) {
    return { ok: true, content: `已修改 ${String(args.path)}` };
  },
};

const bashTool: ToolDefinition = {
  name: "bash",
  description: "测试用执行命令",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  async execute(args) {
    return { ok: true, content: `已执行 ${String(args.command)}` };
  },
};

/** 按脚本逐次返回的 provider；脚本用完后重复最后一段 */
const scriptProvider = (
  script: StreamChunk[][],
): { llm: LLMProvider; seen: ChatOptions[]; calls: () => number } => {
  const seen: ChatOptions[] = [];
  let call = 0;
  return {
    seen,
    calls: () => call,
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

describe("只读状态块", () => {
  it("没有任何事实时不生成（不占 token）", () => {
    expect(
      buildSelfState({ todos: [], recentActions: [], changedFiles: [] }),
    ).toBeNull();
  });

  it("汇总目标、任务、最近动作、改动文件与上下文占用", () => {
    const block = buildSelfState({
      goal: {
        text: "重构区间策略",
        startedAt: new Date(Date.now() - 65_000).toISOString(),
        completed: false,
      },
      todos: [
        { content: "读 regime.py", status: "completed" },
        { content: "修 server.py 重复路由", status: "in_progress" },
        { content: "跑回测", status: "pending" },
      ],
      recentActions: [
        { name: "read_file", ok: true },
        { name: "edit_file", ok: true },
        { name: "bash", ok: false },
      ],
      changedFiles: ["client/api/server.py"],
      contextUsage: 0.62,
    });

    expect(block).not.toBeNull();
    expect(block).toContain("目标：重构区间策略（进行中 · 已用 1m）");
    expect(block).toContain("任务：1/3 完成；进行中：修 server.py 重复路由");
    expect(block).toContain("最近动作：read_file ✓、edit_file ✓、bash ✗");
    expect(block).toContain("本次会话已改动：client/api/server.py");
    expect(block).toContain("上下文：约 62%");
  });

  it("上下文未过半时不展示；已完成的目标标记为已完成", () => {
    const block = buildSelfState({
      goal: {
        text: "小目标",
        startedAt: new Date().toISOString(),
        completed: true,
      },
      todos: [],
      recentActions: [],
      changedFiles: [],
      contextUsage: 0.2,
    });
    expect(block).toContain("（已完成");
    expect(block).not.toContain("上下文：");
  });

  it("动作与文件列表有上限，避免状态块无限膨胀", () => {
    const block = buildSelfState({
      todos: [],
      recentActions: Array.from({ length: 9 }, (_, i) => ({
        name: `tool${i}`,
        ok: true,
      })),
      changedFiles: ["a", "b", "c", "d", "e", "f"],
    });
    expect(block).not.toBeNull();
    // 只留最近 5 条动作
    expect(block).toContain("tool4 ✓、tool5 ✓、tool6 ✓、tool7 ✓、tool8 ✓");
    expect(block).not.toContain("tool3 ✓、tool4");
    // 只列最近改动的 4 个文件 + 总数
    expect(block).toContain("c、d、e、f 等 6 个文件");
  });
});

describe("验证命令识别", () => {
  it("测试 / 构建 / 类型检查 / lint 都算验证", () => {
    for (const command of [
      "npm test",
      "npm run build",
      "pnpm typecheck",
      "yarn lint",
      "npx vitest run",
      "pytest -q",
      "python -m py_compile app.py",
      "tsc --noEmit",
      "go test ./...",
      "cargo test",
      "make check",
    ]) {
      expect(isVerificationCommand(command), command).toBe(true);
    }
  });

  it("普通读写命令不算验证（避免误判成「已验证」）", () => {
    for (const command of [
      "ls -la",
      "cat package.json",
      "git commit -m x",
      "npm install",
      "grep -rn TODO src",
    ]) {
      expect(isVerificationCommand(command), command).toBe(false);
    }
  });

  it("验证门提示列出改动文件并说明无法验证时该怎么做", () => {
    const prompt = finishGatePrompt({
      verificationFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
    });
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("共 4 个文件");
    expect(prompt).toContain("原因与「未验证」的风险");
  });

  it("未完成门提示列出进行中 / 待办项", () => {
    const prompt = finishGatePrompt({
      incompleteTodos: [
        { content: "改路由", status: "in_progress" },
        { content: "跑回测", status: "pending" },
      ],
    });
    expect(prompt).toContain("还有 2 项未完成");
    expect(prompt).toContain("[进行中] 改路由");
    expect(prompt).toContain("[待办] 跑回测");
    expect(prompt).toContain("有意暂停");
  });

  it("两类问题合并成一条提示（不连续打断两次）", () => {
    const prompt = finishGatePrompt({
      verificationFiles: ["a.ts"],
      incompleteTodos: [{ content: "修 bug", status: "pending" }],
    });
    expect(prompt.match(/\[系统检查\]/g)).toHaveLength(1);
    expect(prompt).toContain("还有 1 项未完成");
    expect(prompt).toContain("没有运行任何验证");
  });
});

describe("验证门（Agent.run）", () => {
  it("改过文件却没验证 → 先提醒一次，再允许收尾", async () => {
    const { llm, seen, calls } = scriptProvider([
      toolCall("write_file", { path: "client/api/server.py" }),
      textReply("改好了"),
      textReply("确实没有测试，已说明未验证"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool],
    });

    await agent.run("修一下");

    // 第 2 轮本来要收尾，被验证门拦下并追加了一轮
    expect(calls()).toBe(3);
    // 提醒在「下一次请求」里才发给模型（即 seen[2]），且只存在于本轮 turn
    const reminder = seen[2].messages.find(
      (message) => message.role === "user" && message.content.includes("[系统检查]"),
    );
    expect(reminder).toBeTruthy();
    expect(reminder!.content).toContain("client/api/server.py");

    // 提醒随本轮一起提交（与重复检测注入的「[系统检测]」同一套语义：
    // 后续轮次需要知道「我已经被提醒过验证」），但只读状态块绝不进历史
    expect(agent.messages.some((m) => m.content.includes("[系统检查]"))).toBe(true);
    expect(agent.messages.some((m) => m.content.includes("[当前状态"))).toBe(false);
  });

  it("改过文件并跑了验证 → 不触发提醒", async () => {
    const { llm, seen, calls } = scriptProvider([
      toolCall("write_file", { path: "a.ts" }),
      toolCall("bash", { command: "npm test" }),
      textReply("测试通过"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool],
    });

    await agent.run("改一下并验证");

    expect(calls()).toBe(3);
    expect(
      seen.every((request) =>
        request.messages.every((message) => !message.content.includes("[系统检查]")),
      ),
    ).toBe(true);
  });

  it("先跑验证、后改文件 → 仍然提醒（旧验证不覆盖后续改动）", async () => {
    const { llm, seen, calls } = scriptProvider([
      toolCall("bash", { command: "npm test" }),
      toolCall("write_file", { path: "b.ts" }),
      textReply("完成"),
      textReply("已补充验证说明"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool],
    });

    await agent.run("先测再改");
    expect(calls()).toBe(4);
    const reminder = seen[3].messages.find(
      (message) => message.role === "user" && message.content.includes("[系统检查]"),
    );
    expect(reminder).toBeTruthy();
  });

  it("只读取、没改文件 → 不触发提醒", async () => {
    const { llm, calls } = scriptProvider([textReply("只是回答问题")]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool],
    });

    await agent.run("解释一下");
    expect(calls()).toBe(1);
  });

  it("改动后状态块出现在下一次请求里（且不写进历史）", async () => {
    const { llm, seen } = scriptProvider([
      toolCall("edit_file", { path: "src/app.ts" }),
      toolCall("bash", { command: "npm run typecheck" }),
      textReply("好了"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool],
    });

    await agent.run("改一下");

    // 状态块并入系统提示词（messages[0]），随每轮请求重建
    const systemMessage = seen[1].messages[0];
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain("[当前状态");
    expect(systemMessage.content).toContain("src/app.ts");
    expect(systemMessage.content).toContain("最近动作");
    // 状态块只加在请求副本上，不进会话历史
    expect(agent.messages.some((m) => m.content.includes("[当前状态"))).toBe(false);
  });
});

describe("未完成门（普通对话）", () => {
  const todoCall = (todos: Array<{ content: string; status: string }>): StreamChunk[] =>
    toolCall("todo_write", { todos });

  it("本轮列了计划却没做完 → 提醒一次再收尾", async () => {
    const { llm, seen, calls } = scriptProvider([
      todoCall([
        { content: "读配置", status: "completed" },
        { content: "改路由", status: "pending" },
      ]),
      textReply("先这样"),
      textReply("先停下，等你确认口径"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool, todoWriteTool],
    });

    await agent.run("改一下路由");

    expect(calls()).toBe(3);
    const reminder = seen[2].messages.find(
      (message) => message.role === "user" && message.content.includes("[系统检查]"),
    );
    expect(reminder?.content).toContain("还有 1 项未完成");
    expect(reminder?.content).toContain("改路由");
  });

  it("计划全部完成 → 不提醒", async () => {
    const { llm, seen, calls } = scriptProvider([
      todoCall([{ content: "读配置", status: "completed" }]),
      textReply("做完了"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool, todoWriteTool],
    });

    await agent.run("改一下");
    expect(calls()).toBe(2);
    expect(
      seen.every((request) =>
        request.messages.every((message) => !message.content.includes("[系统检查]")),
      ),
    ).toBe(true);
  });

  it("验证与未完成合并成一条提醒（不连续打断两次）", async () => {
    const { llm, seen, calls } = scriptProvider([
      toolCall("write_file", { path: "a.ts" }),
      todoCall([{ content: "补测试", status: "pending" }]),
      textReply("先这样"),
      textReply("先停下，缺测试数据"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool, todoWriteTool],
    });

    await agent.run("改一下");

    expect(calls()).toBe(4);
    const reminders = agent.messages.filter((message) =>
      message.content.includes("[系统检查]"),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0].content).toContain("还有 1 项未完成");
    expect(reminders[0].content).toContain("没有运行任何验证");
    // 只提醒一次：第二次直接答复就被接受了
    expect(seen).toHaveLength(4);
  });

  it("目标模式跳过未完成门（由 goal 循环负责继续）", async () => {
    const { llm, calls } = scriptProvider([
      todoCall([{ content: "补测试", status: "pending" }]),
      textReply("先这样"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model, {
      tools: [writeFileTool, editFileTool, bashTool, todoWriteTool],
    });
    agent.setGoal("把测试补齐");

    await agent.run("开始");
    expect(calls()).toBe(2);
  });
});
