import type { ToolDefinition, ToolResult } from "./types";

/**
 * goal_complete —— 目标模式（`/goal`）里由模型**主动声明完成**的出口。
 *
 * 为什么需要这个工具而不是靠界面猜「模型是不是做完了」：
 * 界面（TUI）在每轮 `agent.run` 返回后必须判断「继续自动推进」还是「收尾」，
 * 而「模型给出了最终答复」不等于「目标完成」—— 它完全可能在中途总结一句就停下。
 * 让模型显式调用一次工具，完成判定就是确定性的状态位，而不是对文本的猜测。
 *
 * 工具本身不持有目标状态：目标挂在 Agent 上，经 `ToolContext.goal` 注入
 * （与 `todo_write` 同一套做法）。
 */
export const goalCompleteTool: ToolDefinition = {
  name: "goal_complete",
  description:
    "声明当前 /goal 目标已全部完成（**仅目标模式使用**）。" +
    "只有当你确认目标真正完成并通过验证（构建 / 测试 / 实际运行）时才调用；" +
    "目标确实无法完成（缺凭据、外部依赖不可用）时也调用它，并在 summary 里写明阻塞原因。" +
    "调用后目标模式结束，不会再自动继续。当前没有进行中的目标时不要调用。",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "完成情况总结：做了什么、如何验证的、还有哪些未做或阻塞（若有）。会展示给用户。",
      },
    },
    required: ["summary"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    if (!summary) {
      return { ok: false, content: "错误：summary 不能为空，请说明完成情况与验证方式。" };
    }
    if (!ctx.goal || !ctx.goal.active()) {
      return {
        ok: false,
        content:
          "当前没有进行中的目标（/goal），无需调用 goal_complete。直接给用户最终答复即可。",
      };
    }

    ctx.goal.complete(summary);
    return {
      ok: true,
      content:
        "已记录目标完成，目标模式结束。请用一段简短的最终总结回复用户，不要再开始新工作。",
      summary: "目标完成",
    };
  },
};
