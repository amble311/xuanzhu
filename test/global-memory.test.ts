import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Agent, type AgentEvents } from "../src/core/agent";
import { buildSystemPrompt } from "../src/core/prompt";
import { DEFAULT_CONFIG, type XuanZhuConfig } from "../src/config/store";
import type { ChatOptions, LLMProvider, StreamChunk } from "../src/llm/types";
import { memoryWriteTool } from "../src/tools/memory";
import { captureGlobalMemoryFromUser } from "../src/workspace/global-capture";
import {
  appendGlobalMemory,
  appendGlobalTopicEntry,
  appendMemory,
  clearGlobalMemory,
  inspectGlobalMemory,
  readGlobalMemory,
  readProjectMemory,
  resolveGlobalMemoryPaths,
  pruneGlobalMemory,
  selectRelevantGlobalMemory,
  writeGlobalMemory,
} from "../src/workspace";
import {
  deleteSecret,
  listSecrets,
  loadSecret,
  protectSecretsInText,
  storeSecret,
  vaultDir,
} from "../src/secrets/vault";

/**
 * 全局记忆与加密凭据的回归测试。
 *
 * 全局记忆必须严格隔离在临时 XZH_HOME 下，绝不碰真实 ~/.xzh；
 * 密码只允许进 AES-GCM 加密库，记忆/日志里不能出现明文。
 */

const originalHome = process.env.XZH_HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-global-memory-"));
process.env.XZH_HOME = home;

const tmpProject = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "xzh-global-project-"));

beforeEach(() => {
  fs.rmSync(path.join(home, "memory"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "vault"), { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.XZH_HOME;
  else process.env.XZH_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const ctx = () => ({ cwd: tmpProject(), autoApprove: true });

describe("全局记忆", () => {
  it("写入 / 读取 / 按主题记录 / 清空都在 ~/.xzh/memory", () => {
    appendGlobalMemory("- 用户偏好：中文回答", "long");
    appendGlobalTopicEntry(
      "网络代理",
      "- 2026-10-31：本机 SOCKS5 127.0.0.1:1080 可用。",
    );

    const memory = readGlobalMemory();
    expect(memory.longTerm).toContain("用户偏好：中文回答");
    expect(memory.longTerm).toContain("## 自动记录 · 网络代理");
    expect(memory.longTerm).toContain("127.0.0.1:1080");

    const status = inspectGlobalMemory();
    expect(status.dir).toBe(resolveGlobalMemoryPaths().memoryDir);
    expect(status.hasLongTerm).toBe(true);
    expect(status.longTermChars).toBeGreaterThan(0);

    clearGlobalMemory();
    expect(readGlobalMemory().longTerm).toBe("");
    expect(inspectGlobalMemory().hasLongTerm).toBe(false);
  });

  it("全局记忆与项目记忆互不影响", () => {
    const cwd = tmpProject();
    appendGlobalMemory("- 全局事实", "long");
    appendMemory(cwd, "- 项目事实", "long");

    expect(readGlobalMemory().longTerm).toContain("全局事实");
    expect(readGlobalMemory().longTerm).not.toContain("项目事实");
    expect(readProjectMemory(cwd).longTerm).toContain("项目事实");
    expect(readProjectMemory(cwd).longTerm).not.toContain("全局事实");
  });

  it("系统提示词注入全局记忆，且排在项目记忆之前", () => {
    writeGlobalMemory("## 网络代理\n\n- 本机 127.0.0.1:1080 可用。");
    const prompt = buildSystemPrompt(
      tmpProject(),
      undefined,
      null,
      { longTerm: "## 项目约定\n\n- 用 pnpm。", recentDaily: "" },
      undefined,
      false,
      false,
      readGlobalMemory(),
      4_000,
    );

    expect(prompt).toContain("## 全局记忆（跨项目）");
    expect(prompt).toContain("127.0.0.1:1080");
    expect(prompt.indexOf("## 全局记忆")).toBeLessThan(
      prompt.indexOf("## 项目记忆"),
    );
  });
});

describe("自动全局记忆捕获", () => {
  it("捕获明确说「以后都 / 所有项目」的偏好", () => {
    const result = captureGlobalMemoryFromUser(
      "以后都用 pnpm，所有项目统一用这个包管理器。",
    );
    expect(result.added).toBe(true);
    expect(readGlobalMemory().longTerm).toContain("pnpm");
  });

  it("sudo 密码自动加密，记忆里只有引用", () => {
    const result = captureGlobalMemoryFromUser("我的 sudo 密码是 s3cret-pw");
    expect(result.added).toBe(true);
    expect(result.credentialIds.length).toBe(1);

    const memory = readGlobalMemory().longTerm;
    expect(memory).toContain("[加密凭据 ");
    expect(memory).not.toContain("s3cret-pw");
    expect(loadSecret(result.credentialIds[0])).toBe("s3cret-pw");
  });

  it("问题句不写入，避免把「密码怎么设置」当成事实", () => {
    const result = captureGlobalMemoryFromUser("sudo 密码怎么设置？");
    expect(result.added).toBe(false);
  });

  it("Agent 对长全局记忆按用户消息注入相关小节", async () => {
    const long = [
      "# 全局长期记忆",
      "",
      "## 网络代理",
      "- 本机 SOCKS 10808 可用。",
      "",
      "## 其他细节",
      Array.from({ length: 120 }, (_, i) => `- 无关细节 ${i} ` + "x".repeat(40)).join("\n"),
    ].join("\n");
    writeGlobalMemory(long);

    const cwd = tmpProject();
    const seen: ChatOptions[] = [];
    const events: AgentEvents = {
      onText: () => undefined,
      onToolStart: () => undefined,
      onToolEnd: () => undefined,
      onStatus: () => undefined,
      confirm: async () => true,
    };
    const config: XuanZhuConfig = {
      ...DEFAULT_CONFIG,
      provider: "fake",
      model: "fake",
      models: [
        {
          id: "fake/fake",
          provider: "fake",
          model: "fake",
          contextWindow: 100_000,
        },
      ],
    };
    const provider: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
        seen.push(options);
        yield { type: "text", text: "好的" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const agent = new Agent(provider, config, cwd, events);
    await agent.run("本机代理端口怎么用");

    const system = seen[0]?.messages.find((message) => message.role === "system");
    expect(system?.content).toContain("本轮相关全局记忆");
    expect(system?.content).toContain("## 网络代理");
  });

  it("Agent.run 会自动触发全局捕获并提示用户", async () => {
    const cwd = tmpProject();
    const notices: string[] = [];
    const events: AgentEvents = {
      onText: () => undefined,
      onToolStart: () => undefined,
      onToolEnd: () => undefined,
      onStatus: () => undefined,
      onNotice: (message) => notices.push(message),
      confirm: async () => true,
    };
    const config: XuanZhuConfig = {
      ...DEFAULT_CONFIG,
      provider: "fake",
      model: "fake",
      models: [
        {
          id: "fake/fake",
          provider: "fake",
          model: "fake",
          contextWindow: 100_000,
        },
      ],
    };
    const provider: LLMProvider = {
      id: "fake",
      model: "fake",
      async *chat(_options: ChatOptions): AsyncGenerator<StreamChunk> {
        yield { type: "text", text: "好的" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const agent = new Agent(provider, config, cwd, events);
    await agent.run("以后都用 pnpm");

    expect(readGlobalMemory().longTerm).toContain("pnpm");
    expect(notices.some((item) => item.includes("自动记录全局记忆"))).toBe(true);
  });
});

describe("加密凭据库", () => {
  it("AES-GCM 保存：记忆与磁盘都看不到明文，文件权限 0600", () => {
    const id = storeSecret("p@ssw0rd", "sudo 密码");
    expect(loadSecret(id)).toBe("p@ssw0rd");
    expect(listSecrets()).toEqual([
      expect.objectContaining({ id, label: "sudo 密码" }),
    ]);

    const entries = fs.readFileSync(
      path.join(vaultDir(), "entries.json"),
      "utf8",
    );
    expect(entries).not.toContain("p@ssw0rd");
    expect(fs.statSync(path.join(vaultDir(), "entries.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.statSync(path.join(vaultDir(), "key")).mode & 0o777).toBe(0o600);

    expect(deleteSecret(id)).toBe(true);
    expect(loadSecret(id)).toBeNull();
  });

  it("文本保护只替换凭据值，返回引用 id", () => {
    const protectedText = protectSecretsInText(
      "sudo 密码是 abc123\n数据库密码是 dbpass。",
    );
    expect(protectedText.text).toContain("[加密凭据 ");
    expect(protectedText.text).not.toContain("abc123");
    expect(protectedText.text).not.toContain("dbpass");
    expect(protectedText.credentialIds).toHaveLength(2);
  });

  it("模型主动写全局记忆需要确认；拒绝时不落盘", async () => {
    const denied = await memoryWriteTool.execute(
      { content: "- 全局事实：用 pnpm", target: "global", scope: "long" },
      { ...ctx(), confirm: async () => false },
    );
    expect(denied.ok).toBe(false);
    expect(readGlobalMemory().longTerm).toBe("");
  });

  it("从工具输出来源写项目记忆需要确认", async () => {
    const cwd = tmpProject();
    const denied = await memoryWriteTool.execute(
      {
        content: "工具输出总结：项目使用 pnpm",
        target: "project",
        scope: "long",
        source: "tool",
      },
      { cwd, autoApprove: true, confirm: async () => false },
    );
    expect(denied.ok).toBe(false);
    expect(readProjectMemory(cwd).longTerm).toBe("");

    const approved = await memoryWriteTool.execute(
      {
        content: "用户要求记录：项目使用 pnpm",
        target: "project",
        scope: "long",
        source: "user",
      },
      { cwd, autoApprove: true, confirm: async () => false },
    );
    expect(approved.ok).toBe(true);
  });

  it("memory_write 自动加密后落盘，不拒绝写入", async () => {
    const result = await memoryWriteTool.execute(
      { content: "sudo 密码是 p@ssw0rd", target: "global", scope: "long" },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("已加密");

    const memory = readGlobalMemory().longTerm;
    expect(memory).toContain("[加密凭据 ");
    expect(memory).not.toContain("p@ssw0rd");
  });
});

describe("全局记忆检索与 TTL", () => {
  it("按当前用户消息挑选相关主题，而不是整段注入", () => {
    writeGlobalMemory(
      [
        "# 全局长期记忆",
        "",
        "## 网络代理",
        "- 本机 SOCKS 10808 可用。",
        "",
        "## 用户偏好",
        "- 回答用中文。",
      ].join("\n"),
    );

    const selected = selectRelevantGlobalMemory(
      readGlobalMemory().longTerm,
      "本机代理端口 10808 怎么用",
      1_800,
    );
    expect(selected).toContain("## 网络代理");
    expect(selected).toContain("10808");
    expect(selected).not.toContain("## 用户偏好");
  });

  it("清理超过 TTL 的自动记录，保留手工小节和近期记录", () => {
    writeGlobalMemory(
      [
        "# 全局长期记忆",
        "",
        "## 手工约定",
        "- 这是用户自己整理的内容，不应被 TTL 删除。",
        "",
        "## 自动记录 · 全局信息",
        "- 2025-01-01：过期代理端口。",
        "  这是过期条目的续行，应一起删除。",
        "- 2026-10-31：近期代理端口。",
      ].join("\n"),
    );

    const removed = pruneGlobalMemory(90, new Date("2026-10-31T12:00:00Z"));
    expect(removed).toBe(1);

    const text = readGlobalMemory().longTerm;
    expect(text).not.toContain("过期代理端口");
    expect(text).not.toContain("这是过期条目的续行");
    expect(text).toContain("近期代理端口");
    expect(text).toContain("这是用户自己整理的内容");
  });

  it("长全局记忆在静态提示词里只放主题目录", () => {
    const long = [
      "# 全局长期记忆",
      "",
      "## 网络代理",
      "- 本机代理信息。",
      "",
      "## 长主题",
      Array.from({ length: 200 }, (_, i) => `- 第 ${i} 条细节 ` + "x".repeat(40)).join("\n"),
    ].join("\n");
    const prompt = buildSystemPrompt(
      tmpProject(),
      undefined,
      null,
      null,
      undefined,
      false,
      false,
      { longTerm: long, recentDaily: "" },
      4_000,
    );
    expect(prompt).toContain("现有全局记忆（主题目录）");
    expect(prompt).not.toContain("第 199 条细节");
  });
});
