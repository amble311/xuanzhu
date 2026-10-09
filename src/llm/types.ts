/** LLM 抽象层类型定义（与具体 SDK 解耦） */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串形式的参数 */
  arguments: string;
}

/**
 * 图片附件（多模态输入）。
 *
 * `data` 是**不带 `data:` 前缀**的 base64 —— 各 Provider 需要的包装形式不同
 * （OpenAI 要 data URL、Anthropic 要 media_type、Gemini 要 inlineData），
 * 统一在各自的转换函数里拼装。
 */
export interface ImageAttachment {
  /** MIME 类型，如 image/png。Anthropic 只接受 png / jpeg / gif / webp */
  mimeType: string;
  /** base64 编码的图片字节 */
  data: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /**
   * 随该消息发送的图片（仅 `user` 消息有意义）。
   *
   * 之所以挂在独立字段上而不是把 `content` 改成联合类型：`content` 是字符串这件事
   * 被历史裁剪、token 估算、日志、子代理报告等大量逻辑依赖，改成多部分类型会
   * 牵动整条链路。图片只在 Provider 转换与 token 估算两处需要特殊处理。
   */
  images?: ImageAttachment[];
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
