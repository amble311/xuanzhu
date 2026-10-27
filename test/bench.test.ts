import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createBenchRepo, mathSource } from "../src/bench/fixture";
import { BENCH_TASKS } from "../src/bench/tasks";
import {
  formatBenchSummary,
  formatBenchTable,
  formatBenchTaskSummary,
  runBenchCase,
  summarizeBench,
  summarizeBenchByTask,
} from "../src/bench/runner";

/**
 * 第四期：基准仓库、验收器与 mock 跑通。
 */

describe("bench 仓库与验收", () => {
  it("生成目标文件、测试与大量无关模块", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-bench-test-"));
    createBenchRepo(root, { modules: 10 });
    expect(fs.existsSync(path.join(root, "src/math.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "test.mjs"))).toBe(true);
    expect(
      fs.readdirSync(path.join(root, "src/modules")).length,
    ).toBe(10);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fix-add 初始失败，修好后通过", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-bench-test-"));
    createBenchRepo(root, { modules: 3 });
    const task = BENCH_TASKS.find((item) => item.id === "fix-add")!;
    expect(task.verify(root, "").ok).toBe(false);

    fs.writeFileSync(path.join(root, "src/math.mjs"), mathSource(false, true));
    expect(task.verify(root, "").ok).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("add-multiply 验收函数行为", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-bench-test-"));
    createBenchRepo(root, { modules: 3 });
    const task = BENCH_TASKS.find((item) => item.id === "add-multiply")!;
    expect(task.verify(root, "").ok).toBe(false);

    fs.writeFileSync(path.join(root, "src/math.mjs"), mathSource(true, true));
    expect(task.verify(root, "").ok).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("bench 运行器（mock）", () => {
  it("mock 能完成 fix-add 并记录调用 / 工具 / 耗时", async () => {
    const task = BENCH_TASKS.find((item) => item.id === "fix-add")!;
    const result = await runBenchCase({
      task,
      contextWindow: 8192,
      profile: "small",
      provider: "mock",
      model: "mock",
      modules: 10,
      timeoutMs: 20_000,
    });
    expect(result.success).toBe(true);
    expect(result.calls).toBeGreaterThan(0);
    expect(result.toolCalls).toBeGreaterThanOrEqual(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("表格包含每个维度", async () => {
    const task = BENCH_TASKS.find((item) => item.id === "find-add")!;
    const result = await runBenchCase({
      task,
      contextWindow: 16384,
      profile: "small",
      provider: "mock",
      model: "mock",
      modules: 5,
      timeoutMs: 20_000,
    });
    const table = formatBenchTable([result]);
    expect(table).toContain("window");
    expect(table).toContain("find-add");
    expect(table).toContain("✓");

    const summary = summarizeBench([result]);
    expect(summary).toHaveLength(1);
    expect(summary[0].successRate).toBe(100);
    expect(formatBenchSummary(summary)).toContain("success%");

    const byTask = summarizeBenchByTask([result]);
    expect(byTask).toHaveLength(1);
    expect(byTask[0].task).toBe("find-add");
    expect(byTask[0].successRate).toBe(100);
    expect(formatBenchTaskSummary(byTask)).toContain("task");
  });
});
