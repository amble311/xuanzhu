import { describe, expect, it } from "vitest";
import { parseReviewOutput, reviewWithAgent } from "../src/a/agent-review";
import type { WatchItem } from "../src/a/watchlist";

const items: WatchItem[] = [
  { code: "600519", name: "贵州茅台", score: 90, reason: "日线", source: "select", addedAt: "t" },
  { code: "300750", name: "宁德时代", score: 88, reason: "日线", source: "select", addedAt: "t" },
  { code: "000001", name: "平安银行", score: 80, reason: "日线", source: "select", addedAt: "t" },
];

describe("Agent 复核边界", () => {
  it("只允许剔除池内股票，最多 3 只，并保留未覆盖的", () => {
    const parsed = parseReviewOutput(
      JSON.stringify({
        drop: [
          { code: "000001", reason: "公告减持" },
          { code: "999999", reason: "不存在的股票" },
        ],
        keep: [
          { code: "300750", rank: 1, reason: "趋势更强" },
          { code: "600519", rank: 2 },
        ],
        summary: "剔除一只",
      }),
      items,
    )!;
    expect(parsed.drop).toHaveLength(1);
    expect(parsed.keep.map((entry) => entry.code)).toEqual(["300750", "600519"]);
  });

  it("非法 JSON / 空 keep 返回 null", () => {
    expect(parseReviewOutput("not json", items)).toBeNull();
    expect(parseReviewOutput('{"drop":[],"keep":[]}', items)).toBeNull();
  });

  it("关闭开关时不调用模型，原样返回", async () => {
    const original = process.env.XZH_A_AGENT_REVIEW;
    process.env.XZH_A_AGENT_REVIEW = "off";
    try {
      const result = await reviewWithAgent(items);
      expect(result.used).toBe(false);
      expect(result.items).toEqual(items);
    } finally {
      if (original === undefined) delete process.env.XZH_A_AGENT_REVIEW;
      else process.env.XZH_A_AGENT_REVIEW = original;
    }
  });
});
