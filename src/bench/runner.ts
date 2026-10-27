import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, type AgentEvents } from "../core/agent";
import {
  DEFAULT_CONFIG,
  type ModelEntry,
  type XuanZhuConfig,
} from "../config/store";
import { OpenAICompatProvider } from "../llm/openai-compat";
import { estimateMessageTokens, estimateTokens } from "../llm";
import type { ChatOptions, LLMProvider, StreamChunk } from "../llm/types";
import { createBenchRepo, MATH_PATH, mathSource } from "./fixture";
import {
  expectedMathSource,
  type BenchTask,
  type BenchTaskId,
} from "./tasks";

export interface BenchRunOptions {
  task: BenchTask;
  contextWindow: number;
  profile: "small" | "full";
  /** 默认 mock；真实端点用 openai */
  provider: "mock" | "openai";
  endpoint?: string;
  model: string;
  timeoutMs?: number;
  modules?: number;
}

export interface BenchMetrics {
  task: BenchTaskId;
  window: number;
  profile: "small" | "full";
  success: boolean;
  detail: string;
  /** 模型请求次数 */
  calls: number;
  /** 真实执行的工具调用次数 */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** true = 端点没有返回 usage，token 数为本地估算 */
  tokensEstimated: boolean;
  durationMs: number;
  answerChars: number;
  error?: string;
}

const toolCall = (name: string, args: Record<string, unknown>): StreamChunk[] => [
  {
    type: "tool_call",
    toolCall: { id: `bench-${name}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) },
  },
  { type: "done", finishReason: "tool_calls" },
];

const textReply = (text: string): StreamChunk[] => [
  { type: "text", text },
  { type: "done", finishReason: "stop" },
];

/** 脚本化 mock：验证基准回路本身，不依赖真实模型 */
function createMockProvider(taskId: BenchTaskId): LLMProvider {
  let call = 0;
  return {
    id: "mock",
    model: "mock",
    async *chat(): AsyncGenerator<StreamChunk> {
      call += 1;
      if (taskId === "find-add") {
        for (const chunk of textReply(
          "add 定义在 src/math.mjs，返回 a-b 是错误的，应改为 a+b。",
        )) {
          yield chunk;
        }
        return;
      }
      if (call === 1) {
        for (const chunk of toolCall("read_file", { path: MATH_PATH })) {
          yield chunk;
        }
        return;
      }
      if (call === 2) {
        const content =
          taskId === "add-multiply"
            ? expectedMathSource(true)
            : expectedMathSource(false);
        for (const chunk of toolCall("write_file", { path: MATH_PATH, content })) {
          yield chunk;
        }
        return;
      }
      for (const chunk of textReply(
        taskId === "add-multiply"
          ? "已新增 multiply(a,b)，返回 a*b。"
          : "已修复 add，返回 a+b，测试通过。",
      )) {
        yield chunk;
      }
    },
  };
}

function countingProvider(
  base: LLMProvider,
  stats: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
  },
): LLMProvider {
  return {
    id: base.id,
    model: base.model,
    async *chat(options: ChatOptions): AsyncGenerator<StreamChunk> {
      stats.calls += 1;
      // 本地 llama.cpp 的流式响应通常不带 usage：先用估算兜底，
      // 有真实 usage 时再用真实值（估算只用于比较趋势，不当作精确计费）。
      const estimatedInput =
        options.messages.reduce(
          (sum, message) => sum + estimateMessageTokens(message),
          0,
        ) + estimateTokens(JSON.stringify(options.tools ?? []));
      let estimatedOutput = 0;
      let sawUsage = false;
      for await (const chunk of base.chat(options)) {
        if (chunk.type === "text" || chunk.type === "reasoning") {
          estimatedOutput += estimateTokens(chunk.text);
        } else if (chunk.type === "tool_call") {
          estimatedOutput += estimateTokens(
            `${chunk.toolCall.name} ${chunk.toolCall.arguments}`,
          );
        } else if (chunk.type === "done" && chunk.usage) {
          sawUsage = true;
          stats.inputTokens += chunk.usage.inputTokens ?? 0;
          stats.outputTokens += chunk.usage.outputTokens ?? 0;
        }
        yield chunk;
      }
      if (!sawUsage) {
        stats.estimated = true;
        stats.inputTokens += estimatedInput;
        stats.outputTokens += estimatedOutput;
      }
    },
  };
}

export async function runBenchCase(options: BenchRunOptions): Promise<BenchMetrics> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-bench-repo-"));
  const modules = options.modules ?? 120;
  createBenchRepo(root, { modules });

  const stats = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: false,
  };
  const base =
    options.provider === "mock"
      ? createMockProvider(options.task.id)
      : new OpenAICompatProvider({
          id: "custom",
          apiKey: "not-needed",
          baseUrl: options.endpoint ?? "http://127.0.0.1:8181/v1",
          model: options.model,
        });
  const provider = countingProvider(base, stats);

  const modelEntry: ModelEntry = {
    id: `custom/${options.model}`,
    provider: "custom",
    model: options.model,
    baseUrl: options.endpoint,
    contextWindow: options.contextWindow,
    vision: false,
  };
  const config: XuanZhuConfig = {
    ...DEFAULT_CONFIG,
    provider: "custom",
    model: options.model,
    models: [modelEntry],
    providers: {
      custom: {
        model: options.model,
        ...(options.endpoint ? { baseUrl: options.endpoint } : {}),
      },
    },
    contextProfile: options.profile,
    maxToolRounds: 40,
    autoApprove: true,
    maxOutputTokens: options.profile === "small" ? 2048 : undefined,
    temperature: 0.2,
  };

  let answer = "";
  let toolCalls = 0;
  const notices: string[] = [];
  const events: AgentEvents = {
    onText: (delta) => {
      answer += delta;
    },
    onToolStart: () => {
      toolCalls += 1;
    },
    onToolEnd: () => undefined,
    onStatus: () => undefined,
    onNotice: (message) => notices.push(message),
    confirm: async () => true,
    onRoundLimit: async () => false,
  };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? (options.provider === "mock" ? 30_000 : 180_000),
  );
  const started = Date.now();
  let error: string | undefined;
  let verification = { ok: false, detail: "未执行" };
  try {
    const agent = new Agent(provider, config, root, events, modelEntry);
    await agent.run(options.task.prompt, controller.signal);
    verification = options.task.verify(root, answer);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    verification = { ok: false, detail: error };
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - started;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // 清理失败不影响指标
  }

  return {
    task: options.task.id,
    window: options.contextWindow,
    profile: options.profile,
    success: verification.ok,
    detail: verification.detail,
    calls: stats.calls,
    toolCalls,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    tokensEstimated: stats.estimated,
    durationMs,
    answerChars: answer.length,
    ...(error ? { error } : {}),
  };
}

export interface BenchSummary {
  window: number;
  profile: "small" | "full";
  runs: number;
  successRate: number;
  avgCalls: number;
  avgToolCalls: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgDurationMs: number;
}

/** 按 window + profile 汇总成功率与平均开销 */
export function summarizeBench(results: BenchMetrics[]): BenchSummary[] {
  const groups = new Map<string, BenchMetrics[]>();
  for (const result of results) {
    const key = `${result.window}:${result.profile}`;
    const list = groups.get(key) ?? [];
    list.push(result);
    groups.set(key, list);
  }
  const avg = (values: number[]): number =>
    values.length === 0
      ? 0
      : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, list]) => ({
      window: list[0].window,
      profile: list[0].profile,
      runs: list.length,
      successRate:
        Math.round(
          (list.filter((result) => result.success).length / list.length) * 1000,
        ) / 10,
      avgCalls: avg(list.map((result) => result.calls)),
      avgToolCalls: avg(list.map((result) => result.toolCalls)),
      avgInputTokens: avg(list.map((result) => result.inputTokens)),
      avgOutputTokens: avg(list.map((result) => result.outputTokens)),
      avgDurationMs: avg(list.map((result) => result.durationMs)),
    }));
}

export interface BenchTaskSummary {
  task: BenchTaskId;
  runs: number;
  successRate: number;
  avgCalls: number;
  avgToolCalls: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgDurationMs: number;
}

/** 按任务类型汇总（跨窗口 / 档位），看哪类任务最费轮次或最容易失败 */
export function summarizeBenchByTask(results: BenchMetrics[]): BenchTaskSummary[] {
  const groups = new Map<BenchTaskId, BenchMetrics[]>();
  for (const result of results) {
    const list = groups.get(result.task) ?? [];
    list.push(result);
    groups.set(result.task, list);
  }
  const avg = (values: number[]): number =>
    values.length === 0
      ? 0
      : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([task, list]) => ({
      task,
      runs: list.length,
      successRate:
        Math.round(
          (list.filter((result) => result.success).length / list.length) * 1000,
        ) / 10,
      avgCalls: avg(list.map((result) => result.calls)),
      avgToolCalls: avg(list.map((result) => result.toolCalls)),
      avgInputTokens: avg(list.map((result) => result.inputTokens)),
      avgOutputTokens: avg(list.map((result) => result.outputTokens)),
      avgDurationMs: avg(list.map((result) => result.durationMs)),
    }));
}

export function formatBenchTaskSummary(summary: BenchTaskSummary[]): string {
  const header = [
    "task",
    "runs",
    "success%",
    "avg_calls",
    "avg_tools",
    "avg_in_tok",
    "avg_out_tok",
    "avg_ms",
  ];
  const rows = summary.map((item) => [
    item.task,
    String(item.runs),
    item.successRate.toFixed(1),
    String(item.avgCalls),
    String(item.avgToolCalls),
    String(item.avgInputTokens),
    String(item.avgOutputTokens),
    String(item.avgDurationMs),
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => row[i].length)),
  );
  const render = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [render(header), ...rows.map(render)].join("\n");
}

export function formatBenchSummary(summary: BenchSummary[]): string {
  const header = [
    "window",
    "profile",
    "runs",
    "success%",
    "avg_calls",
    "avg_tools",
    "avg_in_tok",
    "avg_out_tok",
    "avg_ms",
  ];
  const rows = summary.map((item) => [
    String(item.window),
    item.profile,
    String(item.runs),
    item.successRate.toFixed(1),
    String(item.avgCalls),
    String(item.avgToolCalls),
    String(item.avgInputTokens),
    String(item.avgOutputTokens),
    String(item.avgDurationMs),
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => row[i].length)),
  );
  const render = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [render(header), ...rows.map(render)].join("\n");
}

export function formatBenchTable(results: BenchMetrics[]): string {
  const header = [
    "window",
    "profile",
    "task",
    "ok",
    "calls",
    "tools",
    "in_tok",
    "out_tok",
    "ms",
  ];
  const rows = results.map((result) => [
    String(result.window),
    result.profile,
    result.task,
    result.success ? "✓" : "✗",
    String(result.calls),
    String(result.toolCalls),
    String(result.inputTokens),
    String(result.outputTokens),
    String(result.durationMs),
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => row[i].length)),
  );
  const render = (row: string[]): string =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [render(header), ...rows.map(render)].join("\n");
}
