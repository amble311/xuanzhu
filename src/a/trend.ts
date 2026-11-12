import type { Bar } from "../exchange/ashare";
import type { Indicators } from "./indicators";
import { adx, slopePct } from "./ta";

/**
 * 三周期趋势打分（复刻 btc 的方向投票，A 股只能做多）：
 * - 月线：收盘 > MA10 > MA20，MA10 近 3 月斜率 > +1%，ADX ≥18 → +1；镜像 → -1；
 * - 周线：收盘 > MA20 > MA50，MA20 近 5 周斜率 > +0.1%，ADX ≥18 → +1；镜像 → -1；
 * - 日线：btc 的 4 项检查 + 边缘反转 → +1 / 0 / -1。
 *
 * 最终过滤：任一周期 -1 → 丢弃；三周期必须都 ≥0 且至少一个 +1。
 */

export type TrendScore = -1 | 0 | 1;

export interface CycleTrend {
  score: TrendScore | null;
  reason: string;
}

function maAt(values: number[], period: number, offset = 0): number | undefined {
  const end = values.length - offset;
  if (end < period) return undefined;
  return values.slice(end - period, end).reduce((sum, value) => sum + value, 0) / period;
}

export function weeklyTrend(bars: Bar[]): CycleTrend {
  if (bars.length < 55) return { score: null, reason: "周线不足 55 根" };
  const closes = bars.map((bar) => bar.close);
  const close = closes[closes.length - 1];
  const ma20 = maAt(closes, 20);
  const ma50 = maAt(closes, 50);
  const ma20Prev = maAt(closes, 20, 5);
  const strength = adx(bars);
  if (!ma20 || !ma50 || !ma20Prev || strength === undefined) {
    return { score: null, reason: "周线指标不足" };
  }
  const slope = slopePct([ma20Prev, ma20], 1) ?? 0;
  const up = close > ma20 && ma20 > ma50 && slope > 0.1 && strength >= 18;
  const down = close < ma20 && ma20 < ma50 && slope < -0.1 && strength >= 18;
  return {
    score: up ? 1 : down ? -1 : 0,
    reason: `周线 C/MA20/MA50 ${close.toFixed(2)}/${ma20.toFixed(2)}/${ma50.toFixed(2)} · 斜率 ${slope.toFixed(2)}% · ADX ${strength.toFixed(1)}`,
  };
}

export function monthlyTrend(bars: Bar[]): CycleTrend {
  if (bars.length < 25) return { score: null, reason: "月线不足 25 根" };
  const closes = bars.map((bar) => bar.close);
  const close = closes[closes.length - 1];
  const ma10 = maAt(closes, 10);
  const ma20 = maAt(closes, 20);
  const ma10Prev = maAt(closes, 10, 3);
  const strength = adx(bars);
  if (!ma10 || !ma20 || !ma10Prev || strength === undefined) {
    return { score: null, reason: "月线指标不足" };
  }
  const slope = slopePct([ma10Prev, ma10], 1) ?? 0;
  const up = close > ma10 && ma10 > ma20 && slope > 1 && strength >= 18;
  const down = close < ma10 && ma10 < ma20 && slope < -1 && strength >= 18;
  return {
    score: up ? 1 : down ? -1 : 0,
    reason: `月线 C/MA10/MA20 ${close.toFixed(2)}/${ma10.toFixed(2)}/${ma20.toFixed(2)} · 斜率 ${slope.toFixed(2)}% · ADX ${strength.toFixed(1)}`,
  };
}

/** 日线趋势（用缓存指标，不再额外拉日线） */
export function dailyTrend(indicators: Indicators | undefined): CycleTrend {
  if (!indicators) return { score: null, reason: "日线指标缺失" };
  const {
    close,
    ma20,
    ma50,
    high20,
    low20,
    rsi14,
    macdHist,
    macdHistPrev,
  } = indicators;
  if (!close || !ma20 || !ma50 || !high20 || !low20 || rsi14 === undefined) {
    return { score: null, reason: "日线指标不足" };
  }
  const position = high20 > low20 ? (close - low20) / (high20 - low20) : 0.5;
  const distance = Math.abs(close / ma20 - 1);
  const longChecks = [
    close > ma50,
    rsi14 >= 38 && rsi14 <= 68,
    (macdHist ?? 0) > 0 || (macdHist ?? 0) > (macdHistPrev ?? 0),
    distance <= 0.04 || position <= 0.62,
  ].filter(Boolean).length;
  const shortChecks = [
    close < ma50,
    rsi14 >= 32 && rsi14 <= 62,
    (macdHist ?? 0) < 0 || (macdHist ?? 0) < (macdHistPrev ?? 0),
    distance <= 0.04 || position >= 0.38,
  ].filter(Boolean).length;

  if (longChecks >= 3 && longChecks > shortChecks) {
    return {
      score: 1,
      reason: `日线多头 ${longChecks}/4（RSI ${rsi14.toFixed(1)} · 位置 ${(position * 100).toFixed(0)}%）`,
    };
  }
  if (shortChecks >= 3 && shortChecks > longChecks) {
    return {
      score: -1,
      reason: `日线空头 ${shortChecks}/4（RSI ${rsi14.toFixed(1)} · 位置 ${(position * 100).toFixed(0)}%）`,
    };
  }
  if (position <= 0.22 && rsi14 < 38) {
    return { score: 1, reason: `日线低位反转（位置 ${(position * 100).toFixed(0)}% · RSI ${rsi14.toFixed(1)}）` };
  }
  if (position >= 0.78 && rsi14 > 62) {
    return { score: -1, reason: `日线高位转弱（位置 ${(position * 100).toFixed(0)}% · RSI ${rsi14.toFixed(1)}）` };
  }
  return {
    score: 0,
    reason: `日线中性（多头 ${longChecks}/4 · 空头 ${shortChecks}/4）`,
  };
}

export interface CombinedTrend {
  pass: boolean;
  reason: string;
  sum: number;
  monthly: TrendScore | null;
  weekly: TrendScore | null;
  daily: TrendScore | null;
}

/** A 股多头过滤：任一周期向下 / 数据不足 / 三周期全 0 / 没有 +1 → 丢弃 */
export function combineTrend(
  monthly: CycleTrend,
  weekly: CycleTrend,
  daily: CycleTrend,
): CombinedTrend {
  const scores = [monthly.score, weekly.score, daily.score];
  const sum = scores.reduce<number>((total, score) => total + (score ?? 0), 0);
  if (scores.some((score) => score === null)) {
    return { pass: false, reason: "三周期数据不足", sum, monthly: monthly.score, weekly: weekly.score, daily: daily.score };
  }
  if (scores.some((score) => score === -1)) {
    return { pass: false, reason: "存在向下周期", sum, monthly: monthly.score, weekly: weekly.score, daily: daily.score };
  }
  if (scores.every((score) => score === 0)) {
    return { pass: false, reason: "三周期均无向上", sum, monthly: monthly.score, weekly: weekly.score, daily: daily.score };
  }
  return {
    pass: true,
    reason: `M${monthly.score} W${weekly.score} D${daily.score}`,
    sum,
    monthly: monthly.score,
    weekly: weekly.score,
    daily: daily.score,
  };
}
