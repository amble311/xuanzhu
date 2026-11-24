import {
  DEFAULT_SUBAGENT_NAME,
  findSubAgent,
  subAgentNames,
  SUBAGENTS,
} from "../subagents";
import type { ToolDefinition, ToolResult } from "./types";

/** 可用子代理清单，拼进工具描述，让主代理知道「有哪些、各自何时用」 */
const SUBAGENT_LIST = SUBAGENTS.map(
  (agent) => `- ${agent.name}: ${agent.description}`,
).join("\n");

/**
 * task —— 派生子代理执行子任务。
 *
 * 子代理是一个**独立的 Agent 实例**：有自己的对话历史与工具循环，
 * 只有最终结论会回到主对话。因此它主要解决两个问题：
 *   1. **上下文隔离** —— 调研类任务（翻几十个文件）产生的大量中间内容不会
 *      挤占主对话的上下文窗口；
 *   2. **任务分工** —— 主代理把可独立完成的子问题丢出去，拿到结论再继续。
 *
 * 具体能用哪些工具、拿什么系统提示词，由 `src/subagents` 的注册表决定，
 * 本文件只负责参数校验与转发。
 */
export const taskTool: ToolDefinition = {
  name: "task",
  description:
    "派生子代理独立完成子任务，只把结论带回（中间过程不进上下文）。\n" +
    "适用：需读 3 个以上文件、或反复 glob/grep 才能定位；互不依赖的调研可并列多个（并行）。\n" +
    "prompt 必须自包含：背景、目标、线索、期望输出、边界。\n" +
    `可用子代理：\n${SUBAGENT_LIST}`,
  // 每个子代理是独立的 Agent 实例，不共享可变状态，因此可以安全地并发执行
  parallelSafe: true,
  parameters: {
    type: "object",
    properties: {
      subagent_name: {
        type: "string",
        enum: subAgentNames(),
        description: `子代理名称，默认 ${DEFAULT_SUBAGENT_NAME}`,
      },
      description: {
        type: "string",
        description: "子任务的一句话说明（3-5 个词），用于界面显示",
      },
      prompt: {
        type: "string",
        description: "完整任务描述（子代理看不到当前对话）：背景、目标、已知线索、期望输出、边界",
      },
    },
    required: ["description", "prompt"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.spawnAgent) {
      return { ok: false, content: "错误：当前环境不支持派生子代理。" };
    }

    const description =
      typeof args.description === "string" ? args.description.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!description || !prompt) {
      return { ok: false, content: "错误：description 与 prompt 均不能为空。" };
    }

    const rawName =
      typeof args.subagent_name === "string" ? args.subagent_name.trim() : "";
    if (rawName && !findSubAgent(rawName)) {
      return {
        ok: false,
        content: `错误：未知子代理 "${rawName}"。可用：${subAgentNames().join("、")}`,
      };
    }

    try {
      return await ctx.spawnAgent({
        subagentName: rawName || undefined,
        description,
        prompt,
      });
    } catch (err) {
      return {
        ok: false,
        content: `子代理执行失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
