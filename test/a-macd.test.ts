import { describe, expect, it } from "vitest";
import { dropIncompleteWeek, macdRising, macdSeries } from "../src/a/macd";
import { intradayBuyReady, intradayWeak } from "../src/a/intraday";
import { computeIndicators } from "../src/a/indicators";
import { scoreDailyDetailed } from "../src/a/score";
import { combineTrend, dailyTrend, monthlyTrend, weeklyTrend } from "../src/a/trend";
import { score15m } from "../src/a/deep15";
import { newsTone } from "../src/a/news";
import type { Bar } from "../src/exchange/ashare";

function bars(closes: number[]): Bar[] {
  return closes.map((close, index) => ({
    time: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000_000,
    amount: close * 1_000_000,
  }));
}

describe("MACD 漏斗", () => {
  it("加速上涨时柱体高于上一周期；转跌后不再回升", () => {
    const up = bars([
      ...Array(55).fill(100),
      101,
      103,
      106,
      110,
      115,
    ]);
    expect(macdRising(up)).toBe(true);

    const down = bars([
      ...Array(55).fill(100),
      115,
      110,
      106,
      103,
      101,
    ]);
    expect(macdRising(down)).toBe(false);
  });

  it("周线剔除未走完的一周，周五收盘后保留", () => {
    const wednesday = bars([100, 101, 102]);
    wednesday[2].time = "2026-11-04"; // 周三
    expect(dropIncompleteWeek(wednesday, new Date("2026-11-06T10:00:00+08:00"))).toHaveLength(2);

    const friday = bars([100, 101, 102]);
    friday[2].time = "2026-11-06"; // 周五
    expect(dropIncompleteWeek(friday, new Date("2026-11-06T16:00:00+08:00"))).toHaveLength(3);
  });

  it("日线 MACD 指标写入缓存字段", () => {
    const closes = Array.from({ length: 60 }, (_, index) => 100 + index);
    const indicators = computeIndicators("600519", bars(closes))!;
    expect(indicators.macdHist).toBeTypeOf("number");
    expect(indicators.macdHistPrev).toBeTypeOf("number");
    expect(macdSeries(bars(closes)).length).toBe(closes.length);
  });

  it("日线详细评分 0–100 且趋势向上时为高分", () => {
    const closes = Array.from({ length: 80 }, (_, index) => 100 + index);
    const indicators = computeIndicators("600519", bars(closes))!;
    const score = scoreDailyDetailed(
      {
        code: "600519",
        name: "贵州茅台",
        price: indicators.close,
        changePct: 1,
        amount: 500_000_000,
        turnoverPct: 5,
        board: "main",
        st: false,
      },
      indicators,
    );
    expect(score).toBeGreaterThan(60);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("30 分钟买卖点", () => {
  it("站上 MA20 + 突破前高 + 放量才算买点", () => {
    const up = bars(Array.from({ length: 30 }, (_, index) => 10 + index * 0.1));
    up[up.length - 1].high = 14;
    up[up.length - 1].close = 14;
    up[up.length - 1].volume = 5_000_000;
    expect(intradayBuyReady(up)).toBe(true);

    const noVolume = up.map((bar) => ({ ...bar }));
    noVolume[noVolume.length - 1].volume = 100_000;
    expect(intradayBuyReady(noVolume)).toBe(false);
  });

  it("跌破 MA20 与前 10 根低点才算日内卖点", () => {
    const down = bars(Array.from({ length: 30 }, (_, index) => 20 - index * 0.2));
    down[down.length - 1].low = 10;
    down[down.length - 1].close = 10;
    expect(intradayWeak(down)).toBe(true);
  });
});

describe("消息面分类", () => {
  it("立案/退市/暴雷算硬风险，减持算负面，回购算正面", () => {
    expect(newsTone("关于收到中国证监会立案告知书的公告")).toBe("hard");
    expect(newsTone("关于公司股票可能被实施退市风险警示的公告")).toBe("hard");
    expect(newsTone("关于持股5%以上股东减持计划的公告")).toBe("negative");
    expect(newsTone("关于回购公司股份的公告")).toBe("positive");
    expect(newsTone("关于召开第三季度业绩说明会的公告")).toBe("neutral");
    expect(newsTone("非经营性资金占用及其他关联资金往来情况汇总表")).toBe("neutral");
    expect(newsTone("防范大股东及关联方资金占用专项制度")).toBe("neutral");
  });
});

describe("三周期趋势与 15m 评分", () => {
  const rising = (count: number, start = 100) =>
    bars(Array.from({ length: count }, (_, index) => start * (1 + index * 0.01)));

  it("月/周线单边上涨判为 +1，反向判为 -1 或 0", () => {
    expect(monthlyTrend(rising(30)).score).toBe(1);
    expect(weeklyTrend(rising(80)).score).toBe(1);
    const falling = bars(Array.from({ length: 30 }, (_, index) => 200 - index * 2));
    expect(monthlyTrend(falling).score).not.toBe(1);
  });

  it("任一周期向下、全 0 或没有 +1 都不通过", () => {
    const up = { score: 1 as const, reason: "" };
    const flat = { score: 0 as const, reason: "" };
    const down = { score: -1 as const, reason: "" };
    expect(combineTrend(up, up, up).pass).toBe(true);
    expect(combineTrend(up, flat, up).pass).toBe(true);
    expect(combineTrend(up, down, up).pass).toBe(false);
    expect(combineTrend(flat, flat, flat).pass).toBe(false);
  });

  it("最短周期（日线）必须与做多方向同向，否则只观望", () => {
    const up = { score: 1 as const, reason: "" };
    const flat = { score: 0 as const, reason: "" };

    // 用户给的例子：月 0 / 周 +1 / 日 0 → 日线没走出来，不做
    const mixed = combineTrend(flat, up, flat);
    expect(mixed.pass).toBe(false);
    expect(mixed.reason).toContain("日线未同向");

    // 月/周再强，日线 0 也不买
    expect(combineTrend(up, up, flat).pass).toBe(false);
    // 日线 +1 时，长周期横盘仍可通过（强度弱，但不拦方向）
    expect(combineTrend(flat, flat, up).pass).toBe(true);
  });

  it("日线 4 项检查多数向上判为 +1", () => {
    const result = dailyTrend({
      code: "600519",
      asOf: "2026-11-11",
      close: 12,
      ma20: 11,
      ma50: 10,
      high20: 12,
      low20: 8,
      rsi14: 55,
      macdHist: 0.2,
      macdHistPrev: 0.1,
      bars: 140,
    } as never);
    expect(result.score).toBe(1);
  });

  it("15 分钟结构/动量向上时得分为正", () => {
    const result = score15m(rising(80));
    expect(result?.score).toBeGreaterThan(0);
  });
});

describe("未完成的 K 线与开盘冷静期", () => {
  const bar = (time: string): { time: string; open: number; high: number; low: number; close: number; volume: number; amount: number } => ({
    time,
    open: 10,
    high: 10.2,
    low: 9.9,
    close: 10.1,
    volume: 100,
    amount: 1010,
  });

  it("剔除正在走的 15m K 线，走完后保留", async () => {
    const { dropIncomplete15m } = await import("../src/a/window");
    const bars = [bar("2026-11-25T09:15:00"), bar("2026-11-25T09:30:00")];
    // 09:35：09:30 这根还没走完 → 剔除
    expect(dropIncomplete15m(bars, new Date("2026-11-25T09:35:00+08:00"))).toHaveLength(1);
    // 09:45：已走完 → 保留
    expect(dropIncomplete15m(bars, new Date("2026-11-25T09:45:00+08:00"))).toHaveLength(2);
    // 不是今天的最后一根（历史数据）→ 不动
    const old = [bar("2026-11-24T14:45:00")];
    expect(dropIncomplete15m(old, new Date("2026-11-25T09:35:00+08:00"))).toHaveLength(1);
  });

  it("剔除本月未走完的月线，月末收盘后保留", async () => {
    const { dropIncompleteMonth } = await import("../src/a/window");
    const bars = [bar("2026-10-01"), bar("2026-11-01")];
    expect(dropIncompleteMonth(bars, new Date("2026-11-25T10:00:00+08:00"))).toHaveLength(1);
    expect(dropIncompleteMonth(bars, new Date("2026-11-30T15:10:00+08:00"))).toHaveLength(2);
    // 历史月份（最后一根不是本月）→ 不动
    const old = [bar("2026-09-01"), bar("2026-10-01")];
    expect(dropIncompleteMonth(old, new Date("2026-11-25T10:00:00+08:00"))).toHaveLength(2);
  });

  it("开盘态势：高开跌破昨收算回补，量比按已交易分钟归一化", async () => {
    const { openingContext } = await import("../src/a/opening");
    const quote = {
      code: "601328",
      name: "交通银行",
      price: 9.95,
      preClose: 10,
      open: 10.2,
      high: 10.25,
      low: 9.9,
      change: -0.05,
      changePct: -0.5,
      volume: 1_000_000,
      amount: 20_000_000,
      board: "main" as const,
      st: false,
    };
    const indicators = {
      code: "601328",
      asOf: "2026-11-24",
      close: 10,
      bars: 140,
      // 近 5 日平均成交额 2.4 亿 → 每分钟 100 万；今天 10 分钟成交 2000 万 → 量比 2.0
      avgAmount5: 240_000_000,
    };
    const opening = openingContext(quote, indicators, new Date("2026-11-25T09:40:00+08:00"));
    expect(opening.gapPct).toBeGreaterThan(1.9);
    expect(opening.fromOpenPct).toBeLessThan(-2);
    expect(opening.gapFilled).toBe(true);
    expect(opening.volumeRatio).toBeCloseTo(2, 1);
    expect(opening.text).toContain("高开");
    expect(opening.text).toContain("回补");
    expect(opening.text).toContain("今日量比 2.00");
  });

  it("开盘态势：低开收复昨收也算回补；未开盘 / 缺行情有明确文案", async () => {
    const { openingContext } = await import("../src/a/opening");
    const lowOpen = {
      code: "601398",
      name: "工商银行",
      price: 10.05,
      preClose: 10,
      open: 9.8,
      high: 10.06,
      low: 9.79,
      change: 0.05,
      changePct: 0.5,
      volume: 100,
      amount: 1000,
      board: "main" as const,
      st: false,
    };
    const filled = openingContext(lowOpen, undefined, new Date("2026-11-25T09:35:00+08:00"));
    expect(filled.gapFilled).toBe(true);
    expect(filled.text).toContain("低开");
    expect(filled.text).toContain("收复昨收");
    // 没有日线指标 → 不编量比
    expect(filled.volumeRatio).toBeUndefined();

    const before = openingContext(lowOpen, undefined, new Date("2026-11-25T09:10:00+08:00"));
    expect(before.elapsedMinutes).toBe(0);
    expect(before.text).toContain("未开盘");

    const missing = openingContext(null, undefined, new Date("2026-11-25T10:00:00+08:00"));
    expect(missing.text).toContain("取不到");
  });
})
