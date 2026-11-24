import { describe, expect, it } from "vitest";
import { buildInspectPrompt } from "../src/btc/inspect";

/**
 * 巡检有两套提示词：
 * - `full`：常规巡检 / 市场事件 / 清仓复盘，完整流程 + 12 次工具预算；
 * - `review`：被叫醒条件或挂单超时叫醒时，只复核「条件还成不成立」，5 次预算。
 *
 * 分开的理由：本地模型每次工具往返 30–60 秒，共用长提示词时一轮复核也会跑 8–10 分钟，
 * 响应速度比不过行情变化。这里把「复核不许重跑全量」锁住，避免以后又合并回去。
 */
describe("巡检提示词", () => {
  it("叫醒复核走最短路径：btc_brief + 5 次预算，不要求回测", () => {
    const prompt = buildInspectPrompt("review", 5);
    expect(prompt).toContain("叫醒复核");
    expect(prompt).toContain("btc_brief");
    expect(prompt).toContain("最多 5 次工具调用");
    // 复核里 btc_backtest 是明确禁止的，不能出现「必要才 btc_backtest」这种常规流程话术
    expect(prompt).not.toContain("必要才 `btc_backtest`");
    expect(prompt).toContain("不要 `btc_backtest`");
  });

  it("常规巡检保留完整流程与 12 次预算", () => {
    const prompt = buildInspectPrompt("full", 12);
    expect(prompt).toContain("步骤（btc_* 工具可用）");
    expect(prompt).toContain("最多 12 次工具调用");
    expect(prompt).toContain("btc_brief");
    expect(prompt).toContain("btc_schedule");
  });

  it("两种模式的预算文案与实际限制同源（都来自同一个入参）", () => {
    expect(buildInspectPrompt("review", 3)).toContain("最多 3 次工具调用");
    expect(buildInspectPrompt("full", 8)).toContain("最多 8 次工具调用");
  });
});
