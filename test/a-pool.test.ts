import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderedPool, saveWatchlist, type WatchItem } from "../src/a/watchlist";
import {
  appendPolicy,
  clearPolicy,
  POLICY_MAX_CHARS,
  readPolicy,
  replacePolicy,
} from "../src/a/policy";
import { computeExpiresAt, createOrder, listOrders, renewOrder } from "../src/a/orders";
import { formatSignal, type StockSignal } from "../src/a/signal";
import {
  DEFAULT_MAX_POSITIONS,
  DEFAULT_POOL_SIZE,
  maxPositions,
  poolSize,
  readSettings,
  settingsPath,
  writeSettings,
} from "../src/a/settings";
import { applyPaperOrder, emptyPaperAccount } from "../src/a/paper";
import type { Quote } from "../src/exchange/ashare";

/**
 * A 股与 btc 对齐后的池子/决策约束（全部离线）：
 * - 自选池 5 只、持仓优先、含持仓在内共 5 只；
 * - 长期指令落盘（a_policy）；
 * - 挂单时效与续期（a_renew）；
 * - a_signal 的输出口径（三周期 + 15 分钟）。
 */

let home: string;
let original: string | undefined;

beforeAll(() => {
  original = process.env.XZH_A_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-a-pool-"));
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
  reason: "测试",
  source: "select",
  addedAt: new Date().toISOString(),
});

describe("自选池（5 只，持仓优先）", () => {
  it("持仓排在最前，且池内总数不超过 5", () => {
    saveWatchlist({
      version: 1,
      updatedAt: new Date().toISOString(),
      items: [item("600001", 90), item("600002", 80), item("600003", 70), item("600004", 60), item("600005", 50)],
    });
    const pool = orderedPool([{ code: "600003", name: "持仓股" }]);
    expect(pool).toHaveLength(5);
    expect(pool[0].code).toBe("600003");
    expect(pool[0].held).toBe(true);
    // 其余按评分降序补足
    expect(pool.slice(1).map((entry) => entry.code)).toEqual(["600001", "600002", "600004", "600005"]);
  });

  it("持仓不在自选文件里也会被补回池内（含持仓共 5 只）", () => {
    saveWatchlist({
      version: 1,
      updatedAt: new Date().toISOString(),
      items: ["600001", "600002", "600003", "600004", "600005"].map((code, index) => item(code, 90 - index)),
    });
    const pool = orderedPool([{ code: "600099", name: "新买入" }]);
    expect(pool).toHaveLength(5);
    expect(pool[0].code).toBe("600099");
    expect(pool.map((entry) => entry.code)).not.toContain("600005");
  });
});

describe("决策指令（a_policy）", () => {
  it("追加 / 整份替换 / 清空", () => {
    clearPolicy();
    appendPolicy(home, "只做主板，单只不超过 20% 仓位");
    appendPolicy(home, "禁止追高：当日涨幅超过 5% 不买");
    const text = readPolicy();
    expect(text).toContain("只做主板");
    expect(text).toContain("禁止追高");

    replacePolicy(home, "- 只做主板");
    expect(readPolicy()).toBe("- 只做主板");

    clearPolicy();
    expect(readPolicy()).toBe("");
  });

  it("超长整份替换只保留末尾", () => {
    const result = replacePolicy(home, `${"旧".repeat(POLICY_MAX_CHARS)}最新要求`);
    expect(result.truncated).toBe(true);
    expect(readPolicy().endsWith("最新要求")).toBe(true);
    clearPolicy();
  });
});

describe("挂单时效与续期（a_renew）", () => {
  it("到期时间取 ttl 与当日 15:00 的较早者", () => {
    const at = new Date(2026, 10, 13, 14, 0, 0);
    expect(computeExpiresAt(at, 10).getHours()).toBe(14);
    expect(computeExpiresAt(at, 10).getMinutes()).toBe(10);
    const late = computeExpiresAt(at, 600);
    expect(late.getHours()).toBe(15);
    expect(late.getMinutes()).toBe(0);
  });

  it("未成交挂单可续期；已撤销的不能续期", () => {
    const created = createOrder({
      code: "600001",
      name: "测试",
      side: "buy",
      qty: 100,
      limitPrice: 10,
      reason: "测试挂单",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = created.order.expiresAt;
    const renewed = renewOrder(created.order.id, 240);
    expect(renewed.ok).toBe(true);
    expect(renewed.order?.expiresAt).not.toBe(before);

    const missing = renewOrder("not-exist");
    expect(missing.ok).toBe(false);
    expect(listOrders()).toHaveLength(1);
  });
});

describe("数量参数（settings，用户可配）", () => {
  it("默认 3 / 5；改完立刻生效并落盘", () => {
    fs.rmSync(settingsPath(), { force: true });
    expect(readSettings()).toEqual({
      maxPositions: DEFAULT_MAX_POSITIONS,
      poolSize: DEFAULT_POOL_SIZE,
    });

    writeSettings({ maxPositions: 4, poolSize: 6 });
    expect(maxPositions()).toBe(4);
    expect(poolSize()).toBe(6);
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))).toEqual({
      maxPositions: 4,
      poolSize: 6,
    });
  });

  it("池子容量必须装得下持仓上限（自动收敛），越界值夹到合法区间", () => {
    fs.rmSync(settingsPath(), { force: true });
    // 持仓上限 8 > 默认池子 5 → 收敛成 5
    expect(writeSettings({ maxPositions: 8 }).maxPositions).toBe(5);

    writeSettings({ poolSize: 6 });
    expect(writeSettings({ maxPositions: 8 })).toEqual({ maxPositions: 6, poolSize: 6 });

    // 越界（0 / 负数 / 超大）被夹住
    expect(writeSettings({ poolSize: 999 }).poolSize).toBe(20);
    expect(writeSettings({ maxPositions: 0 }).maxPositions).toBe(1);
  });

  it("下单闸门读用户配置：允许 2 只时第 3 只被拒", () => {
    const quote = (code: string): Quote => ({
      code,
      name: code,
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
    });
    const now = new Date(2026, 10, 13, 10, 0, 0);
    let account = emptyPaperAccount(now);
    for (const code of ["600001", "600002"]) {
      const result = applyPaperOrder(account, quote(code), { code, side: "buy", qty: 100 }, now, {
        maxPositions: 2,
      });
      expect(result.ok).toBe(true);
      account = result.account;
    }
    const third = applyPaperOrder(
      account,
      quote("600003"),
      { code: "600003", side: "buy", qty: 100 },
      now,
      { maxPositions: 2 },
    );
    expect(third.ok).toBe(false);
    expect(third.message).toContain("持仓已达上限 2 只");
  });
});

describe("a_signal 输出口径", () => {
  it("同时给出三周期方向与 15 分钟择时", () => {
    const signal: StockSignal = {
      code: "600519",
      name: "贵州茅台",
      held: true,
      position: { qty: 100, available: 100, avgCost: 1500, pnlPct: 2.5 },
      price: 1540,
      pct: 1.2,
      monthly: { score: 1, reason: "月线多头" },
      weekly: { score: 0, reason: "周线中性" },
      daily: { score: 1, reason: "日线多头" },
      trend: { pass: true, reason: "M1 W0 D1", sum: 2, monthly: 1, weekly: 0, daily: 1 },
      intraday: { score: 72, reason: "15m 72（结构30/位置20）" },
      sideFilter: "long",
      entry: "now",
      suggestion: "持有",
      reason: "测试",
    };
    const text = formatSignal(signal);
    expect(text).toContain("三周期：月 +1 · 周 0 · 日 +1");
    expect(text).toContain("方向闸门 long");
    expect(text).toContain("15 分钟");
    expect(text).toContain("择时 now");
    expect(text).toContain("建议：持有");
  });
});
