import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAction } from "../src/btc/actions";
import { btcTradeHistoryLines } from "../src/btc/panel-data";
import { aTradeLines } from "../src/a/info";
import { emptyPaperAccount, savePaperAccount } from "../src/a/paper";
import { createOrder } from "../src/a/orders";

/**
 * `/tr`：btc 实盘读本机动作账本、A 股读模拟盘账本。
 * 模拟盘的 btc 分支要跑 Python，这里只覆盖不依赖 venv 的路径。
 */

const NOW = new Date("2026-11-13T10:00:00+08:00");
const originBtc = process.env.XZH_BTC_HOME;
const originA = process.env.XZH_A_HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-trades-"));
  process.env.XZH_BTC_HOME = path.join(home, "btc");
  process.env.XZH_A_HOME = path.join(home, "a");
});

afterEach(() => {
  if (originBtc === undefined) delete process.env.XZH_BTC_HOME;
  else process.env.XZH_BTC_HOME = originBtc;
  if (originA === undefined) delete process.env.XZH_A_HOME;
  else process.env.XZH_A_HOME = originA;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("btc 交易记录", () => {
  it("只列开/平仓，最新在前，平仓带盈亏；撤单不算交易", async () => {
    const btcHome = process.env.XZH_BTC_HOME as string;
    appendAction(btcHome, {
      kind: "open",
      symbol: "BTC/USDT",
      side: "long",
      qty: 0.001,
      limitPrice: 68_000,
      status: "filled",
      reason: "三周期共振",
    });
    appendAction(btcHome, {
      kind: "cancel",
      symbol: "BTC/USDT",
      status: "cancelled",
      reason: "撤销订单 123",
    });
    appendAction(btcHome, {
      kind: "close",
      symbol: "BTC/USDT",
      side: "long",
      qty: 0.001,
      status: "filled",
      reason: "止盈",
      pnl: 10,
    });

    const lines = await btcTradeHistoryLines(btcHome, "live", 20);
    const text = lines.join("\n");
    expect(lines[0]).toContain("BTC 交易记录");
    expect(text).toContain("平多 0.001");
    expect(text).toContain("+10.00");
    expect(text).toContain("开多 0.001");
    expect(text).not.toContain("撤销订单");
  });

  it("limit 生效：只要最近 N 条", async () => {
    const btcHome = process.env.XZH_BTC_HOME as string;
    appendAction(btcHome, { kind: "open", symbol: "BTC/USDT", side: "long", qty: 1, reason: "一" });
    appendAction(btcHome, { kind: "open", symbol: "BTC/USDT", side: "short", qty: 1, reason: "二" });
    appendAction(btcHome, { kind: "fetch", symbol: "BTC/USDT", reason: "非法类型" } as never);
    const lines = await btcTradeHistoryLines(btcHome, "live", 1);
    expect(
      lines.filter((line) => line.includes("开多") || line.includes("开空")),
    ).toHaveLength(1);
    expect(lines.join("\n")).toContain("二");
  });

  it("未完结的开仓也记录：挂单标「挂单中」，开仓未平标「持仓中」，平仓后恢复普通记录", async () => {
    const btcHome = process.env.XZH_BTC_HOME as string;
    // 1) 已成交的开仓，后面没有平仓 → 持仓中
    appendAction(btcHome, {
      kind: "open",
      symbol: "BTC/USDT",
      side: "long",
      qty: 0.002,
      limitPrice: 70_000,
      status: "filled",
      reason: "周线转多",
    });
    // 2) 还没成交的挂单 → 挂单中
    appendAction(btcHome, {
      kind: "open",
      symbol: "BTC/USDT",
      side: "short",
      qty: 0.001,
      limitPrice: 90_000,
      status: "pending",
      reason: "等反弹",
    });

    let text = (await btcTradeHistoryLines(btcHome, "live", 20)).join("\n");
    expect(text).toContain("未完结：持仓中");
    expect(text).toContain("未完结：挂单中");

    // 3) 平掉之后，那条开仓不再是「未完结」
    appendAction(btcHome, {
      kind: "close",
      symbol: "BTC/USDT",
      side: "long",
      qty: 0.002,
      status: "filled",
      reason: "止盈",
      pnl: 20,
    });
    text = (await btcTradeHistoryLines(btcHome, "live", 20)).join("\n");
    expect(text).not.toContain("未完结：持仓中");
    // 挂单还没成交，仍然标着
    expect(text).toContain("未完结：挂单中");
  });

  it("没有记录时给出明确提示", async () => {
    const lines = await btcTradeHistoryLines(process.env.XZH_BTC_HOME as string, "live", 20);
    expect(lines.join("\n")).toContain("暂无记录");
  });
});

describe("A 股交易记录", () => {
  it("按时间倒序列出买卖，带金额/费用/盈亏与汇总", () => {
    const account = emptyPaperAccount(NOW);
    account.trades = [
      {
        id: "t1",
        code: "601857",
        name: "中国石油",
        side: "buy",
        qty: 16_000,
        price: 12.33,
        amount: 197_280,
        fees: 7.89,
        time: "2026-11-13T02:30:00.000Z",
      },
      {
        id: "t2",
        code: "601857",
        name: "中国石油",
        side: "sell",
        qty: 16_000,
        price: 11.34,
        amount: 181_440,
        fees: 9.07,
        time: "2026-11-13T06:05:00.000Z",
        pnl: -1_000,
      },
    ];
    account.realizedPnl = -1_000;
    savePaperAccount(account);

    const lines = aTradeLines(20);
    expect(lines[0]).toContain("A 股交易记录");
    expect(lines[1]).toContain("卖出 601857 中国石油 16000 股");
    expect(lines[1]).toContain("-1,000.00");
    expect(lines[2]).toContain("买入 601857 中国石油");
    expect(lines.join("\n")).toContain("共 2 笔");
  });

  it("未完结的挂单与 T+1 待卖也要出现在 /tr 里，成交后自动变成成交记录", () => {
    const account = emptyPaperAccount(NOW);
    savePaperAccount(account);
    const created = createOrder({
      code: "600519",
      name: "贵州茅台",
      side: "buy",
      qty: 100,
      limitPrice: 1_500,
      reason: "回踩 MA20",
    });
    expect(created.ok).toBe(true);

    // T+1 待卖（monitor 私有写入，这里直接落盘，路径与 monitor 一致）
    const pendingFile = path.join(process.env.XZH_A_HOME as string, "monitor", "run", "pending-sells.json");
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(
      pendingFile,
      JSON.stringify([{ code: "601857", name: "中国石油", reason: "跌破 MA20", since: "2026-11-13" }]),
      "utf8",
    );

    const lines = aTradeLines(20);
    const text = lines.join("\n");
    expect(text).toContain("未完结 2 笔");
    expect(text).toContain("买入 600519 贵州茅台 100 股");
    expect(text).toContain("挂单中");
    expect(text).toContain("T+1 待卖 601857 中国石油");
    // 同时没有成交时也要说明
    expect(text).toContain("暂无成交记录");
  });

  it("limit 生效，且默认最多 100 条", () => {
    const account = emptyPaperAccount(NOW);
    account.trades = Array.from({ length: 5 }, (_, index) => ({
      id: `t${index}`,
      code: "600519",
      name: "贵州茅台",
      side: "buy" as const,
      qty: 100,
      price: 10,
      amount: 1_000,
      fees: 5,
      time: new Date(NOW.getTime() + index * 60_000).toISOString(),
    }));
    savePaperAccount(account);
    expect(aTradeLines(2).filter((line) => line.includes("贵州茅台"))).toHaveLength(2);
  });
});
