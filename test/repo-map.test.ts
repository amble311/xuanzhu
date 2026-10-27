import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildRepoIndex,
  clearRepoIndexCache,
  findSymbolTool,
  readSymbolTool,
  repoMapTool,
} from "../src/tools/repo-map";
import { normalizeSubagentReport } from "../src/subagents/report";
import type { ToolContext } from "../src/tools/types";

/**
 * 第三期：仓库地图 / 符号检索 / 子代理报告 schema。
 */

const tmpCwd = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "xzh-repo-map-"));

const ctxOf = (cwd: string): ToolContext => ({ cwd, autoApprove: true });

function seedProject(): string {
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, "src", "core"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src", "tools"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "src", "core", "agent.ts"),
    [
      "export class Agent {",
      "  run() {",
      "    return buildThing();",
      "  }",
      "}",
      "",
      "export function buildThing(): string {",
      "  const value = 'ok';",
      "  return value;",
      "}",
      "",
      "const helper = 1;",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, "src", "tools", "job.py"),
    ["def run_task():", "    return 1", "", "class Runner:", "    pass", ""].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, "README.md"),
    "# Demo\n\n介绍。\n\n## Usage\n\n说明。\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(cwd, "node_modules", "pkg", "index.ts"),
    "export function ignored() {}\n",
    "utf8",
  );
  return cwd;
}

describe("仓库地图索引", () => {
  it("索引常见语言符号，跳过 node_modules", () => {
    const cwd = seedProject();
    clearRepoIndexCache();
    const index = buildRepoIndex(cwd, true);
    const ts = index.files.find((file) => file.path === "src/core/agent.ts");
    expect(ts?.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["Agent", "buildThing", "helper"]),
    );
    const py = index.files.find((file) => file.path === "src/tools/job.py");
    expect(py?.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["run_task", "Runner"]),
    );
    expect(index.files.some((file) => file.path.includes("node_modules"))).toBe(
      false,
    );
  });

  it("repo_map 按查询返回相关文件与符号", async () => {
    const cwd = seedProject();
    clearRepoIndexCache();
    const result = await repoMapTool.execute(
      { query: "buildThing" },
      ctxOf(cwd),
    );
    expect(result.content).toContain("src/core/agent.ts");
    expect(result.content).toContain("buildThing");
    expect(result.content).not.toContain("node_modules");
  });

  it("find_symbol 返回文件:行号与签名", async () => {
    const cwd = seedProject();
    clearRepoIndexCache();
    const result = await findSymbolTool.execute(
      { name: "buildThing" },
      ctxOf(cwd),
    );
    expect(result.content).toContain("src/core/agent.ts:7");
    expect(result.content).toContain("function");
  });

  it("read_symbol 只读目标符号，不越界到下一个定义", async () => {
    const cwd = seedProject();
    clearRepoIndexCache();
    const result = await readSymbolTool.execute(
      { name: "buildThing" },
      ctxOf(cwd),
    );
    expect(result.content).toContain("return value;");
    expect(result.content).not.toContain("const helper");
  });

  it("Python 符号按缩进截断", async () => {
    const cwd = seedProject();
    clearRepoIndexCache();
    const result = await readSymbolTool.execute(
      { name: "run_task", path: "src/tools/job.py" },
      ctxOf(cwd),
    );
    expect(result.content).toContain("return 1");
    expect(result.content).not.toContain("class Runner");
  });
});

describe("子代理报告 schema", () => {
  it("没有小节时补上结论标题，并按上限截断", () => {
    const plain = normalizeSubagentReport("这是一段结论。", 500);
    expect(plain.structured).toBe(false);
    expect(plain.text.startsWith("## 结论")).toBe(true);

    const long = normalizeSubagentReport("x".repeat(2000), 500);
    expect(long.truncated).toBe(true);
    expect(long.text).toContain("已截断");
    expect(long.after).toBeLessThanOrEqual(600);
  });

  it("已有小节时保留结构", () => {
    const report = normalizeSubagentReport(
      "## 结论\n完成\n\n## 证据\nsrc/a.ts:3",
      4000,
    );
    expect(report.structured).toBe(true);
    expect(report.text).toContain("## 证据");
  });
});
