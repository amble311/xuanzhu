import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { createNonPoolingAgent, llmIdleTimeoutMs, withIdleTimeout } from "./http";
import { currentProxyUrl, proxyFetch } from "../network/proxy";
import { StreamEmitter, withRetry } from "./stream-retry";
import type {
  ChatOptions,
  ChatMessage,
  LLMProvider,
  StreamChunk,
  ToolCall,
  ToolSpec,
  Usage,
} from "./types";
import { IMAGE_FALLBACK_TEXT } from "./vision";

export interface OpenAICompatConfig {
  id: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

/**
 * OpenAI 兼容协议 Provider。
 * 适用于 OpenAI / DeepSeek / GLM / Qwen / Groq / Ollama / 任意兼容端点。
 *
 * 针对 "Premature close" 的处理：
 * 1. 使用 `keepAlive: false` 的 Agent，避免复用已被关闭的长连接；
 * 2. 不在请求中强制发送 `stream_options`（部分兼容端点不支持会导致连接异常）；
 * 3. 瞬时网络错误由 `withRetry` 统一重试，**输出中途断连时跳过重复前缀续传**
 *    （见 `stream-retry.ts`）。
 */
export class OpenAICompatProvider implements LLMProvider {
  public readonly id: string;
  public readonly model: string;
  private readonly client: OpenAI;

  constructor(config: OpenAICompatConfig) {
    this.id = config.id;
    this.model = config.model;
    const targetUrl = config.baseUrl || "https://api.openai.com/v1";
    const proxy = currentProxyUrl();
    this.client = new OpenAI({
      apiKey: config.apiKey || "not-needed",
      baseURL: config.baseUrl,
      // 配置了 xzh vpn 时改用 undici fetch（走全局 ProxyAgent）；
      // 未配置时保留原来的 httpAgent：禁用 keep-alive + 空闲超时。
      ...(proxy
        ? { fetch: proxyFetch as never }
        : { httpAgent: createNonPoolingAgent(targetUrl) }),
      // 重试统一交给 withRetry（见 stream-retry.ts）。
      // SDK 默认 maxRetries = 2 且**不会**回调 onRetry，会让实际请求次数
      // 最多膨胀到 1+2 再乘以 MAX_ATTEMPTS，界面上却仍显示 "1/3"。
      maxRetries: 0,
    });
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamChunk> {
    /* ⚠️ 每次尝试都套一层**空闲超时**：端点卡死（连上不吐数据）时能及时中断并重试，
     * 否则 `agent.run()` 永不返回 → TUI 的 busy 永不释放 → 界面卡死 ✗（2026-10-25 实测）。 */
    yield* withRetry(options, (emit) =>
      withIdleTimeout(this.streamOnce(options, emit), llmIdleTimeoutMs()),
    );
  }

  private async *streamOnce(
    options: ChatOptions,
    emit: StreamEmitter,
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
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
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
          cachedInputTokens:
            chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta) {
        const text = delta.content;
        if (typeof text === "string" && text.length > 0) {
          const out = emit.text(text);
          if (out) yield { type: "text", text: out };
        }

        const reasoning = delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          const out = emit.reasoning(reasoning);
          if (out) yield { type: "reasoning", text: out };
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
      if (!emit.toolCall()) continue;
      yield { type: "tool_call", toolCall: call };
    }

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
    case "user": {
      // 带图片时改用 content 分片数组（纯文本仍走字符串，保持与旧行为一致）
      if (message.images && message.images.length > 0) {
        const parts: ChatCompletionContentPart[] = [
          { type: "text", text: message.content || IMAGE_FALLBACK_TEXT },
        ];
        for (const image of message.images) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          });
        }
        return { role: "user", content: parts };
      }
      return { role: "user", content: message.content };
    }
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
