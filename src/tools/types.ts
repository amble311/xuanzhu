import type { JsonSchema } from "../llm/types";

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
