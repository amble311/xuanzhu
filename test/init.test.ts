import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { applyInit, planInit } from "../src/init";
import { scanProject } from "../src/init/scan";

/**
 * `xzh init` 的扫描与写入策略。
 *
 * 所有用例都跑在临时目录里 —— **绝不能对仓库自身执行**（会把本项目的
 * AGENTS.md / docs 当成测试夹具改掉）。
 */

const tmpProject = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "xzh-init-"));

const write = (root: string, rel: string, content: string): void => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
};

/** 一个典型的 Node/TS 项目夹具 */
const makeNodeProject = (root: string): void => {
  write(
    root,
    "package.json",
    JSON.stringify(
      {
        name: "demo-app",
        version: "1.2.3",
        description: "演示项目",
        scripts: {
          dev: "vite",
          build: "tsc && vite build",
          test: "vitest run",
          lint: "eslint .",
        },
        devDependencies: { vitest: "^3.2.0", typescript: "^5.4.0" },
      },
      null,
      2,
    ),
  );
  write(root, "README.md", "# Demo\n\n这是演示项目的说明。\n");
  write(root, "tsconfig.json", "{\"compilerOptions\":{\"strict\":true}}\n");
  write(root, ".gitignore", "node_modules\ndist\n");
  write(root, "src/index.ts", "export const a = 1;\n");
  write(root, "src/util.ts", "export const b = 2;\n");
  write(root, "tests/index.test.ts", "test('x', () => {});\n");
  write(root, "docs/guide.md", "# 指南\n");
  // 必须被忽略
  write(root, "node_modules/pkg/index.js", "x\n");
  write(root, "dist/out.js", "x\n");
};

describe("项目扫描", () => {
  it("识别技术栈、命令、目录与既有文档，并跳过依赖 / 构建产物", () => {
    const root = tmpProject();
    makeNodeProject(root);

    const facts = scanProject(root);

    expect(facts.name).toBe("demo-app");
    expect(facts.version).toBe("1.2.3");
    expect(facts.description).toBe("演示项目");
    expect(facts.languages).toContain("Node.js");
    expect(facts.languages).toContain("TypeScript");
    expect(facts.packageManager).toBe("npm");
    expect(facts.testFramework).toBe("vitest");

    expect(facts.commands.map((command) => command.name)).toContain("安装依赖");
    const testCommand = facts.commands.find((command) => command.name === "测试");
    expect(testCommand?.command).toBe("npm run test");
    const buildCommand = facts.commands.find((command) => command.name === "构建");
    expect(buildCommand?.command).toBe("npm run build");

    const dirNames = facts.directories.map((dir) => dir.name);
    expect(dirNames).toContain("src");
    expect(dirNames).toContain("tests");
    expect(dirNames).toContain("docs");
    expect(dirNames).not.toContain("node_modules");
    expect(dirNames).not.toContain("dist");

    expect(facts.docs).toContain("README.md");
    expect(facts.docs).toContain("docs/guide.md");
    expect(facts.configs).toContain("tsconfig.json");
    expect(facts.configs).toContain(".gitignore");

    // node_modules 与 dist 里的文件不计入规模
    expect(facts.fileCount).toBeGreaterThan(5);
    expect(facts.fileCount).toBeLessThan(20);
  });

  it("docs 子目录：递归扫描（最多两层），隐藏目录与更深层不进入", () => {
    const root = tmpProject();
    makeNodeProject(root);
    write(root, "docs/guides/README.md", "# 安装指南\n\n本目录放部署与排障流程。\n");
    write(root, "docs/guides/setup.md", "# 本地安装\n\n步骤。\n");
    write(root, "docs/reference/api/auth.md", "# 鉴权\n");
    write(root, "docs/guides/.draft/hidden.md", "# 草稿\n");
    write(root, "docs/a/b/c/deep.md", "# 太深\n");

    const facts = scanProject(root);
    expect(facts.docs).toContain("docs/guides/setup.md");
    expect(facts.docs).toContain("docs/reference/api/auth.md");
    expect(facts.docs).not.toContain("docs/guides/.draft/hidden.md");
    expect(facts.docs).not.toContain("docs/a/b/c/deep.md");

    const paths = facts.docGroups.map((group) => group.path);
    expect(paths).toContain("docs");
    expect(paths).toContain("docs/guides");
    expect(paths).toContain("docs/reference/api");
    // 子目录 README 的一级标题作为目录说明
    expect(facts.docGroups.find((group) => group.path === "docs/guides")?.title).toBe("安装指南");
  });

  it("没有 package.json 时用目录名兜底，不产生命令之外的事实", () => {
    const root = tmpProject();
    write(root, "main.go", "package main\n");
    write(root, "go.mod", "module demo\n");

    const facts = scanProject(root);
    expect(facts.name).toBe(path.basename(root));
    expect(facts.languages).toContain("Go");
    expect(facts.commands.map((command) => command.command)).toContain("go test ./...");
  });
});

describe("计划与写入", () => {
  it("空项目：生成 AGENTS.md 与 docs/ 文件，但没有任何文件被提前写入", () => {
    const root = tmpProject();
    makeNodeProject(root);

    const plan = planInit(root);
    expect(plan.files.map((file) => file.relPath)).toContain("AGENTS.md");
    expect(plan.files.map((file) => file.relPath)).toContain("docs/ARCHITECTURE.md");
    expect(plan.files.map((file) => file.relPath)).toContain("docs/COMMANDS.md");
    expect(plan.files.map((file) => file.relPath)).toContain("docs/README.md");
    // 计划阶段不写盘
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false);

    const agents = plan.files.find((file) => file.relPath === "AGENTS.md")!;
    expect(agents.action).toBe("create");
    expect(agents.content).toContain("# demo-app 开发规范");
    expect(agents.content).toContain("`npm run test`");
    expect(agents.content).toContain("## 目录结构");
    expect(agents.content).toContain("本文件只保留入口级大纲");
    expect(agents.content).toContain("## 文档同步");
    expect(agents.content).toContain("额外告知用户设计变化");
    expect(agents.content).toContain("docs/ARCHITECTURE.md");
    expect(agents.content).not.toContain("| 用途 | 命令 | 来源 |");

    const docsIndex = plan.files.find((file) => file.relPath === "docs/README.md")!;
    expect(docsIndex.content).toContain("对应关系");
    expect(docsIndex.content).toContain("AGENTS.md");
    expect(docsIndex.content).toContain("docs/ARCHITECTURE.md");
  });

  it("docs 子目录：AGENTS 按目录汇总，docs/README.md 分组列出", () => {
    const root = tmpProject();
    makeNodeProject(root);
    write(root, "docs/guides/setup.md", "# 本地安装\n");
    write(root, "docs/reference/api/auth.md", "# 鉴权\n");

    const plan = planInit(root);
    const agents = plan.files.find((file) => file.relPath === "AGENTS.md")!;
    expect(agents.content).toContain("`docs/guides/`（1 篇）— 操作指南");
    expect(agents.content).toContain("`docs/reference/api/`（1 篇）— 参考手册");
    expect(agents.content).toContain("完整文档地图（含子目录）见 `docs/README.md`");
    // 子目录里的文件不逐条进 AGENTS
    expect(agents.content).not.toContain("docs/guides/setup.md");

    const index = plan.files.find((file) => file.relPath === "docs/README.md")!;
    expect(index.content).toContain("## 目录分工");
    expect(index.content).toContain("`docs/guides/` | 操作指南");
    expect(index.content).toContain("### `docs/guides/` — 操作指南");
    expect(index.content).toContain("`docs/reference/api/auth.md`");
  });

  it("写入后再计划 → 全部跳过（幂等，无变化不写盘）", () => {
    const root = tmpProject();
    makeNodeProject(root);

    applyInit(planInit(root));
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "docs/ARCHITECTURE.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "docs/README.md"))).toBe(true);

    const second = planInit(root);
    expect(second.files.every((file) => file.action === "skip")).toBe(true);
  });

  it("已有 AGENTS.md：只追加缺失小节，保留用户内容", () => {
    const root = tmpProject();
    makeNodeProject(root);
    const original = `# 团队规范\n\n## 项目概览\n\n- 这是手写的内容，不能被改动。\n`;
    write(root, "AGENTS.md", original);

    const plan = planInit(root);
    const agents = plan.files.find((file) => file.relPath === "AGENTS.md")!;
    expect(agents.action).toBe("append");
    expect(agents.appendedSections).toContain("常用命令");
    expect(agents.keptSections).toContain("项目概览");

    applyInit(plan);
    const after = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(after).toContain("这是手写的内容，不能被改动。");
    // 同名小节保持一份（没有重复追加）
    expect(after.match(/## 项目概览/g)).toHaveLength(1);
    expect(after).toContain("## 常用命令");
    expect(after).toContain("`npm run test`");

    // 再次计划 → 没有可补的内容
    const second = planInit(root);
    expect(
      second.files.find((file) => file.relPath === "AGENTS.md")!.action,
    ).toBe("skip");
  });

  it("--force：整体覆盖并留下 .bak- 备份", () => {
    const root = tmpProject();
    makeNodeProject(root);
    write(root, "AGENTS.md", "# 旧规范\n\n手写内容\n");

    const plan = planInit(root, { force: true });
    const agents = plan.files.find((file) => file.relPath === "AGENTS.md")!;
    expect(agents.action).toBe("overwrite");

    const result = applyInit(plan);
    expect(result.backups).toHaveLength(1);
    expect(result.backups[0]).toContain("AGENTS.md.bak-");
    expect(fs.readFileSync(result.backups[0], "utf8")).toContain("旧规范");

    const after = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(after).toContain("# demo-app 开发规范");
    expect(after).not.toContain("旧规范");
  });

  it("Python 项目：识别 pytest / pip 命令，不生成空的命令手册", () => {
    const root = tmpProject();
    write(root, "pyproject.toml", "[project]\nname = \"demo\"\n");
    write(root, "requirements.txt", "pytest\n");
    write(root, "tests/test_app.py", "def test_x(): pass\n");

    const facts = scanProject(root);
    expect(facts.commands.map((command) => command.command)).toContain("pytest");
    expect(facts.commands.map((command) => command.command)).toContain(
      "pip install -r requirements.txt",
    );

    const plan = planInit(root);
    const agents = plan.files.find((file) => file.relPath === "AGENTS.md")!;
    expect(agents.content).toContain("`pytest`");
    expect(agents.content).toContain("`pip install -r requirements.txt`");
  });
});
