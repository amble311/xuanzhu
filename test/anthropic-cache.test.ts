import { describe, expect, it } from "vitest";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { withAnthropicPromptCache } from "../src/llm/anthropic";

const tools = [
  {
    name: "read_file",
    description: "read",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "bash",
    description: "bash",
    input_schema: { type: "object", properties: {} },
  },
] as Tool[];

describe("Anthropic prompt cache 断点", () => {
  it("system 与最后一个 tool 打 ephemeral 断点", () => {
    const cached = withAnthropicPromptCache("system prompt", tools, true);

    expect(Array.isArray(cached.system)).toBe(true);
    expect((cached.system as Array<{ cache_control?: unknown }>)[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "system prompt",
        cache_control: { type: "ephemeral" },
      }),
    );
    expect(cached.tools?.[0].cache_control).toBeUndefined();
    expect(cached.tools?.[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("静态前缀与动态追加分块，动态变化不影响静态缓存", () => {
    const cached = withAnthropicPromptCache(
      "STATIC_BASE\n\n## 本轮相关全局记忆\n- 动态内容",
      undefined,
      true,
      "STATIC_BASE",
    );
    expect(cached.system).toEqual([
      {
        type: "text",
        text: "STATIC_BASE",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "\n\n## 本轮相关全局记忆\n- 动态内容",
      },
    ]);
  });

  it("关闭时不发送任何 cache_control", () => {
    const cached = withAnthropicPromptCache("system prompt", tools, false);
    expect(cached.system).toBe("system prompt");
    expect(cached.tools?.every((tool) => !tool.cache_control)).toBe(true);
  });
});
