import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  StreamChunk,
} from "../src/llm/types";
import { executeTool, TOOLS } from "../src/tools";
import { bashTool } from "../src/tools/bash";
import { readFileTool } from "../src/tools/filesystem";
import type { ToolContext } from "../src/tools/types";

/**
 * 第一期：小上下文档位、/context 数据源、工具限额与 bash artifact。
 */

const model = (contextWindow: number): ModelEntry => ({
  id: "fake/fake",
  provider: "fake",
  model: "fake",
  contextWindow,
});

const configOf = (contextWindow: number): XuanZhuConfig => ({
  ...DEFAULT_CONFIG,
  provider: "fake",
  model: "fake",
  models: [model(contextWindow)],
});

const events = (): AgentEvents => ({
  onText: () => undefined,
  onToolStart: () => undefined,
  onToolEnd: () => undefined,
  onStatus: () => undefined,
  confirm: async () => true,
});

const tmpCwd = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "xzh-context-"));

const textProvider = (seen: ChatOptions[]): LLMProvider => ({
  id: "fake",
  model: "fake",
  async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
    seen.push(options);
    yield { type: "text", text: "好的" };
    yield { type: "done", finishReason: "stop" };
  },
});

describe("small 档自动识别", () => {
  it("8k 窗口：极小档（tiny）——更短的 schema、输出 1024，仍留出可用预算", async () => {
    const cwd = tmpCwd();
    const seen: ChatOptions[] = [];
    const agent = new Agent(
      textProvider(seen),
      configOf(8192),
      cwd,
      events(),
      model(8192),
    );

    await agent.run("看看项目");
    const names = seen[0].tools.map((tool) => tool.name);
    expect(names).toContain("code_nav");
    expect(names).toContain("read_file");
    expect(names).toContain("bash");
    expect(names).toContain("todo_write");
    expect(names).not.toContain("task");
    // v2ray / 全局记忆精简在 small 档也要可用，否则外网失败时无法加载技能
    expect(names).toContain("load_skill");
    expect(names).toContain("memory");
    // 合并后的规范名只下发一次；旧名只做执行期别名
    expect(names).not.toContain("memory_write");
    expect(names).not.toContain("repo_map");
    expect(names).not.toContain("goal_complete");
    expect(seen[0].maxTokens).toBe(1024);
    // tiny 档会把工具描述截到一句话（90 字符 + 省略号）
    expect(seen[0].tools[0].description.length).toBeLessThanOrEqual(91);

    const report = agent.getContextReport();
    expect(report.profile).toBe("small");
    expect(report.window).toBe(8192);
    expect(report.maxOutputTokens).toBe(1024);
    expect(report.inputTokens).toBeGreaterThan(0);
    // 8k 窗口下至少要剩下够一轮对话的预算（固定开销不能把窗口吃光）
    expect(report.conversationBudget).toBeGreaterThan(2500);
  });

  it("32k 窗口仍走 small 档：输出 2048、schema 正常压缩", async () => {
    const cwd = tmpCwd();
    const seen: ChatOptions[] = [];
    const agent = new Agent(
      textProvider(seen),
      configOf(32_768),
      cwd,
      events(),
      model(32_768),
    );

    await agent.run("看看项目");
    const report = agent.getContextReport();
    expect(report.profile).toBe("small");
    expect(report.maxOutputTokens).toBe(2048);
    expect(report.conversationBudget).toBeGreaterThan(10_000);
  });

  it("配置 contextProfile=full 可强制完整档", async () => {
    const cwd = tmpCwd();
    const seen: ChatOptions[] = [];
    const config = { ...configOf(8192), contextProfile: "full" as const };
    const agent = new Agent(
      textProvider(seen),
      config,
      cwd,
      events(),
      model(8192),
    );

    await agent.run("看看项目");
    expect(seen[0].tools.map((tool) => tool.name)).toContain("task");
    expect(seen[0].maxTokens).toBeUndefined();
    expect(agent.getContextReport().profile).toBe("full");
  });

  it("full 档同样扣除工具 schema（小窗口时预算收敛到可发送范围）", async () => {
    const cwd = tmpCwd();
    const seen: ChatOptions[] = [];
    const config = { ...configOf(8192), contextProfile: "full" as const };
    const agent = new Agent(
      textProvider(seen),
      config,
      cwd,
      events(),
      model(8192),
    );

    await agent.run("看看项目");
    const report = agent.getContextReport();
    // system + tools + state 都要扣。只扣 system 会得到 0.8*window - system 的宽松预算，
    // 发出去必然超窗；这里断言预算不高于「扣掉全部固定项」，且低于只扣 system 的宽松值。
    const fixed =
      report.systemTokens +
      report.toolsTokens +
      report.stateTokens +
      (report.maxOutputTokens ?? 0);
    expect(report.conversationBudget).toBeLessThanOrEqual(
      Math.max(1, report.window - fixed),
    );
    expect(report.conversationBudget).toBeLessThan(
      report.window * 0.8 - report.systemTokens,
    );
  });

  it("普通模式工具 schema 保持精简（固定开销回归）", async () => {
    const cwd = tmpCwd();
    const seen: ChatOptions[] = [];
    const agent = new Agent(
      textProvider(seen),
      configOf(128_000),
      cwd,
      events(),
      model(128_000),
    );

    await agent.run("看看项目");
    // 18 个工具的 schema 每轮都要下发；超过这个量级说明描述又膨胀了
    expect(agent.getContextReport().toolsTokens).toBeLessThanOrEqual(3600);
  });

  it("模式工具不进通用注册表，small / 调研标记跟着工具定义走", () => {
    expect(TOOLS.some((tool) => tool.name.startsWith("btc_"))).toBe(false);
    expect(TOOLS.some((tool) => tool.name.startsWith("a_"))).toBe(false);

    const small = TOOLS.filter((tool) => tool.smallProfile).map((tool) => tool.name);
    expect(small.sort()).toEqual(
      [
        "ask_user",
        "bash",
        "bash_job",
        "code_nav",
        "edit_file",
        "glob",
        "grep",
        "list_dir",
        "load_skill",
        "memory",
        "read_file",
        "report_status",
        "todo_write",
        "watchdog",
        "write_file",
      ].sort(),
    );

    // `code_nav` 必须算调研：合并后旧名单漏掉它，导致大范围调研不触发子代理提醒
    expect(
      TOOLS.filter((tool) => tool.exploration).map((tool) => tool.name).sort(),
    ).toEqual(["code_nav", "glob", "grep", "list_dir", "read_file"]);
  });

  it("只读工具可并行，写入与执行类保持串行", () => {
    const flag = (name: string): boolean | undefined =>
      TOOLS.find((tool) => tool.name === name)?.parallelSafe;
    for (const name of ["read_file", "list_dir", "glob", "grep"]) {
      expect(flag(name), name).toBe(true);
    }
    for (const name of ["write_file", "edit_file", "bash"]) {
      expect(flag(name), name).not.toBe(true);
    }
  });

  it("合并后的工具仍接受旧名（执行期别名）", async () => {
    const cwd = tmpCwd();
    const ctx: ToolContext = { cwd, autoApprove: true };

    // memory_write → memory(action=write)，不应报「未知工具」
    const written = await executeTool(
      "memory_write",
      JSON.stringify({ content: "别名测试" }),
      ctx,
    );
    expect(written.ok).toBe(true);

    // read_symbol → code_nav(action=read)，只要求「不是未知工具」
    const nav = await executeTool(
      "read_symbol",
      JSON.stringify({ name: "不存在的符号" }),
      ctx,
    );
    expect(nav.content).not.toContain("未知工具");

    // bash_output → bash_job(action=output)，没有后台任务时给出明确说明
    const jobs = await executeTool("bash_output", JSON.stringify({}), ctx);
    expect(jobs.content).toContain("后台任务");
  });

  it("read_file 按 maxResultTokens 截断", async () => {
    const cwd = tmpCwd();
    const file = path.join(cwd, "long.txt");
    fs.writeFileSync(
      file,
      Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${"x".repeat(120)}`).join("\n"),
      "utf8",
    );
    const result = await readFileTool.execute(
      { path: file },
      { cwd, autoApprove: true, limits: { maxReadLines: 200, maxResultTokens: 120 } },
    );
    expect(result.content).toContain("按上下文预算截断");
    expect(result.content.length).toBeLessThan(2000);
  });

  it("bash 按 maxResultTokens 截断并提示完整输出去向", async () => {
    const cwd = tmpCwd();
    const result = await bashTool.execute(
      { command: `node -e "process.stdout.write('y'.repeat(4000))"`, timeout: 30_000 },
      { cwd, autoApprove: true, limits: { maxResultTokens: 200 } },
    );
    expect(result.content).toContain("按上下文预算截断");
    expect(result.content.length).toBeLessThan(1500);
  });
});

describe("自动压缩上下文", () => {
  const autoModel = (): ModelEntry => ({
    id: "fake/auto",
    provider: "fake",
    model: "fake",
    contextWindow: 128_000,
  });

  it("历史超过 85% 预算时自动摘要一次，并继续本轮", async () => {
    const cwd = tmpCwd();
    const seen: ChatMessage[][] = [];
    let summaryCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
        seen.push(options.messages);
        const isSummary = options.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes("压缩成一份可继续工作的摘要"),
        );
        if (isSummary) summaryCalls += 1;
        yield { type: "text", text: isSummary ? "已完成 A；下一步 B" : "好的" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const entry = autoModel();
    const config: XuanZhuConfig = {
      ...DEFAULT_CONFIG,
      provider: "fake",
      model: "fake",
      models: [entry],
      contextProfile: "full",
      autoCompact: true,
      maxOutputTokens: 4096,
    };
    const agent = new Agent(provider, config, cwd, events(), entry);

    // 约 40 万字符的中文历史：先被 trimHistory 裁到预算附近（>85%），再触发自动摘要
    const history: ChatMessage[] = [];
    for (let i = 0; i < 400; i++) {
      history.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "这是一段很长的历史内容".repeat(80),
      });
    }
    agent.restoreSession(history, path.join(cwd, "session.jsonl"));

    await agent.run("继续");

    expect(summaryCalls).toBe(1);
    expect(
      seen.some((messages) =>
        messages.some(
          (message) =>
            message.role === "system" && message.content.includes("[对话摘要]"),
        ),
      ),
    ).toBe(true);
  });

  it("配置 autoCompact=false 时不额外请求模型", async () => {
    const cwd = tmpCwd();
    let summaryCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
        const isSummary = options.messages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes("压缩成一份可继续工作的摘要"),
        );
        if (isSummary) summaryCalls += 1;
        yield { type: "text", text: "好的" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const entry = autoModel();
    const config: XuanZhuConfig = {
      ...DEFAULT_CONFIG,
      provider: "fake",
      model: "fake",
      models: [entry],
      contextProfile: "full",
      autoCompact: false,
      maxOutputTokens: 4096,
    };
    const agent = new Agent(provider, config, cwd, events(), entry);
    const history: ChatMessage[] = Array.from({ length: 400 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "这是一段很长的历史内容".repeat(80),
    }));
    agent.restoreSession(history, path.join(cwd, "session.jsonl"));

    await agent.run("继续");
    expect(summaryCalls).toBe(0);
  });
});

describe("工具限额", () => {
  it("read_file 按档位压低默认行数", async () => {
    const cwd = tmpCwd();
    const file = path.join(cwd, "big.txt");
    fs.writeFileSync(
      file,
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
      "utf8",
    );
    const ctx: ToolContext = {
      cwd,
      autoApprove: true,
      limits: { maxReadLines: 10 },
    };

    const result = await readFileTool.execute({ path: file }, ctx);
    expect(result.content).toContain("line 10");
    expect(result.content).not.toContain("line 11");
    expect(result.content).toContain("截断");
  });

  it("bash 超限时把完整输出写入 artifact，上下文只留摘要", async () => {
    const cwd = tmpCwd();
    const limits = {
      maxOutputChars: 500,
      artifactDir: path.join(cwd, ".xuanzhu", "artifacts"),
    };
    const result = await bashTool.execute(
      {
        command: `node -e "process.stdout.write('x'.repeat(5000))"`,
        timeout: 30_000,
      },
      { cwd, autoApprove: true, limits },
    );

    expect(result.content).toContain("完整输出已保存");
    const files = fs.readdirSync(limits.artifactDir);
    expect(files).toHaveLength(1);
    const artifact = fs.readFileSync(path.join(limits.artifactDir, files[0]), "utf8");
    expect(artifact.length).toBeGreaterThan(5000);
    // 进入上下文的内容被限制住，不会把窗口打满
    expect(result.content.length).toBeLessThan(1500);
  });
});
