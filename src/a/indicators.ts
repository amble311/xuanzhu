import {
  readCache,
  writeCache,
  fetchBars,
  loadUniverse,
  mapLimit,
  type Bar,
} from "../exchange/ashare";

/**
 * 全市场预计算指标。
 *
 * 为什么不让筛选器现算：横截面筛选要遍历 5000+ 只，每只都拉 140 根日线
 * 等于每次筛选 60MB 流量、几分钟等待。指标每天只需要重算一次（收盘后），
 * 盘中筛选只读快照 + 这份表。
 *
 * 口径：后复权（`02`）。前复权在高分红股上早年为负，无法参与均线/涨幅计算。
 */

export const INDICATORS_CACHE = "indicators.json";
// 36 小时：收盘后算一次，足够覆盖**下一个交易日全天**而不在盘中突然过期重算；
// 需要日内最新口径时显式 `xzh a sync`（指标本身按收盘价计算，盘中重算意义不大）。
const CACHE_TTL_MS = 36 * 60 * 60 * 1000;

export interface Indicators {
  code: string;
  /** 最后一根日线的日期 `YYYY-MM-DD` */
  asOf: string;
  /** 后复权收盘价 */
  close: number;
  ma5?: number;
  ma10?: number;
  ma20?: number;
  ma60?: number;
  high20?: number;
  high60?: number;
  low20?: number;
  /** 区间涨幅（%） */
  ret5?: number;
  ret20?: number;
  ret60?: number;
  /** 近 N 日平均成交额（元） */
  avgAmount5?: number;
  avgAmount20?: number;
  /** 参与计算的日线根数 */
  bars: number;
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(current: number, previous: number | undefined): number | undefined {
  if (!previous || !Number.isFinite(previous) || previous === 0) return undefined;
  return ((current - previous) / previous) * 100;
}

/** 从升序日线计算指标；不足根数的字段留空（不要用 0 冒充） */
export function computeIndicators(code: string, bars: Bar[]): Indicators | null {
  if (bars.length === 0) return null;
  const closes = bars.map((bar) => bar.close);
  const last = bars[bars.length - 1];
  const tail = (count: number) => closes.slice(-count);

  const ma = (count: number): number | undefined =>
    bars.length >= count ? average(tail(count)) : undefined;

  const recent = bars.slice(-20);
  const recent60 = bars.slice(-60);
  const amounts5 = bars.slice(-5).map((bar) => bar.amount);
  const amounts20 = bars.slice(-20).map((bar) => bar.amount);

  return {
    code,
    asOf: last.time.slice(0, 10),
    close: last.close,
    ma5: ma(5),
    ma10: ma(10),
    ma20: ma(20),
    ma60: ma(60),
    high20: recent.length > 0 ? Math.max(...recent.map((bar) => bar.high)) : undefined,
    high60: recent60.length > 0 ? Math.max(...recent60.map((bar) => bar.high)) : undefined,
    low20: recent.length > 0 ? Math.min(...recent.map((bar) => bar.low)) : undefined,
    ret5: bars.length > 5 ? percentChange(last.close, closes[closes.length - 6]) : undefined,
    ret20: bars.length > 20 ? percentChange(last.close, closes[closes.length - 21]) : undefined,
    ret60: bars.length > 60 ? percentChange(last.close, closes[closes.length - 61]) : undefined,
    avgAmount5: average(amounts5.filter((value): value is number => Number.isFinite(value))),
    avgAmount20: average(amounts20.filter((value): value is number => Number.isFinite(value))),
    bars: bars.length,
  };
}

export interface BuildIndicatorsOptions {
  onProgress?: (done: number, total: number) => void;
  /** 只算一部分（调试 / 指定股票池） */
  codes?: string[];
}

/** 批量抓日线并计算指标（并发由同花顺适配层限制） */
export async function buildIndicators(
  codes: string[],
  options: BuildIndicatorsOptions = {},
): Promise<{ items: Indicators[]; failed: number }> {
  let done = 0;
  let failed = 0;
  const rows = await mapLimit(codes, async (code) => {
    try {
      const bars = await fetchBars(code, {
        period: "day",
        adjust: "backward",
        limit: 140,
      });
      return computeIndicators(code, bars);
    } catch {
      failed += 1;
      return null;
    } finally {
      done += 1;
      options.onProgress?.(done, codes.length);
    }
  });
  return {
    items: rows.filter((row): row is Indicators => row !== null),
    failed,
  };
}

export async function loadIndicators(
  options: {
    refresh?: boolean;
    codes?: string[];
    /** 缺缓存时会全市场重算，进度回调给工具/CLI 显示 */
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<Map<string, Indicators>> {
  if (!options.refresh) {
    const cached = readCache<Indicators[]>(INDICATORS_CACHE, CACHE_TTL_MS);
    if (cached) {
      return new Map(cached.value.map((item) => [item.code, item]));
    }
  }
  const codes =
    options.codes && options.codes.length > 0
      ? options.codes
      : (await loadUniverse()).map((stock) => stock.code);
  const { items } = await buildIndicators(codes, { onProgress: options.onProgress });
  if (items.length > 0) writeCache(INDICATORS_CACHE, items);
  return new Map(items.map((item) => [item.code, item]));
}
