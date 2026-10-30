import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import { DEFAULT_CONFIG, type ModelEntry, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
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
  it("8k 窗口：精简工具、紧凑提示词、输出上限 2048", async () => {
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
    expect(names).toContain("repo_map");
    expect(names).toContain("find_symbol");
    expect(names).toContain("read_symbol");
    expect(names).toContain("read_file");
    expect(names).toContain("bash");
    expect(names).toContain("todo_write");
    expect(names).not.toContain("task");
    // v2ray / 全局记忆精简在 small 档也要可用，否则外网失败时无法加载技能
    expect(names).toContain("load_skill");
    expect(names).toContain("memory_compact");
    expect(names).not.toContain("goal_complete");
    expect(seen[0].maxTokens).toBe(2048);

    const report = agent.getContextReport();
    expect(report.profile).toBe("small");
    expect(report.window).toBe(8192);
    expect(report.maxOutputTokens).toBe(2048);
    expect(report.inputTokens).toBeGreaterThan(0);
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
