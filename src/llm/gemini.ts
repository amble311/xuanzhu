import {
  GoogleGenerativeAI,
  SchemaType,
  type Content,
  type FunctionDeclaration,
  type FunctionDeclarationSchema,
  type Part,
  type Tool,
} from "@google/generative-ai";
import { delay, isRetryableError } from "./http";
import { IMAGE_FALLBACK_TEXT } from "./vision";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
  StreamChunk,
  Usage,
} from "./types";

export interface GeminiConfig {
  id: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

const MAX_ATTEMPTS = 3;

/** Google Gemini Provider（流式 + function calling，含瞬时错误重试） */
export class GeminiProvider implements LLMProvider {
  public readonly id: string;
  public readonly model: string;
  private readonly apiKey: string;
  /** 自定义端点（代理 / 自建网关）；此前被读取但从未传给 SDK，配置静默失效 */
  private readonly baseUrl?: string;

  constructor(config: GeminiConfig) {
    this.id = config.id;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
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
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const { system, contents } = toGeminiContents(options.messages);
    const tools: Tool[] | undefined =
      options.tools.length > 0
        ? [{ functionDeclarations: options.tools.map(toFunctionDeclaration) }]
        : undefined;

    const model = genAI.getGenerativeModel(
      {
        model: this.model,
        systemInstruction: system || undefined,
        tools,
        generationConfig: {
          temperature: options.temperature,
        },
      },
      // 传入 requestOptions：让配置的 baseUrl 与中断信号真正生效
      {
        ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    const result = await model.generateContentStream({ contents });

    let usage: Usage | undefined;
    let sawToolCall = false;
    let callIndex = 0;

    for await (const chunk of result.stream) {
      // SDK 不一定把 signal 传到流消费层，这里兜底：中断后立即停止读取
      if (options.signal?.aborted) break;
      const text = safeText(chunk);
      if (text) {
        markEmitted();
        yield { type: "text", text };
      }

      const calls = safeFunctionCalls(chunk);
      for (const call of calls) {
        sawToolCall = true;
        markEmitted();
        yield {
          type: "tool_call",
          toolCall: {
            id: `gemini_call_${Date.now()}_${callIndex++}`,
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          },
        };
      }

      const meta = chunk.usageMetadata;
      if (meta) {
        usage = {
          inputTokens: meta.promptTokenCount,
          outputTokens: meta.candidatesTokenCount,
        };
      }
    }

    if (sawToolCall) markEmitted();
    yield {
      type: "done",
      finishReason: sawToolCall ? "tool_calls" : "stop",
      usage,
    };
  }
}

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

function safeText(chunk: unknown): string {
  try {
    return (chunk as { text: () => string }).text() ?? "";
  } catch {
    return "";
  }
}

function safeFunctionCalls(chunk: unknown): GeminiFunctionCall[] {
  try {
    const calls = (
      chunk as { functionCalls?: () => GeminiFunctionCall[] }
    ).functionCalls?.();
    return calls ?? [];
  } catch {
    return [];
  }
}

function toGeminiContents(messages: ChatMessage[]): {
  system: string;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }

    if (message.role === "user") {
      // 带图片时追加 inlineData 分片（纯文本仍是单个 text part，保持与旧行为一致）
      if (message.images && message.images.length > 0) {
        const parts: Part[] = [
          { text: message.content || IMAGE_FALLBACK_TEXT },
        ];
        for (const image of message.images) {
          parts.push({
            inlineData: { mimeType: image.mimeType, data: image.data },
          });
        }
        contents.push({ role: "user", parts });
        continue;
      }
      contents.push({ role: "user", parts: [{ text: message.content }] });
      continue;
    }

    if (message.role === "assistant") {
      const parts: Part[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            name: call.name,
            args: safeParse(call.arguments),
          },
        });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    if (message.role === "tool") {
      const response: Part = {
        functionResponse: {
          name: message.name ?? "unknown",
          response: { result: message.content },
        },
      };
      const last = contents[contents.length - 1];
      if (
        last &&
        last.role === "user" &&
        last.parts?.some((p) => "functionResponse" in p)
      ) {
        last.parts.push(response);
      } else {
        contents.push({ role: "user", parts: [response] });
      }
    }
  }

  return {
    system: systemParts.join("\n\n"),
    contents: normalizeContents(contents),
  };
}

/**
 * 合并相邻的同 role 消息。
 * 历史裁剪后可能以 model 开头，上一轮请求失败时也可能留下连续两条 user ——
 * Gemini 要求 user / model 交替，这类序列会被判为非法请求。
 */
function normalizeContents(contents: Content[]): Content[] {
  const merged: Content[] = [];
  for (const content of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === content.role) {
      last.parts = [...(last.parts ?? []), ...(content.parts ?? [])];
      continue;
    }
    merged.push({ role: content.role, parts: [...(content.parts ?? [])] });
  }
  while (merged.length > 0 && merged[0].role !== "user") {
    merged.shift();
  }
  return merged;
}

function toFunctionDeclaration(tool: {
  name: string;
  description: string;
  parameters: JsonSchema;
}): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(
      tool.parameters,
    ) as unknown as FunctionDeclarationSchema,
  };
}

function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: normalizeType(schema.type),
  };
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.required) result.required = schema.required;
  if (schema.items) result.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      props[key] = toGeminiSchema(value);
    }
    result.properties = props;
  }
  return result;
}

function normalizeType(type: string): SchemaType {
  switch (type.toLowerCase()) {
    case "string":
      return SchemaType.STRING;
    case "number":
      return SchemaType.NUMBER;
    case "integer":
      return SchemaType.INTEGER;
    case "boolean":
      return SchemaType.BOOLEAN;
    case "array":
      return SchemaType.ARRAY;
    default:
      return SchemaType.OBJECT;
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || "{}");
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
