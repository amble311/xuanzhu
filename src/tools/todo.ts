import type { TodoItem, TodoStatus, ToolDefinition, ToolResult } from "./types";

const STATUS_VALUES: TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
};

/** 校验并规范化模型传入的任务列表；返回字符串表示校验失败 */
export function normalizeTodos(raw: unknown): TodoItem[] | string {
  if (!Array.isArray(raw)) return "错误：todos 必须是数组。";

  const items: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `错误：todos[${i}] 必须是对象（{content, status}）。`;
    }
    const { content, status } = entry as Record<string, unknown>;
    if (typeof content !== "string" || !content.trim()) {
      return `错误：todos[${i}].content 不能为空。`;
    }
    // status 非法时按 pending 处理，而不是报错 —— 模型偶尔会漏写或写成中文，
    // 因此这里只做「尽量纠正」，避免一次小失误让整个任务列表提交失败。
    const normalized = STATUS_VALUES.includes(status as TodoStatus)
      ? (status as TodoStatus)
      : "pending";
    items.push({ content: content.trim(), status: normalized });
  }

  const running = items.filter((item) => item.status === "in_progress");
  if (running.length > 1) {
    return "错误：同一时间只能有一个 in_progress 的任务，请把其余任务标为 pending。";
  }
  return items;
}

/** 把任务列表渲染成便于模型与用户阅读的清单 */
export function renderTodos(items: TodoItem[]): string {
  if (items.length === 0) return "（任务列表为空）";
  return items
    .map((item) => `${STATUS_MARK[item.status]} ${item.content}`)
    .join("\n");
}

/** 统计完成情况，用于摘要 */
function summarize(items: TodoItem[]): string {
  const done = items.filter((item) => item.status === "completed").length;
  const running = items.find((item) => item.status === "in_progress");
  const total = items.filter((item) => item.status !== "cancelled").length;
  return running
    ? `任务 ${done}/${total} · 进行中：${running.content}`
    : `任务 ${done}/${total}`;
}

/**
 * todo_write —— 维护当前会话的任务列表。
 *
 * 采用「每次提交全量列表」的语义（与 Claude Code 的 TodoWrite 一致）：
 * 模型必须回传完整清单，而不是增量修改。这样列表状态始终自洽，
 * 也避免了「删哪一项、改哪一项」带来的歧义。
 */
export const todoWriteTool: ToolDefinition = {
  name: "todo_write",
  description:
    "创建或更新当前会话的任务列表（todo list），用于把复杂任务拆成可跟踪的步骤。" +
    "**当任务需要 3 步以上、或用户给出多项要求时，应先调用它列出计划**，" +
    "并在每完成一步后更新列表（把该项标为 completed、把下一项标为 in_progress）。" +
    "每次提交**完整列表**（覆盖旧列表），而不是增量。同一时间只能有一项 in_progress。" +
    "简单的一两步任务（读一个文件、改一行）不必使用。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "完整的任务列表（全量覆盖），按执行顺序排列",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "任务内容，一句话，动词开头（如「修改 agent.ts 的 runTool」）",
            },
            status: {
              type: "string",
              enum: STATUS_VALUES,
              description:
                "pending=待办；in_progress=进行中（同时只能有一个）；completed=已完成；cancelled=已取消",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ctx.todos) {
      return { ok: false, content: "错误：当前环境不支持任务列表。" };
    }

    const parsed = normalizeTodos(args.todos);
    if (typeof parsed === "string") {
      return { ok: false, content: parsed };
    }

    ctx.todos.set(parsed);
    return {
      ok: true,
      content: `已更新任务列表：\n${renderTodos(parsed)}`,
      summary: summarize(parsed),
    };
  },
};
