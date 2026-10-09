import type { JsonSchema } from "../llm/types";

/** 任务项状态 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** 一条任务项 */
export interface TodoItem {
  /** 任务内容（一句话，动词开头） */
  content: string;
  status: TodoStatus;
}

/**
 * 任务列表存储（由 Agent 注入）。
 *
 * 工具本身是无状态的函数，任务列表必须挂在会话上，因此通过 ToolContext
 * 传入一个可读写的引用；Agent 在 `set()` 时同步通知界面刷新。
 */
export interface TodoStore {
  get(): TodoItem[];
  set(items: TodoItem[]): void;
}

/** 派生子代理的请求 */
export interface SubAgentInput {
  /** 要派生的子代理名称（见 src/subagents 注册表）；缺省用默认子代理 */
  subagentName?: string;
  /** 子任务的一句话说明（用于界面与结果摘要） */
  description: string;
  /** 交给子代理的完整任务描述 */
  prompt: string;
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 当前工作目录 */
  cwd: string;
  /** 是否自动批准（非危险）工具 */
  autoApprove: boolean;
  /** 向界面输出区推送实时信息 */
  emit?: (message: string) => void;
  /** 请求用户确认（由 Agent 注入），供工具内部执行危险操作前调用 */
  confirm?: (request: ConfirmRequest) => Promise<boolean>;
  /** 中断信号（由 Agent 注入） */
  signal?: AbortSignal;
  /** 当前会话的任务列表（由 Agent 注入），供 todo_write 使用 */
  todos?: TodoStore;
  /** 长期记忆字符上限，超出时自动精简（由 Agent 注入） */
  memoryMaxChars?: number;
  /** 派生子代理执行子任务（由 Agent 注入），未提供时 task 工具不可用 */
  spawnAgent?: (input: SubAgentInput) => Promise<ToolResult>;
}

/** 需要用户确认的请求 */
export interface ConfirmRequest {
  tool: string;
  /** 一行标题，例如 "写入文件" */
  title: string;
  /** 详情（命令 / diff 预览） */
  detail: string;
  /** 是否为危险操作 */
  danger: boolean;
}

/** 工具执行结果 */
export interface ToolResult {
  ok: boolean;
  /** 返回给模型的完整内容 */
  content: string;
  /** 供界面展示的简短摘要 */
  summary?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** 执行前是否需要用户确认 */
  requiresConfirmation?: boolean;
  /**
   * 是否**可与其他可并行工具同时执行**。
   *
   * 默认 false：多数工具有副作用（写文件、执行命令）或互相依赖，必须按顺序跑。
   * 只有「不共享任何可变状态、彼此独立」的工具才应设为 true —— 目前只有 `task`
   * （每个子代理是独立的 Agent 实例）。模型在一轮里返回多个此类调用时，
   * Agent 会并发执行它们（并发上限见 config.maxParallelAgents）。
   */
  parallelSafe?: boolean;
  /**
   * 危险操作（执行命令 / 写文件 / 安装依赖）。
   *
   * 作用是**提示级别**：未开启自动批准时确认框会标为高危；开启自动批准
   * （默认）时与其他工具同样直接执行 —— 用户选择全自动即代表接受风险。
   */
  danger?: boolean;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

export type { JsonSchema };
