import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inTradingWindow, shouldSell } from "../src/a/monitor";
import { scoreCandidate } from "../src/a/score";
import {
  addWatchItem,
  loadWatchlist,
  mergeWatchlist,
  removeWatchItem,
  saveWatchlist,
  type WatchItem,
} from "../src/a/watchlist";
import type { Quote } from "../src/exchange/ashare";
import type { Bar } from "../src/exchange/ashare";
import type { Indicators } from "../src/a/indicators";
import type { SnapshotRow } from "../src/a/snapshot";

/** A 股巡检：股池不变量、打分方向、T+1 卖点、盘中窗口。全部离线。 */

function bar(index: number, close: number): Bar {
  return {
    time: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000_000,
  };
}

function rising(count: number, start = 10): Bar[] {
  return Array.from({ length: count }, (_, index) => bar(index, start + index * 0.2));
}

function falling(count: number, start = 20): Bar[] {
  return Array.from({ length: count }, (_, index) => bar(index, start - index * 0.2));
}

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

describe("选股打分", () => {
  it("月/周/日/1h 同向向上时得分显著高于下跌趋势", () => {
    const up = scoreCandidate(row(), indicators, rising(30), rising(30), rising(30));
    const down = scoreCandidate(row(), { ...indicators, close: 8, ma5: 9, ma20: 10, ret20: -20 }, falling(30), falling(30), falling(30));
    expect(up.score.total).toBeGreaterThanOrEqual(70);
    expect(up.score.total).toBeGreaterThan(down.score.total);
  });

  it("K 线不足时不给该周期分，并标注原因", () => {
    const result = scoreCandidate(row(), indicators, rising(5), rising(5), rising(5));
    expect(result.score.weekly).toBe(0);
    expect(result.score.monthly).toBe(0);
    expect(result.score.hourly).toBe(0);
    expect(result.reason).toContain("周线不足");
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

  it("T+1 当日买入不卖；止损 / 止盈 / 跌破 MA20 触发", () => {
    expect(shouldSell({ ...position, available: 0 }, { ...quote, price: 8 })).toBeNull();
    expect(shouldSell(position, { ...quote, price: 9 })).toContain("止损");
    expect(shouldSell(position, { ...quote, price: 12 })).toContain("止盈");
    expect(shouldSell(position, { ...quote, price: 9.5 }, 10)).toContain("MA20");
  });

  it("只在工作日盘中窗口运行", () => {
    expect(inTradingWindow(new Date("2026-11-09T10:00:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-09T12:00:00+08:00"))).toBe(false);
    expect(inTradingWindow(new Date("2026-11-09T14:00:00+08:00"))).toBe(true);
    expect(inTradingWindow(new Date("2026-11-08T10:00:00+08:00"))).toBe(false);
  });
});
