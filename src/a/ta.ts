import type { Bar } from "../exchange/ashare";

/** A 股趋势/技术分析共用的纯函数（无缓存、无网络） */

export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function atr(bars: Bar[], period = 14): number | undefined {
  if (bars.length < period + 1) return undefined;
  const ranges: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const prev = bars[index - 1].close;
    ranges.push(
      Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev)),
    );
  }
  if (ranges.length < period) return undefined;
  let value = ranges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < ranges.length; index += 1) {
    value = (value * (period - 1) + ranges[index]) / period;
  }
  return value;
}

/** Wilder RSI14 */
export function rsi(bars: Bar[], period = 14): number | undefined {
  if (bars.length <= period) return undefined;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const diff = bars[index].close - bars[index - 1].close;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  for (let index = period + 1; index < bars.length; index += 1) {
    const diff = bars[index].close - bars[index - 1].close;
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (gain + loss === 0) return 50;
  return (gain / (gain + loss)) * 100;
}

/** Wilder ADX14；数据不足返回 undefined */
export function adx(bars: Bar[], period = 14): number | undefined {
  if (bars.length < period * 2) return undefined;
  const trs: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const prev = bars[index - 1];
    trs.push(
      Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)),
    );
    const up = bar.high - prev.high;
    const down = prev.low - bar.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  if (trs.length < period) return undefined;
  let tr = trs.slice(0, period).reduce((sum, value) => sum + value, 0);
  let plus = plusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  let minus = minusDm.slice(0, period).reduce((sum, value) => sum + value, 0);
  const dxs: number[] = [];
  for (let index = period; index < trs.length; index += 1) {
    tr = tr - tr / period + trs[index];
    plus = plus - plus / period + plusDm[index];
    minus = minus - minus / period + minusDm[index];
    const plusDi = tr > 0 ? (plus / tr) * 100 : 0;
    const minusDi = tr > 0 ? (minus / tr) * 100 : 0;
    const sum = plusDi + minusDi;
    dxs.push(sum > 0 ? (Math.abs(plusDi - minusDi) / sum) * 100 : 0);
  }
  if (dxs.length < period) return undefined;
  let value = dxs.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < dxs.length; index += 1) {
    value = (value * (period - 1) + dxs[index]) / period;
  }
  return value;
}

/** 收盘价在最近 lookback 根高低区间的位置（0–1） */
export function rangePosition(bars: Bar[], lookback = 20): number | undefined {
  if (bars.length < lookback) return undefined;
  const slice = bars.slice(-lookback);
  const high = Math.max(...slice.map((bar) => bar.high));
  const low = Math.min(...slice.map((bar) => bar.low));
  if (high <= low) return 0.5;
  return (bars[bars.length - 1].close - low) / (high - low);
}

/** 最后 n 个值的斜率（相对首值，%） */
export function slopePct(values: number[], lookback: number): number | undefined {
  if (values.length < lookback + 1) return undefined;
  const last = values[values.length - 1];
  const previous = values[values.length - 1 - lookback];
  if (previous === 0) return undefined;
  return ((last - previous) / previous) * 100;
}
