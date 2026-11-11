import { describe, expect, it } from "vitest";
import {
  computeIndicators,
  screenConditionFromInput,
  screenNeedsIndicators,
  screenStocks,
  summarizeSnapshot,
  type Indicators,
  type MarketSnapshot,
  type SnapshotRow,
} from "../src/a";
import type { Bar } from "../src/exchange/ashare";
import { findMode } from "../src/modes";
import { TOOLS, toolVisibleInMode } from "../src/tools";

/**
 * A 股横截面核心：指标、快照聚合、筛选器。
 *
 * 全部离线 —— 筛选口径必须可测试、可复现，否则「今天筛出 12 只」永远对不上。
 */

function bar(index: number, close: number, amount = 100_000_000): Bar {
  const date = new Date(Date.UTC(2026, 8, 1 + index));
  return {
    time: date.toISOString().slice(0, 10),
    open: close,
    high: close * 1.02,
    low: close * 0.98,
    close,
    volume: 1_000_000,
    amount,
  };
}

function row(overrides: Partial<SnapshotRow> & { code: string }): SnapshotRow {
  return {
    name: `股票${overrides.code}`,
    price: 10,
    preClose: 10,
    pct: 0,
    open: 10,
    high: 10,
    low: 10,
    volume: 1_000_000,
    amount: 100_000_000,
    turnoverPct: 3,
    marketCap: 10_000_000_000,
    limitUp: 11,
    limitDown: 9,
    board: "sh-main",
    st: false,
    status: "交易中",
    ...overrides,
  };
}

function snapshot(rows: SnapshotRow[]): MarketSnapshot {
  return {
    asOf: "2026-11-06T07:00:00.000Z",
    quotesAt: "2026-11-06 15:00",
    session: "已收盘",
    universeSize: rows.length,
    failed: 0,
    indices: [],
    rows,
  };
}

function indicators(code: string, overrides: Partial<Indicators> = {}): Indicators {
  return {
    code,
    asOf: "2026-11-06",
    close: 10,
    ma5: 9,
    ma10: 9,
    ma20: 9,
    ma60: 8,
    high20: 10.5,
    high60: 11,
    low20: 8,
    ret5: 2,
    ret20: 10,
    ret60: 20,
    avgAmount5: 100_000_000,
    avgAmount20: 90_000_000,
    bars: 140,
    ...overrides,
  };
}

describe("模式与工具注册", () => {
  it("`xzh a` 已注册为模式，6 个工具只在 a 模式可见", () => {
    const mode = findMode("a");
    expect(mode?.name).toBe("a");
    expect(mode?.cwdLocked).toBe(true);
    expect(mode?.promptSection).toContain("只分析个股");

    const names = TOOLS.filter((tool) => tool.modes?.includes("a")).map((tool) => tool.name);
    expect(names.sort()).toEqual([
      "a_account",
      "a_bars",
      "a_cancel_order",
      "a_clear_risk",
      "a_order",
      "a_orders",
      "a_quote",
      "a_remove_trigger",
      "a_schedule",
      "a_screen",
      "a_select",
      "a_snapshot",
      "a_trigger",
      "a_unschedule",
    ]);
    const screen = TOOLS.find((tool) => tool.name === "a_screen")!;
    expect(toolVisibleInMode(screen, "a")).toBe(true);
    expect(toolVisibleInMode(screen, undefined)).toBe(false);
    expect(toolVisibleInMode(screen, "btc")).toBe(false);
  });
});

describe("指标计算", () => {
  it("均线 / 区间涨幅 / 20 日高按后复权日线计算", () => {
    const bars = Array.from({ length: 70 }, (_, index) => bar(index, 10 + index * 0.1));
    const result = computeIndicators("600519", bars)!;
    expect(result.bars).toBe(70);
    expect(result.asOf).toBe("2026-11-09");
    expect(result.ma5).toBeCloseTo((16.5 + 16.6 + 16.7 + 16.8 + 16.9) / 5);
    expect(result.ma20).toBeDefined();
    expect(result.ma60).toBeDefined();
    // 最后一根 close=16.9，前 20 根之前是 14.9
    expect(result.ret20).toBeCloseTo(((16.9 - 14.9) / 14.9) * 100, 4);
    expect(result.high20).toBeCloseTo(16.9 * 1.02);
  });

  it("不足 60 根时 ma60 / ret60 留空，不用 0 冒充", () => {
    const result = computeIndicators("000001", [bar(0, 10), bar(1, 11)])!;
    expect(result.ma5).toBeUndefined();
    expect(result.ma60).toBeUndefined();
    expect(result.ret5).toBeUndefined();
    expect(result.ret20).toBeUndefined();
  });
});

describe("快照聚合", () => {
  it("涨跌家数、涨跌停、成交额与分布", () => {
    const rows = [
      row({ code: "600001", pct: 2, price: 10.2, amount: 100 }),
      row({ code: "600002", pct: -3, price: 9.7, amount: 200 }),
      row({ code: "600003", pct: 0, price: 10, amount: 300 }),
      row({ code: "600004", pct: 10, price: 11, limitUp: 11, amount: 400 }),
      row({ code: "600005", pct: -10, price: 9, limitDown: 9, amount: 500 }),
      row({ code: "600006", pct: 0, price: 0, status: "停牌", amount: 0 }),
    ];
    const summary = summarizeSnapshot(rows);
    expect(summary.total).toBe(6);
    expect(summary.up).toBe(2);
    expect(summary.down).toBe(2);
    expect(summary.flat).toBe(1); // 停牌（price=0）不计入涨跌
    expect(summary.limitUp).toBe(1);
    expect(summary.limitDown).toBe(1);
    expect(summary.suspended).toBe(1);
    expect(summary.amount).toBe(1500);
    expect(summary.byBoard["sh-main"]).toBe(6);
    const zero = summary.buckets.find((bucket) => bucket.label === "0");
    expect(zero?.count).toBe(1);
    const limitUp = summary.buckets.find((bucket) => bucket.label === ">9.5%");
    expect(limitUp?.count).toBe(1);
  });
});

describe("筛选器", () => {
  const rows = [
    row({ code: "600001", pct: 5, amount: 300_000_000, turnoverPct: 6 }),
    row({ code: "600002", pct: 3, amount: 100_000_000, turnoverPct: 2 }),
    row({ code: "600003", pct: 8, amount: 500_000_000, turnoverPct: 9, board: "gem" }),
    row({ code: "600004", pct: 9, st: true, name: "ST测试" }),
    row({ code: "600005", pct: 4, status: "停牌", price: 0 }),
    row({ code: "600006", pct: 6, amount: 200_000_000, turnoverPct: 7 }),
  ];
  const map = new Map([
    ["600001", indicators("600001")],
    ["600003", indicators("600003", { ma20: 20 })],
    // 600002 缺指标
  ]);

  it("默认排除 ST / 停牌，按涨幅降序", () => {
    const result = screenStocks(snapshot(rows), new Map(), { rankBy: "pct", limit: 10 });
    expect(result.rows.map((item) => item.code)).toEqual(["600003", "600006", "600001", "600002"]);
    expect(result.matched).toBe(4);
  });

  it("成交额 / 换手 / 板块过滤 + 翻页", () => {
    const result = screenStocks(snapshot(rows), new Map(), {
      boards: ["sh-main"],
      amountMin: 150_000_000,
      turnoverMin: 5,
      limit: 1,
      offset: 1,
    });
    // 600006（+6%）与 600001（+5%）满足条件，offset=1 取第二只
    expect(result.matched).toBe(2);
    expect(result.rows.map((item) => item.code)).toEqual(["600001"]);
    expect(result.remaining).toBe(0);
  });

  it("需要指标的条件会跳过缺指标的股票并计数", () => {
    const result = screenStocks(snapshot(rows), map, {
      aboveMa20: true,
      limit: 10,
    });
    // 600001 在 MA20 上方；600003 现价 10 < MA20 20，被排除；600002 缺指标
    expect(result.rows.map((item) => item.code)).toEqual(["600001"]);
    // 600002 与 600006 都没有指标
    expect(result.skippedNoIndicators).toBe(2);
  });

  it("距 20 日高 / 20 日涨幅条件", () => {
    const result = screenStocks(snapshot(rows), map, {
      boards: ["sh-main"],
      nearHigh20Pct: 6,
      ret20Min: 5,
      limit: 10,
    });
    expect(result.rows.map((item) => item.code)).toEqual(["600001"]);
  });

  it("条件归一：snake_case / camelCase 都接受，未知键忽略", () => {
    const condition = screenConditionFromInput({
      pct_min: 3,
      aboveMa20: true,
      boards: ["gem"],
      rank_by: "amount",
      order: "asc",
      limit: 99,
      sql: "drop table",
    });
    expect(condition.pctMin).toBe(3);
    expect(condition.aboveMa20).toBe(true);
    expect(condition.boards).toEqual(["gem"]);
    expect(condition.rankBy).toBe("amount");
    expect(condition.limit).toBe(99); // 上限在 screenStocks 里夹到 50
    expect("sql" in condition).toBe(false);
    expect(screenNeedsIndicators(condition)).toBe(true);
    expect(screenNeedsIndicators({ pctMin: 3 })).toBe(false);
    expect(() => screenConditionFromInput({ boards: ["nasdaq"] })).toThrow(/未知板块/);
  });
});
