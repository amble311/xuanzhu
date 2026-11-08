import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountSummary,
  applyPaperOrder,
  emptyPaperAccount,
  loadPaperAccount,
  markPaperAccount,
  savePaperAccount,
  tradingFees,
} from "../src/a/paper";
import type { Quote } from "../src/exchange/ashare";

/** A 股模拟盘：费用 / 整手 / 涨跌停 / T+1 / 重估。全部离线。 */

const NOW = new Date("2026-11-06T10:00:00+08:00");

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    code: "600519",
    name: "贵州茅台",
    price: 10,
    preClose: 10,
    open: 10,
    high: 10,
    low: 10,
    change: 0,
    changePct: 0,
    volume: 1_000_000,
    amount: 10_000_000,
    limitUp: 11,
    limitDown: 9,
    board: "sh-main",
    st: false,
    stockStatus: "交易中",
    ...overrides,
  };
}

describe("模拟盘费用", () => {
  it("买入不收印花税，佣金最低 5 元", () => {
    const buy = tradingFees("buy", 1_000);
    expect(buy.commission).toBe(5);
    expect(buy.stamp).toBe(0);
    expect(buy.total).toBeCloseTo(5 + 0.01, 2);

    const sell = tradingFees("sell", 100_000);
    expect(sell.commission).toBe(25);
    expect(sell.stamp).toBe(50);
    expect(sell.total).toBeCloseTo(76, 2);
  });
});

describe("模拟盘撮合", () => {
  it("买入 100 股：现金扣款、持仓 T+1 不可卖", () => {
    const account = emptyPaperAccount(NOW);
    const result = applyPaperOrder(account, quote(), { code: "600519", side: "buy", qty: 100 }, NOW);
    expect(result.ok).toBe(true);
    const position = result.account.positions[0];
    expect(position.qty).toBe(100);
    expect(position.available).toBe(0); // 当日买入不可卖
    expect(position.avgCost).toBe(10);
    expect(result.account.cash).toBeCloseTo(1_000_000 - 1000 - 5.01, 2);
    expect(result.account.trades).toHaveLength(1);
  });

  it("买入非 100 股整数倍直接拒绝", () => {
    const result = applyPaperOrder(
      emptyPaperAccount(NOW),
      quote(),
      { code: "600519", side: "buy", qty: 150 },
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("100 股");
  });

  it("涨停不买、跌停不卖", () => {
    const buy = applyPaperOrder(
      emptyPaperAccount(NOW),
      quote({ price: 11, limitUp: 11 }),
      { code: "600519", side: "buy", qty: 100 },
      NOW,
    );
    expect(buy.ok).toBe(false);
    expect(buy.message).toContain("涨停");

    const account = emptyPaperAccount(NOW);
    account.positions.push({
      code: "600519",
      name: "贵州茅台",
      qty: 100,
      available: 100,
      avgCost: 10,
      lastPrice: 10,
      marketValue: 1000,
      pnl: 0,
      pnlPct: 0,
    });
    const sell = applyPaperOrder(
      account,
      quote({ price: 9, limitDown: 9 }),
      { code: "600519", side: "sell", qty: 100 },
      NOW,
    );
    expect(sell.ok).toBe(false);
    expect(sell.message).toContain("跌停");
  });

  it("可卖不足 / 零股非清仓 拒绝", () => {
    const account = emptyPaperAccount(NOW);
    account.positions.push({
      code: "600519",
      name: "贵州茅台",
      qty: 200,
      available: 100,
      avgCost: 10,
      lastPrice: 10,
      marketValue: 2000,
      pnl: 0,
      pnlPct: 0,
    });
    const tooMuch = applyPaperOrder(
      account,
      quote(),
      { code: "600519", side: "sell", qty: 200 },
      NOW,
    );
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.message).toContain("T+1");

    const odd = applyPaperOrder(
      account,
      quote(),
      { code: "600519", side: "sell", qty: 50 },
      NOW,
    );
    expect(odd.ok).toBe(false);
    expect(odd.message).toContain("零股");
  });

  it("限价不穿越现价时拒绝；穿越时按更优价成交", () => {
    const account = emptyPaperAccount(NOW);
    const noFill = applyPaperOrder(
      account,
      quote({ price: 10 }),
      { code: "600519", side: "buy", qty: 100, price: 9.5 },
      NOW,
    );
    expect(noFill.ok).toBe(false);

    const fill = applyPaperOrder(
      account,
      quote({ price: 10 }),
      { code: "600519", side: "buy", qty: 100, price: 10.5 },
      NOW,
    );
    expect(fill.ok).toBe(true);
    expect(fill.trade?.price).toBe(10);
  });

  it("现金不足拒绝", () => {
    const account = emptyPaperAccount(NOW);
    account.cash = 500;
    const result = applyPaperOrder(account, quote(), { code: "600519", side: "buy", qty: 100 }, NOW);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("资金不足");
  });

  it("重估后市值 / 盈亏按最新价更新", () => {
    const account = emptyPaperAccount(NOW);
    const bought = applyPaperOrder(account, quote(), { code: "600519", side: "buy", qty: 100 }, NOW).account;
    const marked = markPaperAccount(bought, new Map([["600519", quote({ price: 12 })]]));
    expect(marked.positions[0].lastPrice).toBe(12);
    expect(marked.positions[0].marketValue).toBe(1200);
    expect(accountSummary(marked).totalPnl).toBeCloseTo(200 - 5.01, 2);
  });
});

describe("T+1 跨日", () => {
  let home: string;
  const original = process.env.XZH_A_HOME;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-a-paper-"));
    process.env.XZH_A_HOME = home;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.XZH_A_HOME;
    else process.env.XZH_A_HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("隔日加载时昨日买入变为可卖", () => {
    const bought = applyPaperOrder(
      emptyPaperAccount(NOW),
      quote(),
      { code: "600519", side: "buy", qty: 100 },
      NOW,
    ).account;
    expect(bought.positions[0].available).toBe(0);
    savePaperAccount(bought);

    const nextDay = loadPaperAccount(new Date("2026-11-07T09:30:00+08:00"));
    expect(nextDay.positions[0].available).toBe(100);

    const sell = applyPaperOrder(
      nextDay,
      quote({ price: 10.5 }),
      { code: "600519", side: "sell", qty: 100 },
      new Date("2026-11-07T09:31:00+08:00"),
    );
    expect(sell.ok).toBe(true);
    expect(sell.account.positions).toHaveLength(0);
  });
});
