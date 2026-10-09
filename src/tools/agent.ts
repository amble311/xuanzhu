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
    "派生一个**子代理**去独立完成一件子任务，只把最终结论返回给你（中间过程不进你的上下文）。\n\n" +
    "**什么时候该用它**（满足任一条就该用，不要因为「自己做更省事」而略过）：\n" +
    "· 一件子任务预计要读 **3 个以上文件**；\n" +
    "· 需要在多个目录 / 多种命名约定之间**反复 glob / grep** 才能定位；\n" +
    "· 有多件**互不依赖**的调研任务（此时在**同一条回复里并列发出多个 task 调用**，" +
    "它们会**并行执行**，总耗时取决于最慢的一路；并发上限见配置 maxParallelAgents）。\n" +
    "这类任务的中间过程会吃掉大量上下文，交给子代理只带回结论明显更划算。\n" +
    "反之，一两个文件就能解决的事直接自己做更快。\n\n" +
    "**prompt 必须自包含**（子代理看不到我们的对话历史）：" +
    "背景、目标、已知线索、期望的输出格式与边界（哪些事不要做）。\n\n" +
    `可用子代理：\n${SUBAGENT_LIST}\n\n` +
    "子代理不会写入项目记忆 —— 记忆由你根据它的结论统一记录。",
  // 每个子代理是独立的 Agent 实例，不共享可变状态，因此可以安全地并发执行
  parallelSafe: true,
  parameters: {
    type: "object",
    properties: {
      subagent_name: {
        type: "string",
        enum: subAgentNames(),
        description: `要派生的子代理名称，默认 ${DEFAULT_SUBAGENT_NAME}。`,
      },
      description: {
        type: "string",
        description: "子任务的一句话说明（3-5 个词），用于界面显示与结果摘要",
      },
      prompt: {
        type: "string",
        description:
          "交给子代理的完整任务描述。子代理看不到当前对话，必须自包含：" +
          "背景、目标、已知线索、要产出的结论与格式、不要做什么。",
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
