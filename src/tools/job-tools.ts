import { describeJob, readFileTail } from "./jobs";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

/**
 * `bash_output` / `bash_kill` —— 后台任务的查看与终止。
 *
 * 刻意**不提供等待**（没有 `wait_seconds`）：任务结束会自动把结果推进对话，
 * 模型一旦能「等」，就会用等待代替继续工作，把整轮卡在一个命令上 ——
 * 而这正是后台任务要解决的问题。
 */

function listJobs(ctx: ToolContext): string {
  const jobs = ctx.jobs?.list() ?? [];
  if (jobs.length === 0) {
    return "当前没有后台任务。用 bash 的 run_in_background=true 启动一个。";
  }
  return (
    `后台任务（共 ${jobs.length} 个）：\n` +
    jobs.map((job) => `- ${describeJob(job)}`).join("\n")
  );
}

export const bashOutputTool: ToolDefinition = {
  name: "bash_output",
  description:
    "查看后台任务的输出。不传 job_id 时列出全部后台任务；" +
    "传 job_id 时返回该任务的状态与**最近**一段输出（默认末尾 4000 字符）。" +
    "正在运行的任务只保证「到目前为止」的输出，完整结果会在它结束时自动推送给你。",
  parameters: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "后台任务 id（如 job-1）；省略则列出全部",
      },
      max_chars: {
        type: "integer",
        description: "最多返回多少字符（默认 4000，最大 20000）",
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.jobs) {
      return { ok: false, content: "错误：当前环境没有后台任务。" };
    }
    const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
    if (!jobId) {
      return { ok: true, content: listJobs(ctx), summary: "列出后台任务" };
    }

    const rawMax =
      typeof args.max_chars === "number" ? args.max_chars : undefined;
    const maxChars = Math.min(Math.max(200, rawMax ?? 4000), 20_000);
    const read = ctx.jobs.read(jobId, maxChars);
    if (!read) {
      return {
        ok: false,
        content: `错误：未知的后台任务 "${jobId}"。\n${listJobs(ctx)}`,
      };
    }

    const { job, text, truncated } = read;
    // 模型已经直接读到结论了：标记为已投递，避免下一轮再补一遍
    if (job.status === "done") ctx.jobs.markDelivered(job.id);
    const head = describeJob(job);
    const notes: string[] = [];
    if (job.status === "running") {
      notes.push(
        "仍在运行：下面是截至目前的输出，完整结果会在结束时自动推送（不要轮询）。",
      );
    }
    if (job.error) notes.push(`启动/终止异常：${job.error}`);
    if (truncated) {
      notes.push(
        `只显示末尾 ${maxChars} 字符；完整输出见 ${job.logFile}（可用 read_file 或 grep 回查）。`,
      );
    }
    const body = text.trim() ? text.trimEnd() : "（还没有输出）";
    return {
      ok: true,
      content: `${head}\n${notes.length > 0 ? `${notes.join("\n")}\n` : ""}\n${body}`,
      summary: `${job.id} ${job.status === "running" ? "运行中" : "已结束"}`,
    };
  },
};

export const bashKillTool: ToolDefinition = {
  name: "bash_kill",
  description:
    "终止一个后台任务（连同它派生的子进程）。任务若已结束会明确告知；" +
    "终止后的输出仍可用 bash_output 查看。",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "要终止的后台任务 id，如 job-2" },
    },
    required: ["job_id"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.jobs) {
      return { ok: false, content: "错误：当前环境没有后台任务。" };
    }
    const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
    if (!jobId) return { ok: false, content: "错误：job_id 不能为空。" };
    const result = ctx.jobs.kill(jobId);
    return {
      ok: result.ok,
      content: result.ok
        ? `${result.message}\n终止前最后的输出可用 bash_output job_id=${jobId} 查看。`
        : `错误：${result.message}`,
      summary: result.ok ? `终止 ${jobId}` : "终止失败",
    };
  },
};

/**
 * 后台任务结束时注入对话的说明（由 Agent 在轮次之间推送）。
 *
 * 为什么用 `user` 角色：各协议的 tool 消息必须对应一次 tool_call，
 * 而这里没有；user 消息既能承载内容，又不破坏角色序列。
 */
export function jobCompletionMessage(
  job: {
    id: string;
    command: string;
    code: number | null;
    signal?: string | null;
    killed?: boolean;
    logFile: string;
    error?: string;
    /** 跨进程投递时日志可能已被清掉，用落盘时保存的末尾输出兜底 */
    outputTail?: string;
  },
  maxChars = 2500,
): string {
  const { text, truncated } = readFileTail(job.logFile, maxChars);
  const status = job.killed
    ? job.error
      ? `已被终止（${job.error}）`
      : "已被终止"
    : job.code === 0
      ? "已结束，退出码 0"
      : `已结束，退出码 ${job.code ?? job.signal ?? "未知"}`;
  const tail = text.trim()
    ? text.trimEnd()
    : job.outputTail?.trim()
      ? job.outputTail.trimEnd()
      : "（没有输出）";
  return (
    `[后台任务完成] ${job.id}（\`${job.command}\`）${status}。\n` +
    `最近输出${truncated ? `（只含末尾 ${maxChars} 字符，完整输出见 ${job.logFile}）` : ""}：\n` +
    `${tail}\n\n` +
    `请据此继续或收尾；需要完整输出用 bash_output job_id=${job.id}。`
  );
}
