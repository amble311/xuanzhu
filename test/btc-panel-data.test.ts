import { describe, expect, it } from "vitest";
import { btcInfoLines, type BtcPanelData } from "../src/btc/panel-data";

/**
 * `/info` 的价格行。
 *
 * 背景（2026-11-25）：gateway 由 systemd 拉起，**不继承 shell 的 HTTP(S)_PROXY**，
 * 直连币安超时 → 微信 `/info` 只显示「行情接口不可用」，而终端里（继承了 shell env）
 * 有行情。除了在网关里补网络引导，展示层也要能在「实时取价失败」时退回缓存价，
 * 并标清来源与新鲜度 —— 不能只甩一句「不可用」。
 */

const base: BtcPanelData = {
  updatedAt: 0,
  role: "paper",
  ticker: null,
  paused: false,
  account: null,
  paper: {
    price: 58_567.4,
    initial_capital: 100_000,
    cash: 98_917.33,
    equity: 98_917.33,
    return_pct: -1.08,
    position: null,
    trades: 2,
    win_rate: 50,
    realized_pnl: -1_029.41,
    price_source: "close",
  },
  queue: [],
  riskState: { triggered: false } as BtcPanelData["riskState"],
  riskSettings: { maxPositionLossPct: 50, maxDailyLossPct: 50, maxConsecutiveLosses: 3, haltTradingOnTrigger: true },
  triggers: [],
  backendRunning: true,
  actions: [],
  home: "/tmp/xzh-btc",
};

describe("btc /info 价格行", () => {
  it("实时取价成功：显示价格与涨跌幅", () => {
    const lines = btcInfoLines({
      ...base,
      ticker: { price: 60_000, changePct: 1.5 },
    });
    expect(lines.join("\n")).toContain("价格 60,000.00（+1.50%）");
  });

  it("实时取价失败但有缓存价：显示缓存价 + 来源 + 新鲜度，并注明实时不可用", () => {
    const lines = btcInfoLines({
      ...base,
      tickerError: "fetch failed",
      lastMarketOkAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    });
    const text = lines.join("\n");
    expect(text).toContain("价格 58,567.40（库内收盘价，后端 8 分钟前 取到）");
    expect(text).toContain("实时行情不可用：fetch failed");
  });

  it("既没有实时价也没有缓存价：如实说不可用", () => {
    const lines = btcInfoLines({
      ...base,
      paper: null,
      tickerError: "fetch failed",
    });
    expect(lines.join("\n")).toContain("价格 —（行情接口不可用：fetch failed）");
  });
});
