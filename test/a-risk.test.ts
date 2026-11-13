import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyPaperAccount, type PaperAccount } from "../src/a/paper";
import {
  buyBlockReason,
  checkAccountRisk,
  clearRiskTrigger,
  readRiskState,
  riskSummaryLines,
} from "../src/a/risk";
import type { Quote } from "../src/exchange/ashare";

/**
 * A 股硬风控的作用域：单票亏损只锁那一只，账户级（当日亏损 / 连亏）才全禁。
 * 2026-11-13 的回归：曾经一个布尔 `triggered` 让一只票 -8% 锁死整个账户。
 */

const NOW = new Date("2026-11-13T10:00:00+08:00");

let home: string;
const origin = process.env.XZH_A_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-a-risk-"));
  process.env.XZH_A_HOME = home;
});

afterEach(() => {
  if (origin === undefined) delete process.env.XZH_A_HOME;
  else process.env.XZH_A_HOME = origin;
  fs.rmSync(home, { recursive: true, force: true });
});

function quote(overrides: Partial<Quote>): Quote {
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

function account(): PaperAccount {
  const value = emptyPaperAccount(NOW);
  value.cash = 400_000;
  value.positions = [
    {
      code: "601857",
      name: "中国石油",
      qty: 16_000,
      available: 0,
      avgCost: 12.33,
      lastPrice: 12.33,
      marketValue: 197_280,
      pnl: 0,
      pnlPct: 0,
    },
    {
      code: "300006",
      name: "莱美药业",
      qty: 16_000,
      available: 0,
      avgCost: 12.42,
      lastPrice: 12.42,
      marketValue: 198_720,
      pnl: 0,
      pnlPct: 0,
    },
  ];
  return value;
}

function quotes(petro: number, lemei = 12.42): Map<string, Quote> {
  return new Map([
    ["601857", quote({ code: "601857", name: "中国石油", price: petro })],
    ["300006", quote({ code: "300006", name: "莱美药业", price: lemei })],
  ]);
}

describe("A 股硬风控作用域", () => {
  it("单票亏损只锁该股票，其他股票照常可以买", () => {
    // 12.33 → 11.34 ≈ -8.03%，超过单票 8% 阈值
    const evaluation = checkAccountRisk(account(), quotes(11.34), NOW);
    expect(evaluation.triggered).toBe(false);
    expect(evaluation.locks.map((lock) => lock.code)).toEqual(["601857"]);

    const state = readRiskState();
    expect(state?.triggered).toBe(false);
    expect(state?.locks).toHaveLength(1);

    expect(buyBlockReason("601857")).toContain("单票硬风控");
    expect(buyBlockReason("300006")).toBeNull();
    expect(riskSummaryLines()).toEqual([expect.stringContaining("601857")]);
  });

  it("账户级（当日亏损）才禁止所有买入", () => {
    // 当日基准 82 万，现权益约 76.4 万 → 当日亏损超过 3%
    const dir = path.join(home, "monitor", "run");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "risk-state.json"),
      JSON.stringify({
        date: "2026-11-13",
        dayStartEquity: 820_000,
        triggered: false,
        reasons: [],
        locks: [],
        delivered: false,
      }),
      "utf8",
    );
    const evaluation = checkAccountRisk(account(), quotes(11.34, 11.43), NOW);
    expect(evaluation.triggered).toBe(true);
    expect(evaluation.reasons.some((reason) => reason.includes("当日亏损"))).toBe(true);
    expect(buyBlockReason("300006")).toContain("账户级硬风控");
    expect(buyBlockReason("601857")).toContain("账户级硬风控");
  });

  it("同日保留单票锁；只解除指定的那一只", () => {
    checkAccountRisk(account(), quotes(11.34), NOW);
    // 价格反弹也不自动解锁（当日锁仓，避免同一只票当天反复进出）
    checkAccountRisk(account(), quotes(12.33), NOW);
    expect(readRiskState()?.locks.map((lock) => lock.code)).toEqual(["601857"]);

    expect(clearRiskTrigger("300006")).toBe(0);
    expect(clearRiskTrigger("601857")).toBe(1);
    expect(readRiskState()?.locks).toHaveLength(0);
    expect(buyBlockReason("601857")).toBeNull();
  });

  it("旧状态文件里把「单票亏损」记成账户级时，迁移为未触发（下一轮重算具体代码）", () => {
    const dir = path.join(home, "monitor", "run");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "risk-state.json"),
      JSON.stringify({
        date: "2026-11-13",
        triggered: true,
        reasons: ["单票亏损 -8.05% ≤ -8%"],
        delivered: true,
      }),
      "utf8",
    );
    const state = readRiskState();
    expect(state?.triggered).toBe(false);
    expect(state?.reasons).toEqual([]);
    expect(state?.locks).toEqual([]);
    expect(buyBlockReason("300006")).toBeNull();
  });
});
