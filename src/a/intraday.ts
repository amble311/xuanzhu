import type { Bar } from "../exchange/ashare";

/**
 * 日内择时（买卖点用）。
 *
 * 分析周期统一为 **15 分钟**（巡检、选股、持仓风控都用同一周期）：
 * - 买点：站上 15m MA20 + 突破前 10 根高点 + 放量 1.2×；
 * - 卖点：跌破 15m MA20 + 跌破前 10 根低点（与 ATR 止损并列，谁先触发算谁）。
 *
 * 入参是已经取好的 K 线，调用方负责指定周期（现为 15m）。
 */

const MA_PERIOD = 20;
/** 「前 N 根」的默认根数：与买/卖点口径一致（10 根 15m ≈ 半个交易日） */
const EXTREME_BARS = 10;

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 最近 `period` 根（含最后一根）的收盘均价。
 *
 * 导出是给监控规则用的（`a_trigger` 的 15m 结构条件）：买点/卖点与叫醒条件
 * 必须用同一套算法，否则「巡检说跌破了、规则没叫」这种不一致没法解释。
 */
export function intradayMa(bars: Bar[], period = MA_PERIOD): number | undefined {
  if (bars.length < period) return undefined;
  return average(bars.slice(-period).map((bar) => bar.close));
}

/**
 * 前 `count` 根（**不含当前这根**）的最低 / 最高价。
 *
 * 不含最后一根：新浪 15m 会带上正在走的那根，把它算进极值会让「突破」永远差一点。
 */
export function priorExtreme(
  bars: Bar[],
  kind: "low" | "high",
  count = EXTREME_BARS,
): number | undefined {
  const previous = bars.slice(-(count + 1), -1);
  if (previous.length < count) return undefined;
  const values = previous.map((bar) => (kind === "low" ? bar.low : bar.high));
  return kind === "low" ? Math.min(...values) : Math.max(...values);
}

/** 日内买点是否成立（数据不足一律 false，交回日线信号等待） */
export function intradayBuyReady(bars: Bar[]): boolean {
  if (bars.length < MA_PERIOD + 1) return false;
  const last = bars[bars.length - 1];
  const ma20 = intradayMa(bars);
  if (!ma20 || last.close <= ma20) return false;

  const priorHigh = priorExtreme(bars, "high");
  if (priorHigh === undefined || last.close <= priorHigh) return false;

  const avgVolume = average(bars.slice(-20, -1).map((bar) => bar.volume));
  if (avgVolume && last.volume < avgVolume * 1.2) return false;
  return true;
}

/** 日内卖点（走弱）：跌破 15m MA20 且跌破前 10 根低点 */
export function intradayWeak(bars: Bar[]): boolean {
  if (bars.length < MA_PERIOD + 1) return false;
  const last = bars[bars.length - 1];
  const ma20 = intradayMa(bars);
  if (!ma20 || last.close >= ma20) return false;

  const priorLow = priorExtreme(bars, "low");
  return priorLow !== undefined && last.close < priorLow;
}
