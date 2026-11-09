import type { Bar } from "../exchange/ashare";

/**
 * 日内择时（买卖点用，选股不用）。
 *
 * A 股 1 小时只有 4 根/天，噪声大；统一用 30 分钟：
 * - 买点：站上 30m MA20 + 突破前 10 根高点 + 放量 1.2×；
 * - 卖点：跌破 30m MA20 + 跌破前 10 根低点（与 ATR 止损并列，谁先触发算谁）。
 *
 * 选股完全不用日内数据 —— 选股是日/周/月 MACD 漏斗。
 */

const MA_PERIOD = 20;

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ma(bars: Bar[], period: number): number | undefined {
  if (bars.length < period) return undefined;
  return average(bars.slice(-period).map((bar) => bar.close));
}

/** 日内买点是否成立（数据不足一律 false，交回日线信号等待） */
export function intradayBuyReady(bars: Bar[]): boolean {
  if (bars.length < MA_PERIOD + 1) return false;
  const last = bars[bars.length - 1];
  const ma20 = ma(bars, MA_PERIOD);
  if (!ma20 || last.close <= ma20) return false;

  const previous = bars.slice(-11, -1);
  if (previous.length < 10) return false;
  const priorHigh = Math.max(...previous.map((bar) => bar.high));
  if (last.close <= priorHigh) return false;

  const avgVolume = average(bars.slice(-20, -1).map((bar) => bar.volume));
  if (avgVolume && last.volume < avgVolume * 1.2) return false;
  return true;
}

/** 日内卖点（走弱）：跌破 30m MA20 且跌破前 10 根低点 */
export function intradayWeak(bars: Bar[]): boolean {
  if (bars.length < MA_PERIOD + 1) return false;
  const last = bars[bars.length - 1];
  const ma20 = ma(bars, MA_PERIOD);
  if (!ma20 || last.close >= ma20) return false;

  const previous = bars.slice(-11, -1);
  if (previous.length < 10) return false;
  const priorLow = Math.min(...previous.map((bar) => bar.low));
  return last.close < priorLow;
}
