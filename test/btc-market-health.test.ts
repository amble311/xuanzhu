import { describe, expect, it } from "vitest";
import {
  MARKET_FAILURE_THRESHOLD,
  marketStatusText,
  shouldAlertMarket,
} from "../src/btc/market-health";

/**
 * 行情健康规则（用户设定）：
 * - 连续两次拿不到行情就唤醒模型排查；
 * - 同一轮故障只叫醒一次，否则会每 5 分钟叫一次（烧钱循环）；
 * - 恢复后计数清零，下次再连续失败还能再叫。
 */
describe("行情健康", () => {
  it("连续两次才叫醒，且同一轮故障只叫一次", () => {
    expect(MARKET_FAILURE_THRESHOLD).toBe(2);
    expect(shouldAlertMarket(0, false)).toBe(false);
    expect(shouldAlertMarket(1, false)).toBe(false);
    expect(shouldAlertMarket(2, false)).toBe(true);
    expect(shouldAlertMarket(5, false)).toBe(true);
    // 已经叫醒过：即使还在失败也不重复叫
    expect(shouldAlertMarket(2, true)).toBe(false);
    expect(shouldAlertMarket(9, true)).toBe(false);
  });

  it("状态文案区分正常 / 失败 / 从未成功", () => {
    expect(marketStatusText(0)).toBe("正常");
    expect(marketStatusText(3, "2026-11-06T13:00:00Z")).toContain("连续失败 3 次");
    expect(marketStatusText(3, "2026-11-06T13:00:00Z")).toContain("2026-11-06 13:00");
    expect(marketStatusText(1)).toContain("启动后从未成功");
  });
});
