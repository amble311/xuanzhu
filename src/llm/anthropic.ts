import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import { llmIdleTimeoutMs, withIdleTimeout } from "./http";
import { currentProxyUrl, proxyFetch } from "../network/proxy";
import { StreamEmitter, withRetry } from "./stream-retry";
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
  /** 是否在 system / tools 上打 prompt cache 断点（默认 true） */
  promptCache?: boolean;
}

/** Anthropic Claude Provider（流式 + tool_use，重试与断连续传见 stream-retry.ts） */
export class AnthropicProvider implements LLMProvider {
  public readonly id: string;
  public readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly promptCache: boolean;

  constructor(config: AnthropicConfig) {
    this.id = config.id;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 8192;
    this.promptCache = config.promptCache !== false;
    const proxy = currentProxyUrl();
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      ...(proxy ? { fetch: proxyFetch as never } : {}),
      maxRetries: 0, // 由本 Provider 统一控制重试，避免重复
    });
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamChunk> {
    /* 同 openai-compat：每次尝试都套一层空闲超时，避免端点卡死时界面一直挂着 ✗ */
    yield* withRetry(options, (emit) =>
      withIdleTimeout(this.streamOnce(options, emit), llmIdleTimeoutMs()),
    );
  }

  private async *streamOnce(
    options: ChatOptions,
    emit: StreamEmitter,
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

    const cached = withAnthropicPromptCache(
      system,
      tools,
      this.promptCache,
      options.systemCachePrefix,
    );

    const stream = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: options.maxTokens ?? this.maxTokens,
        system: cached.system,
        messages,
        tools: cached.tools,
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
          const info = event.message?.usage;
          const input = info?.input_tokens;
          if (typeof input === "number") {
            usage = {
              inputTokens: input,
              cachedInputTokens: info?.cache_read_input_tokens ?? undefined,
              cacheWriteInputTokens:
                info?.cache_creation_input_tokens ?? undefined,
            };
          }
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
            const out = emit.text(delta.text);
            if (out) yield { type: "text", text: out };
          } else if (delta.type === "input_json_delta") {
            const buf = blocks.get(event.index);
            if (buf) buf.json += delta.partial_json ?? "";
          } else if (delta.type === "thinking_delta") {
            const thinking = (delta as { thinking?: string }).thinking;
            if (thinking) {
              const out = emit.reasoning(thinking);
              if (out) yield { type: "reasoning", text: out };
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
      if (!emit.toolCall()) continue;
      yield {
        type: "tool_call",
        toolCall: {
          id: buf.id,
          name: buf.name,
          arguments: buf.json || "{}",
        },
      };
    }

    yield {
      type: "done",
      finishReason: sawToolCall ? "tool_calls" : stopReason,
      usage,
    };
  }
}

/**
 * Anthropic prompt cache 断点：
 * - 最后一个 tool 打一个断点（tools 是稳定前缀，system 的动态变化不会冲掉它）；
 * - system 再打一个断点，覆盖静态系统提示词。
 * Anthropic 最多 4 个断点，这里只用 2 个。
 */
export function withAnthropicPromptCache(
  system: string,
  tools: Tool[] | undefined,
  enabled: boolean,
  cachePrefix?: string,
): {
  system: string | TextBlockParam[] | undefined;
  tools: Tool[] | undefined;
} {
  if (!enabled) {
    return { system: system || undefined, tools };
  }
  const cachedTools =
    tools && tools.length > 0
      ? tools.map((tool, index) =>
          index === tools.length - 1
            ? { ...tool, cache_control: { type: "ephemeral" as const } }
            : tool,
        )
      : tools;
  let systemBlocks: TextBlockParam[] | undefined;
  if (system) {
    // 只有静态前缀走缓存；动态追加（相关记忆、goal、提醒）放在后一个 block，
    // 这样它变化时不会让整个 system 缓存失效。
    const prefix =
      cachePrefix && system.startsWith(cachePrefix) ? cachePrefix : system;
    const rest = system.slice(prefix.length);
    systemBlocks = [
      {
        type: "text",
        text: prefix,
        cache_control: { type: "ephemeral" },
      },
    ];
    if (rest.trim()) systemBlocks.push({ type: "text", text: rest });
  }
  return { system: systemBlocks, tools: cachedTools };
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
