import { describe, expect, it } from "vitest";
import { backtestMetrics, type BacktestTrade } from "../src/a/backtest";

describe("回测指标", () => {
  it("收益 / 基准 / 最大回撤 / 胜率 / 平均持有", () => {
    const trades: BacktestTrade[] = [
      { code: "600519", side: "buy", date: "2026-01-02", price: 10, qty: 100, reason: "test" },
      { code: "600519", side: "sell", date: "2026-01-05", price: 11, qty: 100, reason: "test", pnl: 99 },
      { code: "600519", side: "buy", date: "2026-01-06", price: 10, qty: 100, reason: "test" },
      { code: "600519", side: "sell", date: "2026-01-09", price: 9, qty: 100, reason: "test", pnl: -101 },
    ];
    const result = backtestMetrics(
      [1000, 1100, 900, 1200],
      1000,
      [100, 110],
      trades,
      [3, 3],
    );
    expect(result.final).toBe(1200);
    expect(result.returnPct).toBe(20);
    expect(result.benchmarkPct).toBe(10);
    expect(result.maxDrawdownPct).toBeCloseTo(-18.1818, 3);
    expect(result.winRatePct).toBe(50);
    expect(result.avgHoldDays).toBe(3);
  });

  it("没有已平仓交易时胜率为 0，平均持有为 0", () => {
    const result = backtestMetrics([1000], 1000, [100], [], []);
    expect(result.returnPct).toBe(0);
    expect(result.winRatePct).toBe(0);
    expect(result.avgHoldDays).toBe(0);
  });
});
