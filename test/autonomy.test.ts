import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { autonomyCommand } from "../src/cli/commands/autonomy";
import { Agent, type AgentEvents } from "../src/core/agent";
import { loadConfig, saveConfig } from "../src/config/store";
import {
  autonomyModeOf,
  observeLogPath,
  readObservedActions,
  recordObservedAction,
} from "../src/core/autonomy";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
import type { ConfirmRequest } from "../src/tools/types";

/**
 * 自治等级：`observe` 必须由**代码**拦住写操作，而不是靠提示词要求模型别写。
 * 这组用例检查的正是「模型偏要写」时会发生什么。
 */

const model: ModelEntry = {
  id: "fake/fake",
  provider: "fake",
  model: "fake",
  contextWindow: 100000,
};

const configOf = (autonomy?: "ask" | "observe" | "auto"): XuanZhuConfig => ({
  ...DEFAULT_CONFIG,
  provider: "fake",
  model: "fake",
  models: [model],
  ...(autonomy ? { autonomy } : {}),
});

const tmpCwd = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "xzh-autonomy-"));

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
): { llm: LLMProvider; seen: ChatOptions[] } => {
  let call = 0;
  const seen: ChatOptions[] = [];
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

const eventsOf = (confirmed: ConfirmRequest[]): AgentEvents => ({
  onText: () => undefined,
  onToolStart: () => undefined,
  onToolEnd: () => undefined,
  onStatus: () => undefined,
  confirm: async (request) => {
    confirmed.push(request);
    return true;
  },
});

describe("autonomyModeOf", () => {
  it("未设置时按 autoApprove 推导（旧配置行为不变）", () => {
    const base = { ...DEFAULT_CONFIG, autonomy: undefined };
    expect(autonomyModeOf({ ...base, autoApprove: true })).toBe("auto");
    expect(autonomyModeOf({ ...base, autoApprove: false })).toBe("ask");
  });

  it("默认配置显式就是 auto，不再依赖推导", () => {
    expect(DEFAULT_CONFIG.autonomy).toBe("auto");
    // 即便旧字段 autoApprove=false，默认自治等级也是 auto（用户要求）
    expect(autonomyModeOf({ ...DEFAULT_CONFIG, autoApprove: false })).toBe("auto");
  });

  it("显式设置优先，非法值退回推导", () => {
    expect(autonomyModeOf({ ...DEFAULT_CONFIG, autonomy: "observe" })).toBe(
      "observe",
    );
    expect(
      // 手改配置写错时的兜底
      autonomyModeOf({
        ...DEFAULT_CONFIG,
        autonomy: "whatever" as never,
        autoApprove: true,
      }),
    ).toBe("auto");
  });
});

describe("observe 模式", () => {
  it("写文件被代码拦截：文件不存在，观察日志里有一条记录", async () => {
    const cwd = tmpCwd();
    const target = path.join(cwd, "blocked.txt");
    const { llm } = scriptProvider([
      toolCall("write_file", { path: target, content: "should not happen" }),
      textReply("被拦住了，改为给方案"),
    ]);
    const agent = new Agent(llm, configOf("observe"), cwd, eventsOf([]), model);

    await agent.run("写个文件");

    expect(fs.existsSync(target)).toBe(false);
    const log = readObservedActions(cwd, 10).join("\n");
    expect(log).toContain("write_file");
    expect(log).toContain("blocked.txt");
  });

  it("拦截结果明确告诉模型「没有执行」，不要重复尝试", async () => {
    const cwd = tmpCwd();
    const { llm, seen } = scriptProvider([
      toolCall("bash", { command: "touch should-not-exist" }),
      textReply("好"),
    ]);
    const agent = new Agent(llm, configOf("observe"), cwd, eventsOf([]), model);
    await agent.run("跑个命令");

    // 第二次请求里应能看到工具结果（tool 消息）
    const toolMessages = seen[1].messages.filter((item) => item.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toContain("[observe 模式]");
    expect(toolMessages[0].content).toContain("没有执行");
    expect(fs.existsSync(path.join(cwd, "should-not-exist"))).toBe(false);
  });

  it("只读工具不受影响（观察模式的意义是先看清情况）", async () => {
    const cwd = tmpCwd();
    fs.writeFileSync(path.join(cwd, "note.txt"), "hello", "utf8");
    const { llm, seen } = scriptProvider([
      toolCall("read_file", { path: path.join(cwd, "note.txt") }),
      textReply("读到了"),
    ]);
    const agent = new Agent(llm, configOf("observe"), cwd, eventsOf([]), model);
    await agent.run("读一下");

    const toolMessages = seen[1].messages.filter((item) => item.role === "tool");
    expect(toolMessages[0].content).toContain("hello");
    expect(readObservedActions(cwd, 10)).toHaveLength(0);
  });
});

describe("ask 模式", () => {
  it("危险操作会请求确认；auto 模式不会", async () => {
    const cwd = tmpCwd();

    const askConfirmed: ConfirmRequest[] = [];
    const ask = new Agent(
      scriptProvider([
        toolCall("write_file", { path: path.join(cwd, "a.txt"), content: "x" }),
        textReply("好"),
      ]).llm,
      configOf("ask"),
      cwd,
      eventsOf(askConfirmed),
      model,
    );
    await ask.run("写");
    expect(askConfirmed).toHaveLength(1);
    expect(askConfirmed[0].tool).toBe("write_file");

    const autoConfirmed: ConfirmRequest[] = [];
    const autoCwd = tmpCwd();
    const auto = new Agent(
      scriptProvider([
        toolCall("write_file", {
          path: path.join(autoCwd, "b.txt"),
          content: "y",
        }),
        textReply("好"),
      ]).llm,
      configOf("auto"),
      autoCwd,
      eventsOf(autoConfirmed),
      model,
    );
    await auto.run("写");
    expect(autoConfirmed).toHaveLength(0);
    expect(fs.existsSync(path.join(autoCwd, "b.txt"))).toBe(true);
  });
});

describe("xzh autonomy 命令", () => {
  const quiet = <T>(run: () => T): { result: T; out: string } => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const result = run();
      return { result, out: log.mock.calls.flat().join("\n") };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  };

  it("切换档位时同步写 autoApprove（两个字段不能各说一套）", () => {
    quiet(() => autonomyCommand(["auto"]));
    const { out } = quiet(() => autonomyCommand(["observe"]));
    const after = loadConfig();
    expect(after.autonomy).toBe("observe");
    expect(after.autoApprove).toBe(false);
    expect(out).toContain("observe");

    quiet(() => autonomyCommand(["ask"]));
    expect(loadConfig().autonomy).toBe("ask");
    expect(loadConfig().autoApprove).toBe(false);

    // 复原：同一文件里的其它用例按 DEFAULT_CONFIG 构造，别被这里影响
    quiet(() => autonomyCommand(["auto"]));
    expect(loadConfig().autoApprove).toBe(true);
  });

  it("未知档位打印用法并置失败退出码", () => {
    process.exitCode = 0;
    const { out } = quiet(() => autonomyCommand(["yolo"]));
    expect(process.exitCode).toBe(1);
    expect(out).toContain("xzh autonomy ask|observe|auto");
    process.exitCode = 0;
  });

  it("autonomy log 打印观察日志；没有记录时也给出明确说明", () => {
    const cwd = tmpCwd();
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const empty = quiet(() => autonomyCommand(["log"]));
      expect(empty.out).toContain("还没有拦截记录");

      recordObservedAction(cwd, "bash", { command: "rm -rf build" });
      const shown = quiet(() => autonomyCommand(["log"]));
      expect(shown.out).toContain("rm -rf build");
    } finally {
      process.chdir(previous);
    }
  });
});

describe("观察日志", () => {
  it("凭据在记录前被脱敏", () => {
    const cwd = tmpCwd();
    recordObservedAction(cwd, "bash", {
      command: "curl -H 'Authorization: Bearer abcdef123456' https://x",
    });
    const log = fs.readFileSync(observeLogPath(cwd), "utf8");
    expect(log).toContain("Bearer ***");
    expect(log).not.toContain("abcdef123456");
  });

  it("不存在的日志返回空数组", () => {
    expect(readObservedActions(tmpCwd(), 5)).toEqual([]);
  });
});
