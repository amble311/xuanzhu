import { describe, expect, it } from "vitest";
import {
  estimateMessageTokens,
  estimateTokens,
  sliceToTokenBudget,
  squeezeStaleToolOutput,
  trimMessagesToBudget,
} from "../src/llm/context";
import type { ChatMessage } from "../src/llm/types";

const user = (content: string): ChatMessage => ({ role: "user", content });
const toolResult = (content: string, id: string): ChatMessage => ({
  role: "tool",
  content,
  toolCallId: id,
});
const assistantWithCall = (args: string, id: string): ChatMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "bash", arguments: args }],
});

describe("estimateTokens", () => {
  it("空文本为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("ASCII 按 ~3.5 字符/token 估算", () => {
    expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 3.5));
  });

  it("CJK 按 1 字符/token 估算（宁高估）", () => {
    expect(estimateTokens("你好")).toBe(2);
  });

  it("混排分别计费", () => {
    // "ab" → ceil(2/3.5)=1；"你" → 1
    expect(estimateTokens("ab你")).toBe(2);
  });
});

describe("sliceToTokenBudget", () => {
  it("预算内返回原文", () => {
    expect(sliceToTokenBudget("hello", 100)).toBe("hello");
  });

  it("超预算时按预算截断且不越界", () => {
    const cut = sliceToTokenBudget("hello world", 1);
    expect(cut.length).toBeLessThanOrEqual(4); // ceil(4/3.5)=2 > 1，最多 3 字符
    expect(cut).toBe("hel");
  });

  it("预算为 0 返回空串", () => {
    expect(sliceToTokenBudget("hello", 0)).toBe("");
  });
});

describe("squeezeStaleToolOutput", () => {
  it("压缩老旧的大块工具输出、保留近期消息", () => {
    // ASCII 按 3.5 字符/token 估算：4000 字符 ≈ 1143 token，才会超过
    // STALE_TOOL_OUTPUT_TOKENS(600) 触发压缩
    const big = "x".repeat(4000);
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(user(`u${i}`));
      messages.push(toolResult(big + i, `t${i}`));
    }
    const squeezed = squeezeStaleToolOutput(messages);
    // 前 (20 - 6) 条中的 tool 消息应被压缩（长度显著变短）
    const squeezedTool = squeezed.find(
      (m, i) => m.role === "tool" && i < messages.length - 6,
    );
    expect(squeezedTool?.content.length).toBeLessThan(big.length);
    // 近期（最后 6 条）保持原样
    expect(squeezed[squeezed.length - 1].content).toContain(big[0]);
  });

  it("消息数不超过保护窗口时不做任何压缩", () => {
    const messages = [user("u1"), toolResult("x".repeat(2000), "t1")];
    const squeezed = squeezeStaleToolOutput(messages);
    expect(squeezed[1].content.length).toBe(2000);
  });
});

describe("trimMessagesToBudget", () => {
  it("从最老的开始丢，最近的优先保留", () => {
    // 每条 user 消息 cost ≈ 4(开销) + 4(CJK 字符) = 8 token；预算 12 只够放最后一条
    const messages = [user("旧消息"), user("中间"), user("最新消息")];
    const kept = trimMessagesToBudget(messages, 12);
    expect(kept.map((m) => m.content)).toEqual(["最新消息"]);
  });

  it("保留 user + assistant(toolCalls) + tool 的配对，不出现孤立 tool 前缀", () => {
    const messages = [
      user("跑一下测试"),
      assistantWithCall('{"command":"npm test"}', "call-1"),
      toolResult("all passed", "call-1"),
      user("总结一下"),
    ];
    // 预算只够放下后半段
    const kept = trimMessagesToBudget(messages, 80);
    expect(kept[0].role).not.toBe("tool");
  });

  it("唯一保留的消息超预算时截断正文而不是丢弃", () => {
    const big = "y".repeat(5000);
    const kept = trimMessagesToBudget([user(big)], 200);
    expect(kept.length).toBe(1);
    expect(kept[0].content).toContain("已截断");
  });

  it("图片超出预算时降级为占位文本，而不是把会话裁空（回归）", () => {
    // 3 张图按 1600 token/张估算 = 4800，远超 100 的预算；
    // 修复前 shrinkMessage 不处理 images → 返回 null → trim 返回 []
    const message: ChatMessage = {
      role: "user",
      content: "帮我看这张截图",
      images: [
        { mimeType: "image/png", data: "aGk=" },
        { mimeType: "image/png", data: "aGk=" },
        { mimeType: "image/png", data: "aGk=" },
      ],
    };
    const kept = trimMessagesToBudget([message], 100);
    expect(kept.length).toBe(1);
    expect(kept[0].images).toBeUndefined();
    expect(kept[0].content).toContain("图片已省略");
    expect(kept[0].content).toContain("帮我看这张截图");
  });

  it("图片能放进预算时原样保留", () => {
    const message: ChatMessage = {
      role: "user",
      content: "看图",
      images: [{ mimeType: "image/png", data: "aGk=" }],
    };
    const kept = trimMessagesToBudget([message], 2_000);
    expect(kept[0].images?.length).toBe(1);
  });
});

describe("estimateMessageTokens", () => {
  it("图片按固定值计费", () => {
    const withImage = estimateMessageTokens({
      role: "user",
      content: "",
      images: [{ mimeType: "image/png", data: "aGk=" }],
    });
    const withoutImage = estimateMessageTokens({ role: "user", content: "" });
    expect(withImage - withoutImage).toBe(1_600);
  });
});
