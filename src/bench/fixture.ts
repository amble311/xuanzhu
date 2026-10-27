import * as fs from "fs";
import * as path from "path";

/**
 * 第四期基准用的合成大仓库。
 *
 * 目的不是模拟真实业务，而是稳定地制造「文件多、符号多、目标很小」的场景：
 * 小上下文模型如果直接整文件扫描 / 逐文件读，会迅速耗尽窗口；有 repo_map /
 * find_symbol / read_symbol 时应当能定位到 `src/math.mjs` 并完成修改。
 */

export interface BenchRepoOptions {
  /** 额外生成的模块文件数（默认 120，足以让目录扫描有压力） */
  modules?: number;
}

export const MATH_PATH = "src/math.mjs";
export const TEST_PATH = "test.mjs";

/** 目标文件内容；withMultiply=true 用于「新增函数」任务的期望结果 */
export function mathSource(withMultiply = false, fixed = false): string {
  return [
    "export function subtract(a, b) {",
    "  return a - b;",
    "}",
    "",
    "export function add(a, b) {",
    fixed ? "  return a + b;" : "  return a - b;",
    "}",
    "",
    ...(withMultiply
      ? [
          "export function multiply(a, b) {",
          "  return a * b;",
          "}",
          "",
        ]
      : []),
  ].join("\n");
}

export function createBenchRepo(root: string, options: BenchRepoOptions = {}): void {
  const modules = Math.max(0, options.modules ?? 120);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, MATH_PATH), mathSource(false), "utf8");
  fs.writeFileSync(
    path.join(root, TEST_PATH),
    [
      'import { add } from "./src/math.mjs";',
      "",
      "if (add(2, 3) !== 5) {",
      '  console.error("FAIL: add(2,3) != 5");',
      "  process.exit(1);",
      "}",
      'console.log("OK");',
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      { name: "xzh-bench-repo", private: true, type: "module", scripts: { test: "node test.mjs" } },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Bench Repo\n\n合成基准仓库，目标是修复 `src/math.mjs` 的 add。\n",
    "utf8",
  );

  for (let i = 0; i < modules; i++) {
    const dir = path.join(root, "src", "modules");
    fs.mkdirSync(dir, { recursive: true });
    const name = `mod-${String(i).padStart(3, "0")}.mjs`;
    fs.writeFileSync(
      path.join(dir, name),
      [
        `// module ${i}（与任务无关，用于制造仓库规模）`,
        `export function helper${i}(value) {`,
        `  return value + ${i};`,
        "}",
        "",
        `export function transform${i}(input) {`,
        `  return helper${i}(input) * 2;`,
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}
