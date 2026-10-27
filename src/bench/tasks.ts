import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { MATH_PATH, mathSource, TEST_PATH } from "./fixture";

export type BenchTaskId = "fix-add" | "add-multiply" | "find-add";

export interface BenchVerifyResult {
  ok: boolean;
  detail: string;
}

export interface BenchTask {
  id: BenchTaskId;
  prompt: string;
  /** 任务完成后的确定性验收（不依赖模型自述） */
  verify(cwd: string, answer: string): BenchVerifyResult;
}

function runNode(cwd: string, args: string[]): BenchVerifyResult {
  try {
    const out = execFileSync("node", args, {
      cwd,
      timeout: 15_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, detail: out.trim().slice(0, 300) };
  } catch (err) {
    const error = err as { stderr?: string; message?: string };
    return {
      ok: false,
      detail: (error.stderr || error.message || String(err)).trim().slice(0, 300),
    };
  }
}

const verifyFixAdd = (cwd: string): BenchVerifyResult =>
  runNode(cwd, [TEST_PATH]);

const verifyAddMultiply = (cwd: string): BenchVerifyResult => {
  let source = "";
  try {
    source = fs.readFileSync(path.join(cwd, MATH_PATH), "utf8");
  } catch {
    return { ok: false, detail: `${MATH_PATH} 不存在` };
  }
  if (!/export\s+function\s+multiply\s*\(/.test(source)) {
    return { ok: false, detail: "没有找到 export function multiply" };
  }
  return runNode(cwd, [
    "-e",
    "import('./src/math.mjs').then(m => process.exit(m.multiply(3, 4) === 12 ? 0 : 1)).catch(() => process.exit(1))",
  ]);
};

export const BENCH_TASKS: BenchTask[] = [
  {
    id: "fix-add",
    prompt:
      "这个仓库的 src/math.mjs 里 add 函数有 bug：它返回 a-b，应该是 a+b。" +
      "请修复它，并运行 `node test.mjs` 确认通过。完成后用一句话总结。",
    verify(cwd) {
      return verifyFixAdd(cwd);
    },
  },
  {
    id: "add-multiply",
    prompt:
      "在 src/math.mjs 中新增 export function multiply(a, b)，返回 a*b；" +
      "不要改动 add / subtract 的现有行为。完成后用一句话总结。",
    verify(cwd) {
      return verifyAddMultiply(cwd);
    },
  },
  {
    id: "find-add",
    prompt:
      "不要修改文件：找出 add 函数定义在哪个文件，并指出它的返回值是否正确。" +
      "用一句话回答，包含文件路径。",
    verify(_cwd, answer) {
      const ok =
        /src\/math\.mjs/.test(answer) &&
        /add/.test(answer) &&
        /(返回|a\s*-\s*b|错误|不正确|bug)/i.test(answer);
      return {
        ok,
        detail: ok ? "答案包含文件与问题判断" : "答案缺少路径或问题判断",
      };
    },
  },
];

export function findBenchTask(id: string): BenchTask | undefined {
  return BENCH_TASKS.find((task) => task.id === id);
}

/** 供 mock provider 使用：修好 add 且可选加 multiply 的完整文件内容 */
export function expectedMathSource(withMultiply: boolean): string {
  return mathSource(withMultiply, true);
}
