import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { selectionNeed } from "../src/a/score";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A_MONITOR_INTERVALS, inTradingWindow, shouldSell } from "../src/a/monitor";
import {
  MARKET_HEALTH_INTERVAL_MS,
} from "../src/btc/market-health";
import { ORDER_TTL_CHECK_INTERVAL_MS } from "../src/btc/order-ttl";
import { TRIGGER_EVAL_INTERVAL_MS } from "../src/btc/triggers";
import { DEFAULT_CHECK_MINUTES } from "../src/btc/schedule";
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

describe("收盘选股口径（池子含持仓）", () => {
  it("只补「池子容量 − 持仓数」，满仓为 0", () => {
    expect(selectionNeed(5, 0)).toBe(5);
    expect(selectionNeed(5, 2)).toBe(3);
    expect(selectionNeed(5, 5)).toBe(0);
    expect(selectionNeed(5, 7)).toBe(0);
    expect(selectionNeed(5, -1)).toBe(5);
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

  it("持仓强制保留，其余按分数取前 5（池内合计 5 只）", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => item(`6000${index}`, 100 - index));
    const merged = mergeWatchlist(candidates, [{ code: "600010", name: "持仓" }]);
    expect(merged.items).toHaveLength(5);
    expect(merged.items[0].code).toBe("600010");
    expect(merged.items[0].source).toBe("held");
  });

  it("持仓不在候选里也会被补进来", () => {
    const merged = mergeWatchlist([item("600001", 80)], [{ code: "600002", name: "持仓" }]);
    expect(merged.items.map((entry) => entry.code)).toEqual(["600002", "600001"]);
  });

  it("持仓不能删除；非持仓可删除；最多 5 只", () => {
    saveWatchlist(mergeWatchlist([item("600001", 90), item("600002", 80)], []));
    expect(removeWatchItem("600001", new Set(["600001"])).ok).toBe(false);
    expect(removeWatchItem("600002", new Set(["600001"])).ok).toBe(true);

    saveWatchlist({ version: 1, updatedAt: new Date().toISOString(), items: Array.from({ length: 5 }, (_, index) => item(`6000${index}`, 90)) });
    expect(addWatchItem(item("600099", 70)).ok).toBe(false);
    expect(loadWatchlist().items).toHaveLength(5);
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

  it("只在交易日 09:30–11:30 / 13:00–15:00 运行（集合竞价 / 午休 / 收盘后都不算）", () => {
    expect(inTradingWindow(new Date("2026-11-09T09:30:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-09T10:00:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-09T11:30:00+08:00"))).toBe(true); // 上午收盘那一分钟数据完整
    expect(inTradingWindow(new Date("2026-11-09T13:00:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-09T14:00:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-09T15:00:00+08:00"))).toBe(true); // 尾盘收盘
    // 09:15–09:25 集合竞价、09:25–09:30 撮合间隔：一律不算
    expect(inTradingWindow(new Date("2026-11-09T09:00:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T09:15:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T09:26:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T09:29:00+08:00"))).toBe(false);
    // 午休与收盘后：价格冻结，不巡检
    expect(inTradingWindow(new Date("2026-11-09T12:00:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T12:59:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T15:20:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T15:31:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T20:00:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-08T10:00:00+08:00"))).toBe(false);
  });

  it("撮合闸门比工作窗口更严：还要当天是交易日", async () => {
    expect(isTradingTime(new Date("2026-11-09T09:10:00+08:00"))).toBe(false); // 盘前
    expect(isTradingTime(new Date("2026-11-09T09:20:00+08:00"))).toBe(false); // 集合竞价
    expect(isTradingTime(new Date("2026-11-09T12:00:00+08:00"))).toBe(false); // 午休
    expect(isTradingTime(new Date("2026-11-09T09:30:00+08:00"))).toBe(true);
    expect(isTradingTime(new Date("2026-11-09T14:00:00+08:00"))).toBe(true);

    // 集合竞价 / 午休：既不在工作窗口，闸门也关着
    for (const at of [
      "2026-11-09T09:10:00+08:00",
      "2026-11-09T09:20:00+08:00",
      "2026-11-09T12:00:00+08:00",
    ]) {
      const gate = await continuousSession(new Date(at));
      expect(gate.open).toBe(false);
      expect(gate.reason).toBeTruthy();
      expect(inTradingWindow(new Date(at))).toBe(false);
    }
  });
});

describe("A 股监控节奏与 btc moni 对齐", () => {
  it("tick / 规则 / 挂单时效 / 行情健康 / 兜底 全部同 btc", () => {
    // tick：btc moni 是 60 秒
    expect(A_MONITOR_INTERVALS.tickMs).toBe(60_000);
    // 三个 5 分钟节流：直接引用 btc 的常量，避免两边各改一份
    expect(A_MONITOR_INTERVALS.ruleMs).toBe(TRIGGER_EVAL_INTERVAL_MS);
    expect(A_MONITOR_INTERVALS.orderTtlMs).toBe(ORDER_TTL_CHECK_INTERVAL_MS);
    expect(A_MONITOR_INTERVALS.marketHealthMs).toBe(MARKET_HEALTH_INTERVAL_MS);
    // 数据同步 15 分钟（btc DEFAULT_SYNC_INTERVAL_MIN）
    expect(A_MONITOR_INTERVALS.syncMs).toBe(15 * 60_000);
    // 队列空兜底 60 分钟（btc DEFAULT_CHECK_MINUTES）
    expect(A_MONITOR_INTERVALS.fallbackMs).toBe(DEFAULT_CHECK_MINUTES * 60_000);
    // 监控叫醒限流：10 分钟最多 2 次
    expect(A_MONITOR_INTERVALS.wakeWindowMs).toBe(10 * 60_000);
    expect(A_MONITOR_INTERVALS.wakeLimit).toBe(2);
  });
});
