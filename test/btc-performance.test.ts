import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAction } from "../src/btc/actions";
import {
  consecutiveLosses,
  dailyLossPct,
  dailyPath,
} from "../src/btc/performance";

/**
 * 绩效输入：连亏次数与当日亏损基准。
 *
 * 这两个数是硬性风控的另外两只眼睛 —— 只看「单仓亏 50%」会漏掉
 * 「连续小亏把账户磨穿」这种更常见的失败方式。
 */
describe("绩效统计", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "xzh-btc-perf-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const closeWith = (pnl: number) =>
    appendAction(home, {
      kind: "close",
      symbol: "BTCUSDT",
      side: "long",
      qty: 0.01,
      status: "filled",
      reason: "平仓",
      pnl,
    });

  it("从最近往前数连续亏损，遇盈即停", () => {
    expect(consecutiveLosses(home)).toBe(0);

    closeWith(-10);
    closeWith(-20);
    expect(consecutiveLosses(home)).toBe(2);

    closeWith(5); // 盈利一笔，连亏归零
    expect(consecutiveLosses(home)).toBe(0);

    closeWith(-1);
    closeWith(-2);
    closeWith(-3);
    expect(consecutiveLosses(home)).toBe(3);
  });

  it("没有盈亏记录的动作（开仓/撤单）不参与统计", () => {
    appendAction(home, {
      kind: "open",
      symbol: "BTCUSDT",
      status: "filled",
      reason: "开仓",
    });
    appendAction(home, {
      kind: "cancel",
      symbol: "BTCUSDT",
      status: "cancelled",
      reason: "撤单",
    });
    expect(consecutiveLosses(home)).toBe(0);
  });

  it("当日亏损：首次用当前权益建立基准，之后按它算回撤", () => {
    expect(dailyLossPct(10_000, home)).toBe(0);
    // 权益跌到 9400 → 亏 6%
    expect(dailyLossPct(9_400, home)).toBeCloseTo(6, 5);
    // 涨回去 → 负数（盈利）
    expect(dailyLossPct(10_600, home)).toBeCloseTo(-6, 5);

    const baseline = JSON.parse(fs.readFileSync(dailyPath(home), "utf8"));
    expect(baseline.startEquity).toBe(10_000);
    expect(typeof baseline.date).toBe("string");
  });

  it("跨天会重建基准（昨天的亏损不算今天的）", () => {
    dailyLossPct(10_000, home);
    // 手动把基准改成昨天
    const file = dailyPath(home);
    const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      JSON.stringify({ ...baseline, date: "2000-01-01", startEquity: 5_000 }),
    );

    expect(dailyLossPct(9_000, home)).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).startEquity).toBe(9_000);
  });

  it("权益无效时不返回数字（避免把 0 当成亏损 100%）", () => {
    expect(dailyLossPct(0, home)).toBeUndefined();
    expect(dailyLossPct(-5, home)).toBeUndefined();
  });
});
