import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { delay, isRetryableError } from "./http";
import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  StreamChunk,
  ToolSpec,
  Usage,
} from "./types";
import { IMAGE_FALLBACK_TEXT, normalizeAnthropicMediaType } from "./vision";

export interface AnthropicConfig {
  id: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
}

const MAX_ATTEMPTS = 3;

/** Anthropic Claude Provider（流式 + tool_use，含瞬时错误重试） */
export class AnthropicProvider implements LLMProvider {
  public readonly id: string;
  public readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;

  constructor(config: AnthropicConfig) {
    this.id = config.id;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 8192;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 0, // 由本 Provider 统一控制重试，避免重复
    });
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamChunk> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
    const { system, messages } = toAnthropicMessages(options.messages);
    const tools: Tool[] | undefined =
      options.tools.length > 0
        ? options.tools.map(
            (tool: ToolSpec): Tool => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters as Tool["input_schema"],
            }),
          )
        : undefined;

    const stream = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: system || undefined,
        messages,
        tools,
        temperature: options.temperature,
        stream: true,
      },
      { signal: options.signal },
    );

    const blocks = new Map<number, { id: string; name: string; json: string }>();
    let usage: Usage | undefined;
    let stopReason: string | undefined;
    let sawToolCall = false;

    for await (const event of stream) {
      switch (event.type) {
        case "message_start": {
          const input = event.message?.usage?.input_tokens;
          if (typeof input === "number") usage = { inputTokens: input };
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use") {
            sawToolCall = true;
            blocks.set(event.index, {
              id: block.id,
              name: block.name,
              json: "",
            });
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta" && delta.text) {
            markEmitted();
            yield { type: "text", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            const buf = blocks.get(event.index);
            if (buf) buf.json += delta.partial_json ?? "";
          } else if (delta.type === "thinking_delta") {
            const thinking = (delta as { thinking?: string }).thinking;
            if (thinking) {
              markEmitted();
              yield { type: "reasoning", text: thinking };
            }
          }
          break;
        }
        case "message_delta": {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          const output = event.usage?.output_tokens;
          if (typeof output === "number") {
            usage = { ...(usage ?? {}), outputTokens: output };
          }
          break;
        }
        default:
          break;
      }
    }

    for (const buf of blocks.values()) {
      if (!buf.name) continue;
      markEmitted();
      yield {
        type: "tool_call",
        toolCall: {
          id: buf.id,
          name: buf.name,
          arguments: buf.json || "{}",
        },
      };
    }

    if (sawToolCall) markEmitted();
    yield {
      type: "done",
      finishReason: sawToolCall ? "tool_calls" : stopReason,
      usage,
    };
  }
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: MessageParam[];
} {
  const systemParts: string[] = [];
  const result: MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }

    if (message.role === "user") {
      // 带图片时改用 content block 数组（纯文本仍走字符串，保持与旧行为一致）
      if (message.images && message.images.length > 0) {
        const blocks: ContentBlockParam[] = [
          { type: "text", text: message.content || IMAGE_FALLBACK_TEXT },
        ];
        for (const image of message.images) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              // Anthropic 只认 png / jpeg / gif / webp，其余格式会被拒绝
              media_type: normalizeAnthropicMediaType(image.mimeType),
              data: image.data,
            },
          });
        }
        result.push({ role: "user", content: blocks });
        continue;
      }
      result.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      if (message.toolCalls && message.toolCalls.length > 0) {
        const blocks: ContentBlockParam[] = [];
        if (message.content) {
          blocks.push({ type: "text", text: message.content });
        }
        for (const call of message.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: safeParse(call.arguments),
          });
        }
        result.push({ role: "assistant", content: blocks });
      } else {
        result.push({ role: "assistant", content: message.content });
      }
      continue;
    }

    if (message.role === "tool") {
      const block: ContentBlockParam = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      };
      const last = result[result.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === "tool_result")
      ) {
        (last.content as ContentBlockParam[]).push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
    }
  }

  return {
    system: systemParts.join("\n\n"),
    messages: normalizeMessages(result),
  };
}

/** 把消息内容规整为 content block 数组 */
function toBlocks(content: MessageParam["content"]): ContentBlockParam[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

/**
 * Anthropic 要求 messages 严格 user/assistant 交替、且必须以 user 开头，
 * 否则直接 400（`messages: roles must alternate`）。以下两种情况会产生非法序列：
 * 1. 上一轮请求失败：历史里会出现连续两条 user（模型没来得及回复）；
 * 2. 历史裁剪（trimHistory）后可能以 assistant 开头。
 * 这里统一归一化：合并相邻同 role 的 user 消息，并丢弃开头的 assistant。
 */
function normalizeMessages(messages: MessageParam[]): MessageParam[] {
  const merged: MessageParam[] = [];

  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      if (message.role === "user") {
        merged[merged.length - 1] = {
          role: "user",
          content: [...toBlocks(last.content), ...toBlocks(message.content)],
        };
      } else {
        // 相邻 assistant：保留后一条，避免插入空的文本块
        merged[merged.length - 1] = message;
      }
      continue;
    }
    merged.push(message);
  }

  while (merged.length > 0 && merged[0].role !== "user") {
    merged.shift();
  }

  return merged;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || "{}");
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
