import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../src/core/agent";
import {
  DEFAULT_CONFIG,
  type ModelEntry,
  type XuanZhuConfig,
} from "../src/config/store";
import {
  clearErrorReports,
  errorReportsDir,
  findErrorReport,
  listErrorReports,
  MAX_ERROR_REPORTS,
  recordErrorReport,
} from "../src/utils/error-reports";
import { executeTool } from "../src/tools";
import type { ToolDefinition } from "../src/tools/types";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";

/**
 * 错误报告（bug 收集）：写盘、按签名去重计数、上限裁剪、脱敏，以及三个钩子点
 * （工具抛异常 / 整轮失败 / 未捕获异常由 cli 层调，这里覆盖前两个）。
 *
 * 全局目录由 vitest.config.ts 重定向到临时目录，报告不会落到真实的 ~/.xzh/errors。
 */

const tmpCwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-err-"));

describe("错误报告：写盘与去重", () => {
  it("写入结构化字段，并对密钥脱敏", () => {
    const file = recordErrorReport({
      kind: "uncaught-exception",
      category: "bug",
      error: new Error("认证失败：sk-abcdef123456789"),
      cwd: "/tmp/proj",
      project: "/tmp/proj/.xuanzhu",
      model: "custom/mix",
      provider: "custom",
      recent: [
        { role: "user", content: "帮我看看" },
        { role: "assistant", content: "x".repeat(500) },
      ],
    });
    expect(file).toBeTruthy();
    const report = JSON.parse(fs.readFileSync(file!, "utf8"));
    expect(report.kind).toBe("uncaught-exception");
    expect(report.category).toBe("bug");
    expect(report.message).toContain("sk-***");
    expect(report.message).not.toContain("abcdef123456789");
    expect(report.cwd).toBe("/tmp/proj");
    expect(report.project).toBe("/tmp/proj/.xuanzhu");
    expect(report.model).toBe("custom/mix");
    expect(report.count).toBe(1);
    expect(report.version).toBeTruthy();
    expect(report.node).toBe(process.version);
    // 最近消息被截断（不把整段代码/日志带进报告）
    expect(report.recent).toHaveLength(2);
    expect(report.recent[1].content.length).toBeLessThanOrEqual(201);
  });

  it("同样的错误只累加 count，不刷出多份文件", () => {
    const before = listErrorReports().length;
    const input = {
      kind: "tool-error" as const,
      category: "bug" as const,
      error: new Error("同样的错"),
      tool: "bash",
      cwd: "/tmp/proj",
    };
    const first = recordErrorReport(input);
    const second = recordErrorReport(input);
    expect(second).toBe(first);
    expect(listErrorReports().length).toBe(before + 1);

    const report = JSON.parse(fs.readFileSync(first!, "utf8"));
    expect(report.count).toBe(2);
    expect(report.firstTime <= report.lastTime).toBe(true);
  });

  it("不同错误各自成文件，列表按最后出现时间倒序", () => {
    recordErrorReport({ kind: "turn-failed", error: new Error("错误甲"), cwd: "/tmp" });
    recordErrorReport({ kind: "turn-failed", error: new Error("错误乙"), cwd: "/tmp" });
    const reports = listErrorReports();
    const messages = reports.map((report) => report.message);
    expect(messages).toContain("错误甲");
    expect(messages).toContain("错误乙");
    // 倒序：最近的在前
    const times = reports.map((report) => report.lastTime);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("超过上限时丢弃最旧的报告", () => {
    clearErrorReports();
    for (let i = 0; i < MAX_ERROR_REPORTS + 5; i++) {
      recordErrorReport({ kind: "turn-failed", error: new Error(`批量错误 ${i}`) });
    }
    const reports = listErrorReports();
    expect(reports.length).toBe(MAX_ERROR_REPORTS);
    // 最旧的几条已被删除，最新的还在
    expect(reports.some((report) => report.message === `批量错误 ${MAX_ERROR_REPORTS + 4}`)).toBe(
      true,
    );
    expect(reports.some((report) => report.message === "批量错误 0")).toBe(false);
  });

  it("选择器支持序号与签名前缀；clear 清空并返回份数", () => {
    clearErrorReports();
    recordErrorReport({ kind: "tool-error", error: new Error("可选择的错误") });
    const [report] = listErrorReports();
    expect(findErrorReport("1")?.signature).toBe(report.signature);
    expect(findErrorReport(report.signature.slice(0, 6))?.signature).toBe(report.signature);
    expect(findErrorReport("999")).toBeUndefined();

    expect(clearErrorReports()).toBe(1);
    expect(listErrorReports()).toHaveLength(0);
    expect(fs.existsSync(errorReportsDir())).toBe(false);
  });
});

describe("错误报告：钩子点", () => {
  it("工具内部抛异常 → 返回 ok:false，并记一份 tool-error", () => {
    clearErrorReports();
    const boom: ToolDefinition = {
      name: "boom_tool",
      description: "测试用",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("工具实现崩了");
      },
    };
    return executeTool("boom_tool", "{}", { cwd: "/tmp/xzh-err-ctx" }, [boom]).then(
      (result) => {
        expect(result.ok).toBe(false);
        expect(result.content).toContain("工具实现崩了");
        const reports = listErrorReports();
        expect(reports).toHaveLength(1);
        expect(reports[0].kind).toBe("tool-error");
        expect(reports[0].tool).toBe("boom_tool");
        expect(reports[0].category).toBe("bug");
      },
    );
  });

  it("整轮失败 → 记一份 turn-failed，带模型与项目上下文", async () => {
    clearErrorReports();
    const entry: ModelEntry = {
      id: "ollama/llama3",
      provider: "ollama",
      model: "llama3",
    };
    const config: XuanZhuConfig = {
      ...DEFAULT_CONFIG,
      provider: entry.provider,
      model: entry.model,
      models: [entry],
    };
    const failing: LLMProvider = {
      id: "ollama",
      model: "llama3",
      async *chat(_options: ChatOptions): AsyncGenerator<StreamChunk> {
        throw new Error("服务端 500：内部错误");
      },
    };
    const events: AgentEvents = {
      onText: () => undefined,
      onToolStart: () => undefined,
      onToolEnd: () => undefined,
      onStatus: () => undefined,
      confirm: async () => true,
    };
    const cwd = tmpCwd();
    const agent = new Agent(failing, config, cwd, events, entry);

    await expect(agent.run("随便问点什么")).rejects.toThrow();

    const reports = listErrorReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe("turn-failed");
    expect(reports[0].model).toBe(entry.id);
    expect(reports[0].provider).toBe("ollama");
    expect(reports[0].cwd).toBe(cwd);
    expect(reports[0].project).toBe(path.join(cwd, ".xuanzhu"));
    // 带上最近的对话，便于复现
    expect(reports[0].recent?.some((item) => item.content === "随便问点什么")).toBe(true);
  });
});
