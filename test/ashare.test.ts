import { describe, expect, it } from "vitest";
import {
  boardCodes,
  barsType,
  classifyCode,
  decodeAllBars,
  decodeIntraday,
  decodeLastBars,
  decodeQuote,
  formatBarTime,
  isStName,
  isTradingTime,
  parseJsonp,
  stockCodes,
  toThsSymbol,
} from "../src/exchange/ashare";

/**
 * 同花顺行情适配层的**纯解码**用例。
 *
 * 这些函数是外部契约与内部类型之间的唯一转换点：字段码、列式压缩、跨年回绕
 * 一旦弄错，错误会静默传播到策略与撮合。用例全部离线 —— 不打真实接口。
 */

describe("代码归一化", () => {
  it("股票 / 指数 / 板块都归一成同花顺符号", () => {
    expect(toThsSymbol("600519")).toEqual({ symbol: "hs_600519", kind: "stock" });
    expect(toThsSymbol("sh600519")).toEqual({ symbol: "hs_600519", kind: "stock" });
    expect(toThsSymbol("600519.SH")).toEqual({ symbol: "hs_600519", kind: "stock" });
    expect(toThsSymbol("1A0001")).toEqual({ symbol: "hs_1A0001", kind: "index" });
    // 常见交易所前缀写法映射到同花顺的上证指数代码
    expect(toThsSymbol("sh000001")).toEqual({ symbol: "hs_1A0001", kind: "index" });
    expect(toThsSymbol("sz399001")).toEqual({ symbol: "hs_399001", kind: "index" });
    expect(toThsSymbol("881101")).toEqual({ symbol: "bk_881101", kind: "board" });
    expect(toThsSymbol("bk_885333")).toEqual({ symbol: "bk_885333", kind: "board" });
    expect(() => toThsSymbol("abc")).toThrow(/无法识别/);
  });

  it("按代码前缀归类板块（决定涨跌停与交易规则）", () => {
    expect(classifyCode("600519")).toBe("sh-main");
    expect(classifyCode("603288")).toBe("sh-main");
    expect(classifyCode("688981")).toBe("star");
    expect(classifyCode("000001")).toBe("sz-main");
    expect(classifyCode("002594")).toBe("sz-main");
    expect(classifyCode("300750")).toBe("gem");
    expect(classifyCode("301236")).toBe("gem");
    expect(classifyCode("920819")).toBe("bse");
    expect(classifyCode("1A0001")).toBe("index");
    expect(classifyCode("881101")).toBe("board");
    expect(classifyCode("900901")).toBe("unknown");
  });

  it("ST 识别覆盖 *ST 与 ST", () => {
    expect(isStName("ST金花")).toBe(true);
    expect(isStName("*ST九鼎")).toBe(true);
    expect(isStName("贵州茅台")).toBe(false);
  });
});

describe("JSONP 与快照解码", () => {
  it("剥离回调包装；纯 JSON 也接受", () => {
    expect(parseJsonp('cb({"a":1})')).toEqual({ a: 1 });
    expect(parseJsonp('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonp("")).toThrow(/空内容/);
    expect(() => parseJsonp("not-jsonp")).toThrow(/无法解析/);
  });

  it("items 字段码映射为 Quote（含涨停价与板块）", () => {
    const quote = decodeQuote(
      { symbol: "hs_600519", kind: "stock" },
      {
        "5": "600519",
        "6": "1452.00",
        "7": "1450.00",
        "8": "1457.72",
        "9": "1436.00",
        "10": "1453.00",
        "13": "4284772.00",
        "19": "6199528300.00",
        "69": "1597.20",
        "70": "1306.80",
        "199112": "0.07",
        "1968584": "0.343",
        "1378761": "1446.875",
        "402": "1250081601.00",
        "407": "1250081601.00",
        "3475914": "1816368600000.00",
        name: "贵州茅台",
        marketType: "HS_stock_sh",
        stockStatus: "闭市",
        updateTime: "2026-11-06 15:30",
      },
    );
    expect(quote.code).toBe("600519");
    expect(quote.name).toBe("贵州茅台");
    expect(quote.price).toBe(1453);
    expect(quote.preClose).toBe(1452);
    expect(quote.change).toBeCloseTo(1);
    expect(quote.changePct).toBeCloseTo(0.07);
    expect(quote.limitUp).toBe(1597.2);
    expect(quote.limitDown).toBe(1306.8);
    expect(quote.turnoverPct).toBeCloseTo(0.343);
    expect(quote.avgPrice).toBeCloseTo(1446.875);
    expect(quote.board).toBe("sh-main");
    expect(quote.st).toBe(false);
    expect(quote.updatedAt).toBe("2026-11-06 15:30");
  });
});

describe("K 线解码", () => {
  it("last.js：日内行格式（含成交额与换手率）", () => {
    const bars = decodeLastBars({
      data:
        "20261105,9945.42,10054.03,9851.43,9975.24,4671220,4653450000.00,0.374,,,0;" +
        "20261106,9963.99,10007.44,9885.20,9980.87,4284772,6199528300.00,0.343,,1600.00,2324800",
    });
    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({
      time: "2026-11-06",
      open: 9963.99,
      high: 10007.44,
      low: 9885.2,
      close: 9980.87,
      volume: 4284772,
      amount: 6199528300,
    });
    expect(bars[1].turnoverPct).toBeCloseTo(0.343);
  });

  it("last.js：分钟线的 12 位时间格式", () => {
    const bars = decodeLastBars({
      data: "202611061500,1450.02,1453.00,1448.98,1453.00,367000,533059600.00,0.029,,,0",
    });
    expect(bars[0].time).toBe("2026-11-06 15:00");
    expect(formatBarTime("20261106")).toBe("2026-11-06");
    expect(formatBarTime("202611061500")).toBe("2026-11-06 15:00");
  });

  it("all.js：列式压缩（low + 差值）与跨年回绕", () => {
    // 每根 4 个值：[low, open-low, high-low, close-low]，单位分
    const bars = decodeAllBars({
      start: "20251230",
      priceFactor: 100,
      // 第一根 2025-12-31：low 10.00 / open 10.20 / high 10.50 / close 10.40
      // 第二根 2026-01-02：low 11.00 / open 11.10 / high 11.30 / close 11.20
      price: "1000,20,50,40,1100,10,30,20",
      volumn: "1000,2000",
      dates: "1231,0102",
    });
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ time: "2025-12-31", open: 10.2, high: 10.5, low: 10, close: 10.4 });
    expect(bars[1].time).toBe("2026-01-02");
    expect(bars[1].close).toBeCloseTo(11.2);
    expect(bars[1].volume).toBe(2000);
  });

  it("type 参数：周期 + 复权", () => {
    expect(barsType("day", "backward")).toBe("02");
    expect(barsType("day", "none")).toBe("00");
    expect(barsType("day", "forward")).toBe("01");
    expect(barsType("5m", "none")).toBe("30");
    expect(barsType("60m", "forward")).toBe("51");
    expect(barsType("month", "backward")).toBe("22");
  });
});

describe("分时与交易日历", () => {
  it("分时点：时间、价格、量、均价", () => {
    const series = decodeIntraday(
      { symbol: "hs_600519", kind: "stock" },
      {
        hs_600519: {
          name: "贵州茅台",
          pre: "1452.00",
          date: "20261106",
          isTrading: 0,
          data: "0930,1450.00,226345000,1450.000,156100;0931,1450.98,4202000,1450.49,1200",
        },
      },
    );
    expect(series.name).toBe("贵州茅台");
    expect(series.preClose).toBe(1452);
    expect(series.trading).toBe(false);
    expect(series.points).toHaveLength(2);
    expect(series.points[0]).toMatchObject({ time: "09:30", price: 1450, volume: 226345000 });
    expect(series.points[1].avgPrice).toBeCloseTo(1450.49);
  });

  it("交易时段：工作日盘中为真，午休与周末为假", () => {
    // 2026-11-09 是周一
    expect(isTradingTime(new Date(2026, 10, 9, 10, 0))).toBe(true);
    expect(isTradingTime(new Date(2026, 10, 9, 12, 0))).toBe(false);
    expect(isTradingTime(new Date(2026, 10, 9, 14, 30))).toBe(true);
    expect(isTradingTime(new Date(2026, 10, 7, 10, 0))).toBe(false); // 周六
  });
});

describe("股票池与板块代码段", () => {
  it("股票池候选：覆盖沪深主板 / 科创 / 创业 / 北交所，不含 B 股", () => {
    const codes = stockCodes();
    expect(codes.length).toBe(13999);
    expect(codes).toContain("600519");
    expect(codes).toContain("688981");
    expect(codes).toContain("300750");
    expect(codes).toContain("920819");
    expect(codes).not.toContain("900901");
    // 深市主板是 000001 起，不能把 1 写成 "1"
    expect(codes).toContain("000001");
  });

  it("板块候选：行业 881xxx 与概念 885xxx 各 1000 个", () => {
    const boards = boardCodes();
    expect(boards).toHaveLength(2000);
    expect(boards[0]).toEqual({ code: "881000", type: "industry" });
    expect(boards).toContainEqual({ code: "881101", type: "industry" });
    expect(boards).toContainEqual({ code: "885333", type: "concept" });
  });
});
