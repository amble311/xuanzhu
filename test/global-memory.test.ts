import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/core/prompt";
import { memoryWriteTool } from "../src/tools/memory";
import {
  appendGlobalMemory,
  appendGlobalTopicEntry,
  appendMemory,
  clearGlobalMemory,
  inspectGlobalMemory,
  readGlobalMemory,
  readProjectMemory,
  resolveGlobalMemoryPaths,
  writeGlobalMemory,
} from "../src/workspace";
import {
  deleteSecret,
  listSecretNames,
  readSecret,
  saveSecret,
  secretsDir,
} from "../src/secrets/store";
import { runWithSudo } from "../src/secrets/sudo";

/**
 * 全局记忆与本地凭据的回归测试。
 *
 * 全局记忆必须严格隔离在临时 XZH_HOME 下，绝不碰真实 ~/.xzh；
 * 密码只允许进 0600 凭据文件，不能出现在全局记忆里。
 */

const originalHome = process.env.XZH_HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-global-memory-"));
process.env.XZH_HOME = home;

const tmpProject = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "xzh-global-project-"));

beforeEach(() => {
  fs.rmSync(path.join(home, "memory"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "secrets"), { recursive: true, force: true });
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

  it("拒绝把密码/T 令牌原文写入全局记忆，但允许凭据指针", async () => {
    const rejected = await memoryWriteTool.execute(
      { content: "sudo 密码: p@ssw0rd", target: "global", scope: "long" },
      ctx(),
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.content).toContain("拒绝写入记忆");
    expect(readGlobalMemory().longTerm).toBe("");

    const projectRejected = await memoryWriteTool.execute(
      { content: "token=abcdef123456", target: "project", scope: "long" },
      ctx(),
    );
    expect(projectRejected.ok).toBe(false);

    const pointer = await memoryWriteTool.execute(
      {
        content: "sudo 密码位置：~/.xzh/secrets/sudo，使用 xzh sudo 执行。",
        target: "global",
        scope: "long",
      },
      ctx(),
    );
    expect(pointer.ok).toBe(true);
    expect(readGlobalMemory().longTerm).toContain("xzh sudo");
  });
});

describe("本地凭据", () => {
  it("以 0600 保存、只列出名称、可删除", () => {
    const file = saveSecret("sudo", "p@ssw0rd");
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.statSync(secretsDir()).mode & 0o777).toBe(0o700);
    expect(readSecret("sudo")).toBe("p@ssw0rd");
    expect(listSecretNames()).toEqual(["sudo"]);

    expect(deleteSecret("sudo")).toBe(true);
    expect(readSecret("sudo")).toBeNull();
  });

  it("拒绝路径穿越式名称", () => {
    expect(() => saveSecret("../config", "x")).toThrow(/非法凭据名称/);
  });

  it.skipIf(process.platform === "win32")(
    "xzh sudo 只通过 stdin 把密码交给 sudo",
    async () => {
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-fake-sudo-"));
      const fake = path.join(bin, "sudo");
      fs.writeFileSync(
        fake,
        '#!/bin/sh\nread -r pw\n[ "$pw" = "test-pw" ] || exit 9\nshift 4\nexec "$@"\n',
        { mode: 0o755 },
      );
      const oldPath = process.env.PATH;
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      try {
        const ok = await runWithSudo("test-pw", [
          process.execPath,
          "-e",
          "process.exit(0)",
        ]);
        expect(ok.code).toBe(0);
        const bad = await runWithSudo("wrong", [
          process.execPath,
          "-e",
          "process.exit(0)",
        ]);
        expect(bad.code).toBe(9);
      } finally {
        process.env.PATH = oldPath;
        fs.rmSync(bin, { recursive: true, force: true });
      }
    },
  );
});
