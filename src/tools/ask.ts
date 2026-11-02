import type { ToolDefinition, ToolResult } from "./types";

/**
 * `ask_user` —— 结构化地**问一个**具体问题。
 *
 * 为什么需要：在此之前模型想问「选 A 还是 B」只有两条路 ——
 * 把问题夹在一段总结里（用户很容易漏掉），或者自己替用户拍板。
 * 前者是体验问题，后者是正确性问题：遇到真正需要人决定的事（改哪个目录、
 * 用哪种方案、要不要覆盖已有文件），猜错的代价远高于问一句。
 *
 * 三条约束（都来自实测的失败模式）：
 * 1. **一次只问一个问题**：多个问题合在一起，用户往往只回答第一个；
 * 2. **能自己查清的事不要问**：问是同步阻塞的，问一次就停一轮；
 * 3. **给出选项**：用户按数字即可回答，不必打字；只有真的需要自由文本时才省略。
 */
export const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    "向用户提**一个**具体问题并等待回答（会暂停本轮直到用户回答或跳过）。" +
    "适用：必须由用户决定的选择（方案 A/B、覆盖还是新建、改哪个目录）、" +
    "缺少只有用户才知道的信息（路径、账号、业务口径）。" +
    "**不要**用它确认自己能用工具查清的事，也不要把多个问题塞进一次调用。" +
    "能给出 2–4 个候选答案时务必给出 options —— 用户可以用数字键直接选。",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "一句话问题，必须能独立看懂（不要写「上面那个」「刚才说的」）",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "2–4 个候选答案（可选）。给出时界面用单选浮层，用户按数字即可回答",
      },
      detail: {
        type: "string",
        description:
          "可选：已尝试什么、为什么必须由用户决定、各选项的差别（多行可接受）",
      },
    },
    required: ["question"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const question =
      typeof args.question === "string" ? args.question.trim() : "";
    if (!question) {
      return { ok: false, content: "错误：question 不能为空。" };
    }
    if (!ctx.askUser) {
      return {
        ok: false,
        content:
          "错误：当前环境不支持向用户提问（非交互场景）。" +
          "请自行选择最保守的方案并在结论里说明取舍。",
      };
    }

    let options: string[] | undefined;
    if (Array.isArray(args.options) && args.options.length > 0) {
      const cleaned = args.options
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (cleaned.length > 0 && cleaned.length < 2) {
        return {
          ok: false,
          content: "错误：options 至少要有 2 个选项；只有一个候选时请直接执行。",
        };
      }
      if (cleaned.length > 6) {
        return {
          ok: false,
          content: "错误：options 最多 4 个（超过会被截断），请合并相近的选项。",
        };
      }
      options = cleaned.slice(0, 4);
    }

    const detail =
      typeof args.detail === "string" && args.detail.trim()
        ? args.detail.trim()
        : undefined;

    const answer = await ctx.askUser({ question, options, detail });
    if (answer.cancelled || !answer.answer?.trim()) {
      return {
        ok: false,
        content:
          "用户跳过了这个问题（Esc）。不要重复提问：按最保守的方案继续，" +
          "并在最终答复里说明「这一点未得到用户确认」。",
        summary: "用户跳过",
      };
    }
    return {
      ok: true,
      content: `用户回答：${answer.answer.trim()}\n请按这个回答继续，不要再问同一个问题。`,
      summary: `已确认：${answer.answer.trim().slice(0, 40)}`,
    };
  },
};
