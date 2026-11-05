import { describe, expect, it } from "vitest";
import { formatResetMemory, type PaperResetData } from "../src/btc/paper-reset";

/**
 * 模拟盘重置的记忆文案。
 *
 * 这段文字会在下一次对话里被模型读到：只写「已重置」等于没写 —— 它无法区分
 * 「用户主动重置」与「数据丢了」，也不知道重置前亏了多少。所以断言必须覆盖：
 * 谁重置的、清掉多少笔、盈亏多少、原持仓与挂单、资金怎么变化。
 */
describe("模拟盘重置记忆", () => {
  const base: PaperResetData = {
    reset: true,
    capital: 100000,
    at: "2026-11-05T14:30:00Z",
    cleared: {
      trades: 3,
      wins: 1,
      win_rate: 33.33,
      realized_pnl: -1250.3,
      fees_paid: 15,
      open_orders: 1,
      position: { side: "short", qty: 1.2444, entry_price: 80532 },
      cash_before: 50.05,
      initial_capital_before: 100000,
    },
  };

  it("带上前一状态的完整信息与重置来源（命令）", () => {
    const text = formatResetMemory(base, "command");
    expect(text).toContain("/reset moni");
    expect(text).toContain("3 笔已平仓成交");
    expect(text).toContain("胜率 33.33%");
    expect(text).toContain("-1,250.30");
    expect(text).toContain("1 张未成交挂单");
    expect(text).toContain("空 1.2444 @ 80,532.00");
    expect(text).toContain("现金 50.05 → 100,000.00");
    expect(text).toContain("初始资金 100,000.00 → 100,000.00");
    expect(text).toContain("从零开始");
  });

  it("模型代劳时写明是工具调用，不与用户命令混淆", () => {
    expect(formatResetMemory(base, "tool")).toContain("btc_paper_reset");
    expect(formatResetMemory(base, "tool")).not.toContain("/reset moni");
  });

  it("空账本也能读：不出现「0 笔」以外的空话术", () => {
    const empty: PaperResetData = {
      ...base,
      cleared: {
        trades: 0,
        wins: 0,
        win_rate: 0,
        realized_pnl: 0,
        fees_paid: 0,
        open_orders: 0,
        position: null,
        cash_before: 100000,
        initial_capital_before: null,
      },
    };
    const text = formatResetMemory(empty, "command");
    expect(text).toContain("0 笔已平仓成交（此前没有平仓记录）");
    expect(text).toContain("无未成交挂单");
    expect(text).toContain("无持仓");
    // 没记录过初始资金时不要编一个「原初始资金」
    expect(text).not.toContain("初始资金 null");
    expect(text).toContain("现金 100,000.00 → 100,000.00");
  });
});
