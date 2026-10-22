import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
import { goalCompleteTool } from "../src/tools/goal";
import { toolsForSubAgent } from "../src/tools";
import { TuiApp } from "../src/tui/app";

/**
 * 目标模式（`/goal`）的核心契约：
 * - 目标挂在 Agent 上，`goal_complete` 工具负责把「模型声明完成」写回去；
 * - 目标未完成时，系统提示词里必须**每次**都带目标段落（历史会被裁剪，
 *   只靠首条 user 消息无法贯穿整个目标执行过程）；
 * - 目标完成后不再注入，避免普通对话继续被「不要停」的规则驱动。
 *
 * 界面层的「自动继续循环」不进这里：它是对 `agent.run` 的反复调用，
 * 由 `TuiApp.runGoalLoop` 负责，测试聚焦「完成判定」这一确定性部分。
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

const tmpCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-goal-"));

/** 第一轮调用 goal_complete，第二轮给出最终总结；记录每次请求以便断言提示词 */
const goalProvider = (): { llm: LLMProvider; seen: ChatOptions[] } => {
  const seen: ChatOptions[] = [];
  let call = 0;
  return {
    seen,
    llm: {
      id: "fake",
      model: "fake",
      async *chat(o: ChatOptions): AsyncGenerator<StreamChunk> {
        seen.push(o);
        call += 1;
        if (call === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "g1",
              name: "goal_complete",
              arguments: JSON.stringify({ summary: "已实现并跑通测试" }),
            },
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text", text: "最终总结" };
        yield { type: "done", finishReason: "stop" };
      },
    },
  };
};

describe("目标模式", () => {
  it("goal_complete 把目标标记为完成并记录 summary", async () => {
    const { llm } = goalProvider();
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model);
    agent.setGoal("实现 X 功能");

    await agent.run("开始");

    const goal = agent.getGoal();
    expect(goal?.completed).toBe(true);
    expect(goal?.summary).toBe("已实现并跑通测试");

    // 工具结果要回灌给模型：确认调用生效，并提示「不要再开始新工作」
    const toolMessage = agent.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("已记录目标完成");
    // 本轮正常提交（历史里应有最终答复）
    expect(agent.messages.some((m) => m.content === "最终总结")).toBe(true);
  });

  it("目标未完成时系统提示词注入目标段落，完成后不再注入", async () => {
    const { llm, seen } = goalProvider();
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model);
    agent.setGoal("实现 X 功能");

    await agent.run("开始");

    // 第一次请求：目标尚未完成 → 带目标段落与「不要中途停下」的规则
    const firstSystem = seen[0].messages[0];
    expect(firstSystem.role).toBe("system");
    expect(firstSystem.content).toContain("## 目标模式（/goal）");
    expect(firstSystem.content).toContain("实现 X 功能");
    expect(firstSystem.content).toContain("不要在中途停下来");

    // 第二次请求发生在 goal_complete 之后 → 目标已结束，不再注入
    const secondSystem = seen[1].messages[0];
    expect(secondSystem.role).toBe("system");
    expect(secondSystem.content).not.toContain("## 目标模式（/goal）");
  });

  it("没有目标时 goal_complete 报错而不是空转", async () => {
    const result = await goalCompleteTool.execute(
      { summary: "完成" },
      { cwd: tmpCwd(), autoApprove: true },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("没有进行中的目标");
  });

  it("子代理不能使用 goal_complete（目标模式只属于主会话）", () => {
    const names = toolsForSubAgent().map((tool) => tool.name);
    expect(names).not.toContain("goal_complete");
  });

  it("界面循环：没调用 goal_complete 就自动继续，完成后收尾并清除目标", async () => {
    const seen: ChatOptions[] = [];
    let call = 0;
    const llm: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(o: ChatOptions): AsyncGenerator<StreamChunk> {
        seen.push(o);
        call += 1;
        if (call === 1) {
          // 第一轮：给出一版答复就停下，且没有声明完成 → 界面必须自动继续
          yield { type: "text", text: "先做了第一步" };
          yield { type: "done", finishReason: "stop" };
          return;
        }
        if (call === 2) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "g1",
              name: "goal_complete",
              arguments: JSON.stringify({ summary: "全部完成" }),
            },
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text", text: "收尾总结" };
        yield { type: "done", finishReason: "stop" };
      },
    };

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

    internals.agent.setGoal("完成 X");
    await internals.runGoalLoop();
    internals.exited = true;

    // 第 2 次请求是自动继续：首条 user 消息（历史最后一条）带「自动继续」标记
    expect(seen).toHaveLength(3);
    const continuation = seen[1].messages.at(-1);
    expect(continuation?.role).toBe("user");
    expect(continuation?.content).toContain("[目标模式 · 自动继续");
    // 完成后：目标被清除（后续普通对话不再注入目标提示词），并有完成提示
    expect(internals.agent.getGoal()).toBeUndefined();
    expect(internals.lines.join("\n")).toContain("✓ 目标已完成");
  });

  it("reset / restoreSession 会清掉目标（目标绑定对话上下文）", async () => {
    const { llm } = goalProvider();
    const agent = new Agent(llm, configOf(), tmpCwd(), events(), model);
    agent.setGoal("目标一");
    expect(agent.getGoal()?.text).toBe("目标一");

    agent.reset();
    expect(agent.getGoal()).toBeUndefined();

    agent.setGoal("目标二");
    agent.restoreSession([], path.join(tmpCwd(), "session.jsonl"));
    expect(agent.getGoal()).toBeUndefined();
  });
});
