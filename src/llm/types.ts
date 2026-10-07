/** LLM 抽象层类型定义（与具体 SDK 解耦） */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串形式的参数 */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant 消息里请求调用的工具 */
  toolCalls?: ToolCall[];
  /** tool 消息对应的调用 id */
  toolCallId?: string;
  /** tool 消息对应的工具名（部分 Provider 需要） */
  name?: string;
}

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "done"; finishReason?: string; usage?: Usage };

export interface ChatOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number;
  signal?: AbortSignal;
  /** 因瞬时网络错误而重试时回调（attempt 从 1 开始） */
  onRetry?: (attempt: number, maxAttempts: number, error: Error) => void;
}

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  chat(options: ChatOptions): AsyncIterable<StreamChunk>;
}
