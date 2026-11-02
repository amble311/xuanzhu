import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 文档一致性 —— 把「改了代码要同步文档」从纪律变成构建会红。
 *
 * 为什么需要：`AGENTS.md` 早就写着「修改项目代码后必须同步修改文档」，
 * 但没有任何机制检查，结果是 `docs/ARCHITECTURE.md` 的模块表停留在
 * 「待补充」、测试清单落后十几项。文档一旦静默过期，下一个人（或下一次
 * 会话里的模型）就会照着错的信息干活，而 `AGENTS.md` 又说「以源码为准」——
 * 等于鼓励所有人忽略文档。
 *
 * 这里只检查**可确定的事实**（目录、文件数、测试清单、链接），不检查文风。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 不参与「顶层目录表」校验的目录：构建产物 / 依赖 / 临时目录 / 参考资料 */
const IGNORED_TOP = new Set([
  ".git",
  ".codebuddy",
  ".xuanzhu",
  "node_modules",
  "dist",
  "tmp",
  "superagent",
]);

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** 取 `## <heading>` 到下一个 `## ` 之间的行 */
function section(file: string, heading: string): string[] {
  const lines = read(file).split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function actualTopDirs(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !IGNORED_TOP.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function actualTestFiles(): string[] {
  return readdirSync(join(ROOT, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

/** 解析 `## 模块概览` 的表格：目录 → 文件数 */
function documentedModules(): Map<string, number> {
  const modules = new Map<string, number>();
  for (const line of section("docs/ARCHITECTURE.md", "模块概览")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const name = cells[1]?.replace(/`/g, "").replace(/\/$/, "");
    const count = Number(cells[2]);
    if (name) modules.set(name, count);
  }
  return modules;
}

/** 解析 §10 测试表格里的文件名 */
function documentedTests(): string[] {
  const names: string[] = [];
  for (const line of section("docs/ARCHITECTURE.md", "10. 测试与本地开发")) {
    const match = /\|\s*`([^`]+\.test\.ts)`\s*\|/.exec(line);
    if (match) names.push(match[1]);
  }
  return names.sort();
}

/** 目录结构树里某个目录下直接列出的文件名 */
function treeEntries(directory: string): string[] {
  const lines = read("docs/ARCHITECTURE.md").split("\n");
  const start = lines.findIndex((line) => line.includes(`├── ${directory}/`));
  if (start < 0) return [];
  const names: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith("│")) break;
    const match = /^│\s+[├└]── (.+)$/.exec(line);
    // 目录带尾斜杠（`core/`），文件名不带，统一去掉再比较
    if (match) names.push(match[1].trim().replace(/\/$/, ""));
  }
  return names.sort();
}

/**
 * `docs/` 与 `AGENTS.md` 是**本地资产**（见 .gitignore）：公开仓库与 npm 包里都没有它们。
 * 因此这组用例在没有文档的检出里跳过 —— 否则克隆仓库的人会看到一堆与本项目无关的失败。
 */
const hasDocs = existsSync(join(ROOT, "docs/ARCHITECTURE.md"));

describe.skipIf(!hasDocs)("文档一致性", () => {
  it("模块表的目录与实际顶层目录一致，文件数也对得上", () => {
    const documented = documentedModules();
    expect([...documented.keys()].sort()).toEqual(actualTopDirs());

    const wrong = [...documented.entries()]
      .filter(([dir, count]) => countFiles(dir) !== count)
      .map(([dir, count]) => `${dir}: 文档 ${count} ≠ 实际 ${countFiles(dir)}`);
    expect(wrong).toEqual([]);
  });

  it("§10 的测试清单与 test/ 下的用例一一对应", () => {
    expect(documentedTests()).toEqual(actualTestFiles());
  });

  it("目录结构树里 test/ 的条目与实际文件一致", () => {
    expect(treeEntries("test")).toEqual(
      readdirSync(join(ROOT, "test")).sort(),
    );
  });

  it("目录结构树里 src/ 的子目录与实际一致", () => {
    const actual = readdirSync(join(ROOT, "src"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(treeEntries("src")).toEqual(actual);
  });

  it("文档里没有遗留的合并冲突标记", () => {
    const files = [
      "AGENTS.md",
      "README.md",
      "CHANGELOG.md",
      ...readdirSync(join(ROOT, "docs")).map((name) => `docs/${name}`),
    ];
    expect(files.filter((file) => /^(<{7}|={7}|>{7}) /m.test(read(file)))).toEqual(
      [],
    );
  });

  it("文档里的本地链接都能解析", () => {
    const files = [
      "AGENTS.md",
      "README.md",
      ...readdirSync(join(ROOT, "docs")).map((name) => `docs/${name}`),
    ];
    const missing: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1].split("#")[0];
        // 外链、锚点、mailto 不检查
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const resolved = resolve(dirname(join(ROOT, file)), target);
        if (!existsSync(resolved)) {
          missing.push(`${file} → ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("AGENTS.md 指向的文档都存在", () => {
    // AGENTS.md 用反引号写路径（不是 markdown 链接），单独校验
    const text = read("AGENTS.md");
    const referenced = [...text.matchAll(/`((?:docs|src|test)\/[^`\s]+)`/g)]
      // `src/utils/paths.ts::getConfigDir()` 这类写法只校验文件部分
      .map((match) => match[1].split("::")[0])
      .filter((path) => !path.includes("*") && !path.endsWith("/"));
    const missing = referenced.filter((path) => !existsSync(join(ROOT, path)));
    expect(missing).toEqual([]);
  });
});
