import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/core/prompt";
import { applyInit, planInit } from "../src/init";
import { ensureProjectDir, loadAgentsFile, loadProjectRules } from "../src/workspace";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-rules-"));

describe("项目规则（AGENTS.md）", () => {
  it("启动只创建 .xuanzhu 记忆目录，不自动创建 AGENTS.md", () => {
    const cwd = tmp();
    ensureProjectDir(cwd);

    expect(fs.existsSync(path.join(cwd, ".xuanzhu", "memory"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
    expect(loadProjectRules(cwd)).toBeNull();
  });

  it("只有 xzh init 才在缺失时创建 AGENTS.md", () => {
    const cwd = tmp();
    const plan = planInit(cwd);
    expect(plan.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relPath: "AGENTS.md", action: "create" }),
      ]),
    );
    applyInit(plan);
    expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(true);
    expect(loadAgentsFile(cwd)?.length).toBeGreaterThan(0);
  });

  it("AGENTS.md 内容直接进入项目规则与系统提示词", () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, "AGENTS.md"),
      "# Demo 项目\n\n- 用 pnpm\n- 测试命令：pnpm test\n",
    );
    const rules = loadProjectRules(cwd) ?? "";
    expect(rules).toContain("测试命令：pnpm test");

    const prompt = buildSystemPrompt(
      cwd,
      undefined,
      rules,
      null,
      undefined,
      false,
      false,
      null,
      4000,
    );
    expect(prompt).toContain("## 项目规则（AGENTS.md");
    expect(prompt).toContain("测试命令：pnpm test");
  });

  it("已有 AGENTS.md 时不再读取 rules.md", () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, ".xuanzhu"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "- 只认 AGENTS\n");
    fs.writeFileSync(
      path.join(cwd, ".xuanzhu", "rules.md"),
      "- 不应被读取的 rules\n",
    );
    expect(loadAgentsFile(cwd)).toContain("只认 AGENTS");
    expect(loadProjectRules(cwd)).not.toContain("不应被读取的 rules");
  });
});
