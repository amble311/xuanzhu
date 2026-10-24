import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import { buildSelfState } from "../src/core/state";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
import { TuiApp } from "../src/tui/app";
import { reportStatusTool } from "../src/tools/status";
import type { RunStatusInput, StatusStore } from "../src/tools/types";

/**
 * 不确定性通道（`report_status`）：
 * - blocked / needs_input 让目标暂停并把原因交给用户；
 * - low_confidence 不打断，只做标注；
 * - 防滥用：目标模式下本轮一次工具都没调就报前两类会被拒绝。
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

const tmpCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-status-"));

/** 可记录 report 调用的假状态出口 */
const fakeStore = (
  options: { goalActive?: boolean; toolCalls?: number } = {},
): StatusStore & { reported: RunStatusInput[] } => {
  const reported: RunStatusInput[] = [];
  return {
    reported,
    report: (status) => {
      reported.push(status);
    },
    toolCalls: () => options.toolCalls ?? 0,
    goalActive: () => options.goalActive ?? false,
  };
};

const toolCall = (
  name: string,
  args: Record<string, unknown>,
  id = `c-${name}`,
): StreamChunk[] => [
  {
    type: "tool_call",
    toolCall: { id, name, arguments: JSON.stringify(args) },
  },
  { type: "done", finishReason: "tool_calls" },
];

const textReply = (text: string): StreamChunk[] => [
  { type: "text", text },
  { type: "done", finishReason: "stop" },
];

const scriptProvider = (
  script: StreamChunk[][],
): { llm: LLMProvider; calls: () => number; seen: ChatOptions[] } => {
  let call = 0;
  const seen: ChatOptions[] = [];
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

describe("report_status 工具", () => {
  it("没有注入状态出口时直接报错", async () => {
    const result = await reportStatusTool.execute(
      { kind: "blocked", summary: "缺 key" },
      { cwd: tmpCwd(), autoApprove: true },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("不支持状态上报");
  });

  it("目标模式下没做任何尝试就报受阻 → 拒绝且不记录", async () => {
    const store = fakeStore({ goalActive: true, toolCalls: 0 });
    const result = await reportStatusTool.execute(
      { kind: "blocked", summary: "缺 key" },
      { cwd: tmpCwd(), autoApprove: true, status: store },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("先实际尝试");
    expect(store.reported).toHaveLength(0);
  });

  it("已经尝试过 / 非目标模式 → 记录成功", async () => {
    const store = fakeStore({ goalActive: true, toolCalls: 2 });
    const result = await reportStatusTool.execute(
      { kind: "needs_input", summary: "选哪个账户", detail: "A 或 B" },
      { cwd: tmpCwd(), autoApprove: true, status: store },
    );
    expect(result.ok).toBe(true);
    expect(store.reported[0]).toMatchObject({
      kind: "needs_input",
      summary: "选哪个账户",
    });
  });

  it("low_confidence 不受「先尝试」限制", async () => {
    const store = fakeStore({ goalActive: true, toolCalls: 0 });
    const result = await reportStatusTool.execute(
      { kind: "low_confidence", summary: "回测数据不足" },
      { cwd: tmpCwd(), autoApprove: true, status: store },
    );
    expect(result.ok).toBe(true);
    expect(store.reported[0].kind).toBe("low_confidence");
  });

  it("非法 kind 被拒绝", async () => {
    const result = await reportStatusTool.execute(
      { kind: "whatever", summary: "x" },
      { cwd: tmpCwd(), autoApprove: true, status: fakeStore() },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("kind 必须是");
  });
});

describe("状态进入 Agent 与状态块", () => {
  it("上报后可通过 getRunStatus 读取，并出现在下一轮状态块里", async () => {
    const file = path.join(tmpCwd(), "note.txt");
    fs.writeFileSync(file, "hello", "utf8");

    const { llm, seen } = scriptProvider([
      toolCall("read_file", { path: file }),
      toolCall("report_status", {
        kind: "blocked",
        summary: "缺少 BTC_API_KEY",
        detail: "已检查 client/.env",
      }),
      textReply("需要 API Key 才能继续"),
    ]);
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model);

    await agent.run("拉行情");

    const status = agent.getRunStatus();
    expect(status?.kind).toBe("blocked");
    expect(status?.summary).toBe("缺少 BTC_API_KEY");
    // 下一次请求（工具调用后那一轮）的状态块里应带上它
    const system = seen[2].messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("状态：受阻");
    expect(system.content).toContain("缺少 BTC_API_KEY");
  });

  it("纯函数：状态块按类型显示不同文案", () => {
    const base = { todos: [], recentActions: [], changedFiles: [] };
    expect(
      buildSelfState({
        ...base,
        status: { kind: "needs_input", summary: "选 A 还是 B", at: "x" },
      }),
    ).toContain("状态：等待用户决定 —— 选 A 还是 B");
    expect(
      buildSelfState({
        ...base,
        status: { kind: "low_confidence", summary: "样本太少", at: "x" },
      }),
    ).toContain("状态：置信度低 —— 样本太少");
  });
});

describe("目标模式：受阻即暂停", () => {
  it("报告 blocked 后循环停下、目标保留，并显示原因", async () => {
    const file = path.join(tmpCwd(), "note.txt");
    fs.writeFileSync(file, "hello", "utf8");

    const { llm, calls } = scriptProvider([
      toolCall("read_file", { path: file }),
      toolCall("report_status", {
        kind: "blocked",
        summary: "缺少 BTC_API_KEY",
      }),
      textReply("需要 API Key 才能继续"),
      // 若循环没有停下，会继续请求（测试会因调用数超标而失败）
      textReply("不应该继续"),
    ]);

    const app = new TuiApp({
      provider: llm,
      config: configOf(),
      cwd: tmpCwd(),
      providerLabel: "fake",
      model: "fake",
      autoApprove: true,
    });
    const internals = app as unknown as {
      runGoalLoop(): Promise<void>;
      lines: string[];
      agent: Agent;
      exited: boolean;
    };

    internals.agent.setGoal("拉取 BTC 行情");
    await internals.runGoalLoop();
    internals.exited = true;

    // 一轮里用掉 3 次模型请求（读取 → 上报 → 说明），然后循环停止
    expect(calls()).toBe(3);
    expect(internals.agent.getGoal()?.completed).toBe(false);
    const text = internals.lines.join("\n");
    expect(text).toContain("受阻：缺少 BTC_API_KEY");
    expect(text).toContain("/goal continue");
  });
});
