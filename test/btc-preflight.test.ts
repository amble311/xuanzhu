import { describe, expect, it } from "vitest";
import type { AccountSnapshot } from "../src/btc/account";
import type { BtcAction } from "../src/btc/actions";
import {
  buildPreflight,
  isProtectiveOrder,
  LIQUIDATION_WARN_PCT,
  liquidationGapPct,
  MAX_PENDING_ORDERS,
} from "../src/btc/preflight";

/**
 * 巡检前置核对：上一轮的动作到底落地了没有，以及持仓有没有裸奔。
 *
 * 这些判断必须在代码里，而不是靠提示词提醒模型「记得看一眼上次的挂单」——
 * 模型每一轮都是新的上下文，没有账本它根本不知道「上次」发生了什么。
 */

function snapshot(partial: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    ok: true,
    updatedAt: "2026-11-04T10:00:00Z",
    wallet: { total: 10_000, available: 8_000, unrealized: 0 },
    positions: [],
    orders: [],
    marginRatio: 10,
    ...partial,
  };
}

function position(overrides: Partial<AccountSnapshot["positions"][number]> = {}) {
  return {
    symbol: "BTCUSDT",
    side: "long" as const,
    qty: 0.01,
    entryPrice: 100_000,
    markPrice: 100_000,
    unrealized: 0,
    roePct: 0,
    leverage: 10,
    liquidationPrice: 90_000,
    ...overrides,
  };
}

function order(overrides: Partial<AccountSnapshot["orders"][number]> = {}) {
  return {
    orderId: 111,
    symbol: "BTCUSDT",
    side: "buy" as const,
    type: "LIMIT",
    price: 95_000,
    qty: 0.01,
    reduceOnly: false,
    stopPrice: 0,
    closePosition: false,
    ...overrides,
  };
}

function openAction(overrides: Partial<BtcAction> = {}): BtcAction {
  return {
    id: "a1",
    ts: "2026-11-04T09:00:00Z",
    kind: "open",
    symbol: "BTCUSDT",
    side: "long",
    qty: 0.01,
    limitPrice: 95_000,
    orderId: 111,
    status: "pending",
    reason: "回踩做多",
    ...overrides,
  };
}

describe("巡检前置核对：上次动作落地", () => {
  it("挂单还在：判定为仍未成交，且不改账本", () => {
    const report = buildPreflight({
      snapshot: snapshot({ orders: [order({ orderId: 111 })] }),
      actions: [openAction()],
    });

    expect(report.settled).toHaveLength(1);
    expect(report.settled[0].text).toContain("仍未成交");
    expect(report.settled[0].status).toBeUndefined();
    expect(report.prompt).toContain("上次动作的落地情况");
  });

  it("挂单消失且出现同向持仓：判定已成交，并要求回写账本", () => {
    const report = buildPreflight({
      snapshot: snapshot({ positions: [position()], orders: [] }),
      actions: [openAction()],
    });

    expect(report.settled[0].status).toBe("filled");
    expect(report.settled[0].text).toContain("已成交");
    expect(report.settled[0].text).toContain("0.01");
  });

  it("挂单消失且没有持仓：判定已撤销，提示可能过期", () => {
    const report = buildPreflight({
      snapshot: snapshot({ positions: [], orders: [] }),
      actions: [openAction()],
    });

    expect(report.settled[0].status).toBe("cancelled");
    expect(report.settled[0].text).toContain("已撤销或过期");
  });

  it("持仓方向与动作相反：不算我们那单成交（可能是手动开的）", () => {
    const report = buildPreflight({
      snapshot: snapshot({ positions: [position({ side: "short" })] }),
      actions: [openAction({ side: "long" })],
    });

    expect(report.settled[0].status).toBe("cancelled");
  });

  it("平仓记录是 pending 时：仓位还在就是没平掉，必须报警", () => {
    const closeAction: BtcAction = {
      id: "c1",
      ts: "2026-11-04T09:30:00Z",
      kind: "close",
      symbol: "BTCUSDT",
      side: "long",
      qty: 0.01,
      orderId: 777,
      status: "pending",
      reason: "平仓",
    };

    const failed = buildPreflight({
      snapshot: snapshot({
        positions: [position()],
        orders: [order({ closePosition: true })],
      }),
      actions: [closeAction],
    });
    expect(failed.hasCritical).toBe(true);
    expect(failed.prompt).toContain("上次平仓没有完成");
    expect(failed.settled[0].status).toBe("unknown");

    const done = buildPreflight({
      snapshot: snapshot({ positions: [], orders: [] }),
      actions: [closeAction],
    });
    expect(done.settled[0].status).toBe("filled");
    expect(done.prompt).toContain("已平仓");
  });

  it("限价单只部分成交时要指出，否则模型会按计划仓位算止损", () => {
    const report = buildPreflight({
      snapshot: snapshot({
        positions: [position({ qty: 0.004 })], // 计划 0.01，只成交 4 成
        // 保护单要给不同 orderId：111 是账本里那笔开仓单本身
        orders: [order({ orderId: 222, closePosition: true })],
      }),
      actions: [openAction({ qty: 0.01 })],
    });

    expect(report.settled[0].status).toBe("filled");
    expect(report.settled[0].text).toContain("部分");
    expect(report.prompt).toContain("只部分成交");
  });

  it("没有账户时明确说不核对，而不是假装核对过", () => {
    const report = buildPreflight({
      snapshot: { ...snapshot(), ok: false, error: "未配置币安凭据" },
      actions: [openAction()],
    });

    expect(report.settled).toHaveLength(0);
    expect(report.prompt).toContain("无法读取账户");
    expect(report.hasCritical).toBe(false);
  });
});

describe("巡检前置核对：风险告警", () => {
  it("有持仓但没有保护单：critical", () => {
    const report = buildPreflight({
      snapshot: snapshot({ positions: [position()], orders: [] }),
      actions: [],
    });

    expect(report.unprotected).toBe(true);
    expect(report.hasCritical).toBe(true);
    expect(report.prompt).toContain("没有任何止损");
  });

  it("挂了止损单就不报警", () => {
    const stop = order({
      orderId: 222,
      type: "STOP_MARKET",
      stopPrice: 95_000,
      closePosition: true,
      reduceOnly: true,
    });
    expect(isProtectiveOrder(stop)).toBe(true);

    const report = buildPreflight({
      snapshot: snapshot({ positions: [position()], orders: [stop] }),
      actions: [],
    });

    expect(report.unprotected).toBe(false);
    expect(report.issues.some((issue) => issue.text.includes("没有任何止损"))).toBe(
      false,
    );
  });

  it("距强平过近（默认 5%）报警", () => {
    const dangerous = position({
      markPrice: 100_000,
      liquidationPrice: 96_000, // 4%
    });
    expect(liquidationGapPct(dangerous)).toBeCloseTo(4, 5);

    const report = buildPreflight({
      snapshot: snapshot({ positions: [dangerous], orders: [order({ closePosition: true })] }),
      actions: [],
    });
    expect(report.hasCritical).toBe(true);
    expect(report.prompt).toContain("距强平仅");

    // 安全距离不报警
    const safe = position({ markPrice: 100_000, liquidationPrice: 80_000 });
    const safeReport = buildPreflight({
      snapshot: snapshot({ positions: [safe], orders: [order({ closePosition: true })] }),
      actions: [],
    });
    expect(safeReport.prompt).not.toContain("距强平仅");
    expect(LIQUIDATION_WARN_PCT).toBe(5);
  });

  it("保证金率过高报警", () => {
    const report = buildPreflight({
      snapshot: snapshot({
        positions: [position()],
        orders: [order({ closePosition: true })],
        marginRatio: 92,
      }),
      actions: [],
    });
    expect(report.hasCritical).toBe(true);
    expect(report.prompt).toContain("保证金率 92.0%");
  });

  it("挂单过多提醒（一起成交会变超仓）", () => {
    const orders = Array.from({ length: MAX_PENDING_ORDERS + 1 }, (_, index) =>
      order({ orderId: 500 + index }),
    );
    const report = buildPreflight({
      snapshot: snapshot({ orders }),
      actions: [],
    });
    expect(report.issues.some((issue) => issue.text.includes("同时挂着"))).toBe(true);
  });

  it("已有持仓还挂着开仓单：提醒这会变成加仓", () => {
    const report = buildPreflight({
      snapshot: snapshot({
        positions: [position()],
        orders: [order({ closePosition: true }), order({ orderId: 111 })],
      }),
      actions: [openAction({ orderId: 111 })],
    });
    expect(report.prompt).toContain("加仓");
  });
});
