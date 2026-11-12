import type { Bar } from "../exchange/ashare";
import { macdSeries } from "./macd";
import { atr, rangePosition, rsi, sma } from "./ta";

/**
 * 15 分钟深度技术分析（复刻 btc 1h 机会评分）：
 * 结构 30 / 位置 20 / 动量 20 / 量能 15 / 形态 15，满分 100。
 */

export interface Deep15Result {
  score: number;
  reason: string;
}

export function score15m(bars: Bar[]): Deep15Result | null {
  if (bars.length < 55) return null;
  const last = bars[bars.length - 1];
  const closes = bars.map((bar) => bar.close);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const atr14 = atr(bars, 14);
  const strength = rsi(bars, 14);
  const position = rangePosition(bars, 20);
  if (!ma20 || !ma50 || !atr14 || strength === undefined || position === undefined) return null;

  let structure = 0;
  if (last.close > ma50 && ma20 >= ma50) structure = 30;
  else if (last.close > ma50) structure = 15;

  let location = 0;
  if (Math.abs(last.close - ma20) <= atr14) location = 20;
  else if (position <= 0.6) location = 12;
  else if (position < 0.9) location = 6;
  else location = 0;

  const macd = macdSeries(bars);
  const hist = macd[macd.length - 1]?.hist;
  const histPrev = macd[macd.length - 2]?.hist;
  let momentum = 0;
  if (hist !== undefined && hist > 0) momentum = hist >= (histPrev ?? 0) ? 20 : 10;

  const previousVolumes = bars.slice(-21, -1).map((bar) => bar.volume);
  const avgVolume =
    previousVolumes.length > 0
      ? previousVolumes.reduce((sum, value) => sum + value, 0) / previousVolumes.length
      : 0;
  const volumeRatio = avgVolume > 0 ? last.volume / avgVolume : 0;
  const volume = volumeRatio >= 1.2 ? 15 : volumeRatio >= 0.8 ? 8 : 0;

  const priorHigh =
    bars.length >= 49
      ? Math.max(...bars.slice(-49, -1).map((bar) => bar.high))
      : undefined;
  const pullback =
    Math.abs(last.close - ma20) <= atr14 && structure > 0 && strength >= 40;
  const breakout =
    priorHigh !== undefined &&
    last.close > priorHigh &&
    volumeRatio >= 1.2 &&
    strength >= 40 &&
    strength <= 78;
  const pattern = pullback || breakout ? 15 : 0;

  const score = Math.min(100, structure + location + momentum + volume + pattern);
  return {
    score,
    reason:
      `15m ${score}（结构${structure}/位置${location}/动量${momentum}/量能${volume}/形态${pattern}` +
      ` · RSI ${strength.toFixed(1)} · 量比 ${volumeRatio.toFixed(2)}）`,
  };
}
