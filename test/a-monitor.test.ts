import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inTradingWindow, shouldSell } from "../src/a/monitor";
import { decideMarketRegime } from "../src/a/regime";
import { computeIndicators } from "../src/a/indicators";
import { scoreDailyDetailed } from "../src/a/score";
import {
  addWatchItem,
  loadWatchlist,
  mergeWatchlist,
  removeWatchItem,
  saveWatchlist,
  type WatchItem,
} from "../src/a/watchlist";
import type { Quote } from "../src/exchange/ashare";
import { continuousSession, isTradingTime } from "../src/exchange/ashare";
import type { Indicators } from "../src/a/indicators";
import type { SnapshotRow } from "../src/a/snapshot";

/** A 股巡检：股池不变量、打分方向、T+1 卖点、盘中窗口。全部离线。 */

function row(): SnapshotRow {
  return {
    code: "600519",
    name: "贵州茅台",
    price: 15,
    preClose: 14.8,
    pct: 1.35,
    open: 14.9,
    high: 15.1,
    low: 14.8,
    volume: 1_000_000,
    amount: 300_000_000,
    turnoverPct: 5,
    board: "sh-main",
    st: false,
    status: "交易中",
  };
}

const indicators: Indicators = {
  code: "600519",
  asOf: "2026-11-06",
  close: 15,
  ma5: 14.5,
  ma10: 14,
  ma20: 13,
  ma60: 12,
  high20: 15.2,
  high60: 15.2,
  low20: 11,
  ret5: 4,
  ret20: 20,
  ret60: 30,
  avgAmount5: 300_000_000,
  avgAmount20: 300_000_000,
  bars: 140,
};

describe("日线详细评分", () => {
  it("趋势向上、位置合适时高分，下跌趋势显著低", () => {
    const up = scoreDailyDetailed(row(), indicators);
    const down = scoreDailyDetailed(row(), {
      ...indicators,
      close: 8,
      ma5: 9,
      ma20: 10,
      ma60: 12,
      high20: 12,
      ret5: -5,
      ret20: -20,
      ret60: -30,
      atr20: 0.2,
    });
    expect(up).toBeGreaterThanOrEqual(70);
    expect(up).toBeGreaterThan(down);
  });

  it("指标缺失返回 0", () => {
    expect(scoreDailyDetailed(row(), undefined)).toBe(0);
  });
});

describe("自选股不变量", () => {
  let home: string;
  const original = process.env.XZH_A_HOME;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-a-watch-"));
    process.env.XZH_A_HOME = home;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.XZH_A_HOME;
    else process.env.XZH_A_HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const item = (code: string, score: number): WatchItem => ({
    code,
    name: code,
    score,
    reason: "test",
    source: "select",
    addedAt: new Date().toISOString(),
  });

  it("持仓强制保留，其余按分数取前 10", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => item(`6000${index}`, 100 - index));
    const merged = mergeWatchlist(candidates, [{ code: "600010", name: "持仓" }]);
    expect(merged.items).toHaveLength(10);
    expect(merged.items[0].code).toBe("600010");
    expect(merged.items[0].source).toBe("held");
  });

  it("持仓不在候选里也会被补进来", () => {
    const merged = mergeWatchlist([item("600001", 80)], [{ code: "600002", name: "持仓" }]);
    expect(merged.items.map((entry) => entry.code)).toEqual(["600002", "600001"]);
  });

  it("持仓不能删除；非持仓可删除；最多 10 只", () => {
    saveWatchlist(mergeWatchlist([item("600001", 90), item("600002", 80)], []));
    expect(removeWatchItem("600001", new Set(["600001"])).ok).toBe(false);
    expect(removeWatchItem("600002", new Set(["600001"])).ok).toBe(true);

    saveWatchlist({ version: 1, updatedAt: new Date().toISOString(), items: Array.from({ length: 10 }, (_, index) => item(`6000${index}`, 90)) });
    expect(addWatchItem(item("600099", 70)).ok).toBe(false);
    expect(loadWatchlist().items).toHaveLength(10);
  });
});

describe("市场门控与 ATR", () => {
  it("指数在 MA20 上方且广度健康才允许开仓", () => {
    expect(
      decideMarketRegime(
        { name: "沪深300", price: 100, ma20: 90 },
        { up: 600, down: 400, flat: 0, limitDown: 5 },
      ).riskOn,
    ).toBe(true);
    expect(
      decideMarketRegime(
        { name: "沪深300", price: 80, ma20: 90 },
        { up: 600, down: 400, flat: 0, limitDown: 5 },
      ).riskOn,
    ).toBe(false);
    expect(
      decideMarketRegime(
        { name: "沪深300", price: 100, ma20: 90 },
        { up: 300, down: 700, flat: 0, limitDown: 5 },
      ).riskOn,
    ).toBe(false);
    expect(
      decideMarketRegime(
        { name: "沪深300", price: 100, ma20: 90 },
        { up: 600, down: 400, flat: 0, limitDown: 25 },
      ).riskOn,
    ).toBe(false);
    expect(decideMarketRegime(null, null).riskOn).toBe(false);
  });

  it("ATR20 按真实波幅计算", () => {
    const bars = Array.from({ length: 25 }, (_, index) => ({
      time: `2026-09-${String(index + 1).padStart(2, "0")}`,
      open: 10,
      high: 10.5,
      low: 9.5,
      close: 10,
      volume: 1_000_000,
      amount: 10_000_000,
    }));
    const indicators = computeIndicators("600519", bars)!;
    expect(indicators.atr20).toBeCloseTo(1, 5);
  });
});

describe("卖点与窗口", () => {
  const position = {
    code: "600519",
    name: "贵州茅台",
    qty: 100,
    available: 100,
    avgCost: 10,
    lastPrice: 10,
    marketValue: 1000,
    pnl: 0,
    pnlPct: 0,
  };
  const quote = {
    code: "600519",
    name: "贵州茅台",
    price: 10,
    preClose: 10,
    open: 10,
    high: 10,
    low: 10,
    change: 0,
    changePct: 0,
    volume: 1,
    amount: 1,
    board: "sh-main" as const,
    st: false,
  } satisfies Quote;

  it("T+1 当日买入仍评估风控，但标记为不可卖", () => {
    const locked = shouldSell({ ...position, available: 0 }, { ...quote, price: 8 });
    expect(locked?.reason).toContain("止损");
    expect(locked?.sellable).toBe(false); // 今天不能卖，待下一交易日

    const stop = shouldSell(position, { ...quote, price: 9 });
    expect(stop?.reason).toContain("止损");
    expect(stop?.sellable).toBe(true);
  });

  it("ATR 越大止损越宽；浮盈后移动止盈", () => {
    const wide = shouldSell(position, { ...quote, price: 9.2 }, { atr20: 0.8, close: 10 });
    expect(wide).toBeNull(); // 8% ATR → 12% 止损，9.2 未触发

    const trailing = shouldSell(
      { ...position, peakPrice: 12, tookPartial: true },
      { ...quote, price: 11.3 },
    );
    expect(trailing?.reason).toContain("移动止盈");
    expect(trailing?.sellable).toBe(true);

    const partial = shouldSell(
      { ...position, qty: 200, available: 200, peakPrice: 11.3, tookPartial: false },
      { ...quote, price: 11.1 },
    );
    expect(partial?.partial).toBe(true);
    expect(partial?.qty).toBe(100);
  });

  it("只在工作日 09:00–15:30 运行", () => {
    expect(inTradingWindow(new Date("2026-11-09T10:00:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-09T12:00:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-09T14:00:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-09T08:59:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T15:31:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-08T10:00:00+08:00"))).toBe(false);
  });

  it("工作窗口 ≠ 撮合时段：集合竞价与午休不能成交", async () => {
    // 工作窗口包含 09:00–09:30 与 11:30–13:00，撮合闸门必须更严
    expect(isTradingTime(new Date("2026-11-09T09:10:00+08:00"))).toBe(false); // 盘前
    expect(isTradingTime(new Date("2026-11-09T09:20:00+08:00"))).toBe(false); // 集合竞价
    expect(isTradingTime(new Date("2026-11-09T12:00:00+08:00"))).toBe(false); // 午休
    expect(isTradingTime(new Date("2026-11-09T09:30:00+08:00"))).toBe(true);
    expect(isTradingTime(new Date("2026-11-09T14:00:00+08:00"))).toBe(true);

    // 这些时刻都在工作窗口之内，但闸门应当是关的（不需要联网判断交易日）
    for (const at of ["2026-11-09T09:10:00+08:00", "2026-11-09T09:20:00+08:00", "2026-11-09T12:00:00+08:00"]) {
      const gate = await continuousSession(new Date(at));
      expect(gate.open).toBe(false);
      expect(gate.reason).toBeTruthy();
      expect(inTradingWindow(new Date(at))).toBe(true);
    }
  });
});
