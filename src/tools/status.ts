import type { RunStatusKind, ToolDefinition, ToolResult } from "./types";

const KINDS: RunStatusKind[] = ["blocked", "needs_input", "low_confidence"];

const KIND_LABEL: Record<RunStatusKind, string> = {
  blocked: "受阻",
  needs_input: "等待用户决定",
  low_confidence: "置信度低",
};

/**
 * report_status —— 让模型**结构化**地表达「卡住了 / 需要你决定 / 没把握」。
 *
 * 为什么需要：在此之前只有 `goal_complete`（完成）与普通文字答复两种结局，
 * 模型遇到缺凭据、权限不足、需求歧义时只能三选一 —— 把受阻当成完成上报、
 * 反复重试直到安全阀、或者编一个看起来合理的结论。前两种浪费轮次，第三种最危险。
 *
 * 两种「会暂停」的状态（blocked / needs_input）直接影响循环：界面看到后暂停目标并
 * 把原因摆给用户；`low_confidence` 不打断，只记进状态块并在答复前标注。
 *
 * 防滥用：目标模式下一轮工具都没调就报 blocked/needs_input，多半是想逃避困难步骤 ——
 * 这里直接拒绝（`ok: false`），要求先实际尝试。`low_confidence` 不受此限制。
 */
export const reportStatusTool: ToolDefinition = {
  name: "report_status",
  description:
    "结构化上报当前状态，用于「卡住 / 必须由用户决定 / 把握不足」三类情形：" +
    "blocked=外部条件不满足（缺凭据、权限、网络、依赖），无法继续；" +
    "needs_input=必须由用户做出选择才能继续；" +
    "low_confidence=还能继续，但结论/判断没有把握。" +
    "blocked / needs_input 会让目标暂停并把原因显示给用户；low_confidence 不打断，只做标注。" +
    "**能用工具自己解决的事不要上报**；也不要用它逃避困难步骤（目标模式下，本轮一次工具都没调用就报前两类会被拒绝）。" +
    "如果目标只是「部分完成」，继续做；只有真的无法推进时才用它。",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: KINDS,
        description:
          "blocked=无法继续（外部条件）；needs_input=需要用户决定；low_confidence=能继续但没把握",
      },
      summary: {
        type: "string",
        description: "一句话说明：卡在哪 / 需要用户决定什么 / 哪部分没把握",
      },
      detail: {
        type: "string",
        description:
          "可选：已经尝试过什么、缺什么、建议用户怎么处理（needs_input 时请给出具体选项）",
      },
    },
    required: ["kind", "summary"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const kind = args.kind as RunStatusKind;
    if (!KINDS.includes(kind)) {
      return {
        ok: false,
        content: `错误：kind 必须是 ${KINDS.join(" / ")} 之一。`,
      };
    }

    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    if (!summary) {
      return { ok: false, content: "错误：summary 不能为空，请一句话说明卡点。" };
    }
    const detail =
      typeof args.detail === "string" && args.detail.trim()
        ? args.detail.trim()
        : undefined;

    if (!ctx.status) {
      return { ok: false, content: "错误：当前环境不支持状态上报。" };
    }

    // 防滥用：目标模式下「一次都没尝试就报受阻/需要决定」直接拒绝。
    // low_confidence 不拦：它不改变循环，只是标注。
    if (
      kind !== "low_confidence" &&
      ctx.status.goalActive() &&
      ctx.status.toolCalls() === 0
    ) {
      return {
        ok: false,
        content:
          "错误：本轮还没有执行任何工具调用。请先实际尝试（读文件、跑命令、查文档），" +
          "确认真的无法推进后再上报；如果是第一步就缺少必要信息，先用工具确认现状，" +
          "或把需要用户决定的事项写进最终答复。",
      };
    }

    ctx.status.report({ kind, summary, detail });

    if (kind === "low_confidence") {
      return {
        ok: true,
        content:
          "已记录「置信度低」。可以继续推进；请在最终答复里明确标注哪些结论没有把握、依据是什么。",
        summary: `置信度低：${summary}`,
      };
    }

    return {
      ok: true,
      content:
        `已记录「${KIND_LABEL[kind]}」：${summary}\n` +
        "目标将暂停并把这条信息显示给用户。请用一小段话说明现状（已尝试什么、缺什么、建议怎么做），然后结束本轮。",
      summary: `${KIND_LABEL[kind]}：${summary}`,
    };
  },
};
