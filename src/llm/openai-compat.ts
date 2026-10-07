import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { createNonPoolingAgent, delay, isRetryableError } from "./http";
import type {
  ChatOptions,
  ChatMessage,
  LLMProvider,
  StreamChunk,
  ToolCall,
  ToolSpec,
  Usage,
} from "./types";

export interface OpenAICompatConfig {
  id: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

const MAX_ATTEMPTS = 3;

/**
 * OpenAI 兼容协议 Provider。
 * 适用于 OpenAI / DeepSeek / GLM / Qwen / Groq / Ollama / 任意兼容端点。
 *
 * 针对 "Premature close" 的处理：
 * 1. 使用 `keepAlive: false` 的 Agent，避免复用已被关闭的长连接；
 * 2. 不在请求中强制发送 `stream_options`（部分兼容端点不支持会导致连接异常）；
 * 3. 在尚未产生任何输出前，对瞬时网络错误自动重试。
 */
export class OpenAICompatProvider implements LLMProvider {
  public readonly id: string;
  public readonly model: string;
  private readonly client: OpenAI;

  constructor(config: OpenAICompatConfig) {
    this.id = config.id;
    this.model = config.model;
    const targetUrl = config.baseUrl || "https://api.openai.com/v1";
    this.client = new OpenAI({
      apiKey: config.apiKey || "not-needed",
      baseURL: config.baseUrl,
      httpAgent: createNonPoolingAgent(targetUrl),
      // 重试由本 Provider 统一控制（见下方 MAX_ATTEMPTS 与 onRetry）。
      // SDK 默认 maxRetries = 2 且**不会**回调 onRetry，会让实际请求次数
      // 最多膨胀到 1+2 再乘以 MAX_ATTEMPTS，界面上却仍显示 "1/3"。
      maxRetries: 0,
    });
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamChunk> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // emitted 标记：一旦向调用方输出了内容，就不再重试，避免重复输出
      let emitted = false;

      try {
        yield* this.streamOnce(options, () => {
          emitted = true;
        });
        return;
      } catch (error) {
        lastError = error;
        if (
          emitted ||
          options.signal?.aborted ||
          attempt >= MAX_ATTEMPTS ||
          !isRetryableError(error)
        ) {
          throw error;
        }
        options.onRetry?.(
          attempt,
          MAX_ATTEMPTS,
          error instanceof Error ? error : new Error(String(error)),
        );
        await delay(attempt * 600);
      }
    }

    throw lastError;
  }

  private async *streamOnce(
    options: ChatOptions,
    markEmitted: () => void,
  ): AsyncIterable<StreamChunk> {
    const messages = options.messages.map(toOpenAIMessage);
    const tools: ChatCompletionTool[] | undefined =
      options.tools.length > 0
        ? options.tools.map(toOpenAITool)
        : undefined;

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        tools,
        temperature: options.temperature,
        stream: true,
      },
      { signal: options.signal },
    );

    // 流式 tool_calls 需要按 index 分片累加
    const buffers = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let sawToolCall = false;

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta) {
        const text = delta.content;
        if (typeof text === "string" && text.length > 0) {
          markEmitted();
          yield { type: "text", text };
        }

        const reasoning = delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          markEmitted();
          yield { type: "reasoning", text: reasoning };
        }

        const toolCalls = delta.tool_calls as
          | Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>
          | undefined;
        if (toolCalls) {
          sawToolCall = true;
          for (const tc of toolCalls) {
            const index = tc.index ?? 0;
            const buf = buffers.get(index) ?? { id: "", name: "", args: "" };
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name += tc.function.name;
            if (tc.function?.arguments) buf.args += tc.function.arguments;
            buffers.set(index, buf);
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    for (const [index, buf] of buffers) {
      if (!buf.name) continue;
      const call: ToolCall = {
        id: buf.id || `call_${Date.now()}_${index}`,
        name: buf.name,
        arguments: buf.args || "{}",
      };
      markEmitted();
      yield { type: "tool_call", toolCall: call };
    }

    if (sawToolCall) markEmitted();
    yield {
      type: "done",
      finishReason: sawToolCall ? "tool_calls" : finishReason,
      usage,
    };
  }
}

function toOpenAIMessage(message: ChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      if (message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      }
      return { role: "assistant", content: message.content };
    }
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? "",
      };
    default:
      return { role: "user", content: message.content };
  }
}

function toOpenAITool(tool: ToolSpec): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  };
}
