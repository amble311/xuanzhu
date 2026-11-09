import { describe, expect, it } from "vitest";
import { dropIncompleteWeek, macdRising, macdSeries } from "../src/a/macd";
import { intradayBuyReady, intradayWeak } from "../src/a/intraday";
import { computeIndicators } from "../src/a/indicators";
import { scoreDailyDetailed } from "../src/a/score";
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
