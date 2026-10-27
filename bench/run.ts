import * as fs from "fs";
import { BENCH_TASKS, findBenchTask } from "../src/bench/tasks";
import {
  formatBenchSummary,
  formatBenchTable,
  formatBenchTaskSummary,
  runBenchCase,
  summarizeBench,
  summarizeBenchByTask,
  type BenchMetrics,
} from "../src/bench/runner";

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function csv(name: string, fallback: string[]): string[] {
  return argValue(name, fallback.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`用法：npm run bench -- [选项]

  --mock                 使用脚本化 mock（快速验证基准回路，不调用模型）
  --endpoint=<url>       OpenAI 兼容端点（默认 http://127.0.0.1:8181/v1）
  --model=<name>         模型名（默认 local）
  --windows=8192,16384   上下文窗口列表
  --profiles=small,full  档位列表
  --tasks=fix-add,add-multiply,find-add
  --runs=1               每个组合重复次数
  --modules=300          合成仓库的无关模块数量
  --timeout=180000       单次任务超时（毫秒）

输出：控制台表格 + /tmp/xzh-bench-results.json`);
    return;
  }

  const mock = process.argv.includes("--mock");
  const endpoint = argValue("endpoint", "http://127.0.0.1:8181/v1");
  const model = argValue("model", "local");
  const windows = csv("windows", ["8192", "16384"]).map((value) => Number(value));
  const profiles = csv("profiles", ["small"]).filter(
    (value): value is "small" | "full" => value === "small" || value === "full",
  );
  const taskIds = csv(
    "tasks",
    BENCH_TASKS.map((task) => task.id),
  );
  const runs = Math.max(1, Number(argValue("runs", "1")) || 1);
  const modules = Math.max(0, Number(argValue("modules", "300")) || 300);
  const timeoutMs = Math.max(5_000, Number(argValue("timeout", "180000")) || 180_000);

  const tasks = taskIds.map((id) => {
    const task = findBenchTask(id);
    if (!task) throw new Error(`未知任务：${id}`);
    return task;
  });

  const results: BenchMetrics[] = [];
  for (const window of windows) {
    for (const profile of profiles) {
      for (const task of tasks) {
        for (let run = 1; run <= runs; run++) {
          process.stderr.write(
            `[bench] window=${window} profile=${profile} task=${task.id} run=${run}/${runs}\n`,
          );
          const result = await runBenchCase({
            task,
            contextWindow: window,
            profile,
            provider: mock ? "mock" : "openai",
            endpoint,
            model,
            timeoutMs,
            modules,
          });
          results.push(result);
          process.stderr.write(
            `[bench] → ${result.success ? "ok" : "fail"} calls=${result.calls} ` +
              `tools=${result.toolCalls} ${result.durationMs}ms\n`,
          );
        }
      }
    }
  }

  console.log("");
  console.log("按窗口 / 档位汇总：");
  console.log(formatBenchSummary(summarizeBench(results)));
  console.log("\n按任务类型汇总：");
  console.log(formatBenchTaskSummary(summarizeBenchByTask(results)));
  console.log("\n逐项结果：");
  console.log(formatBenchTable(results));
  const output = "/tmp/xzh-bench-results.json";
  fs.writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`\nJSON: ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
