import type { Quote } from "../exchange/ashare";
import type { Indicators } from "./indicators";

/**
 * 开盘 / 盘中态势（决策时必须看的东西）。
 *
 * 为什么需要：日线指标按**收盘价**计算（这是对的），所以 09:30 那一刻的
 * 「日线多头 / 15m 评分」里并不包含今天的高开、放量、缺口 —— 模型如果只看这些数字，
 * 等于**拿昨晚的 K 线给今天的开盘下单**。用户实测「一开盘就买」正是这种信息缺口：
 * 数字说可以买，但它没看到「今天高开 3% 后一路回落」这种关键事实。
 *
 * 这里把「当前开盘情况」显式算成一行文字，塞进 `a_signal` 与巡检预检：
 * - 高开 / 低开幅度（相对昨收）
 * - 现价相对开盘价（开盘后是走强还是走弱）
 * - 量比（今日每分钟成交额 ÷ 近 5 日每分钟均值）
 * - 缺口是否回补（高开跌破昨收 / 低开收复昨收）
 *
 * 不在这里做「买/不买」判断：只把事实摆出来，让模型结合三周期与 15m 一起判断。
 */

export interface OpeningContext {
  /** 开盘后多少分钟（0 = 还没开盘；240 = 已收盘） */
  elapsedMinutes: number;
  /** 是否开盘 30 分钟内（这段时间的成交额对比最不稳定，要在文字里说明） */
  early: boolean;
  /** 开盘相对昨收（%） */
  gapPct?: number;
  /** 现价相对开盘（%） */
  fromOpenPct?: number;
  /** 现价相对昨收（%） */
  pct?: number;
  /** 量比：今天每分钟成交额 ÷ 近 5 日每分钟均值 */
  volumeRatio?: number;
  /** 高开是否已跌破昨收 / 低开是否已收复昨收 */
  gapFilled?: boolean;
  /** 给模型看的一行描述；数据不足时明确写「取不到」 */
  text: string;
}

/** 上海时区的分钟数 */
function shanghaiMinutes(now: Date): number {
  const local = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  return local.getHours() * 60 + local.getMinutes();
}

/**
 * 已交易的分钟数（09:30 起算，午休不计）。
 *
 * 用于把「今天累计成交额」折算成每分钟均值 —— 开盘 3 分钟就用全天均值比，
 * 量比会假性偏低（或偏高），必须先按已交易时间归一化。
 */
export function elapsedTradingMinutes(now = new Date()): number {
  const minutes = shanghaiMinutes(now);
  const open = 9 * 60 + 30;
  const morningClose = 11 * 60 + 30;
  const afternoonOpen = 13 * 60;
  const close = 15 * 60;
  if (minutes <= open) return 0;
  if (minutes <= morningClose) return minutes - open;
  if (minutes <= afternoonOpen) return 120;
  if (minutes <= close) return 120 + (minutes - afternoonOpen);
  return 240;
}

function pct(value: number, base: number): number | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base <= 0) return undefined;
  return ((value - base) / base) * 100;
}

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/** 今天的成交额 ÷ 已交易分钟，与近 5 日均值比 */
function volumeRatioOf(
  quote: Quote | null,
  indicators: Indicators | undefined,
  elapsed: number,
): number | undefined {
  if (!quote || elapsed <= 0) return undefined;
  const todayAmount = quote.amount;
  const avgAmount5 = indicators?.avgAmount5;
  if (!Number.isFinite(todayAmount) || todayAmount <= 0) return undefined;
  if (avgAmount5 === undefined || !Number.isFinite(avgAmount5) || avgAmount5 <= 0) {
    return undefined;
  }
  const perMinuteToday = todayAmount / elapsed;
  const perMinuteBase = avgAmount5 / 240;
  if (perMinuteBase <= 0) return undefined;
  return perMinuteToday / perMinuteBase;
}

/**
 * 计算开盘 / 盘中态势。
 *
 * `quote` 取不到时返回 `text: "行情取不到"`；`indicators` 缺失只是没有量比，
 * 其余（高开、相对开盘、缺口）仍然可用。
 */
export function openingContext(
  quote: Quote | null,
  indicators: Indicators | undefined,
  now = new Date(),
): OpeningContext {
  const elapsed = elapsedTradingMinutes(now);
  const early = elapsed > 0 && elapsed <= 30;
  if (!quote) {
    return { elapsedMinutes: elapsed, early, text: "开盘情况取不到（行情缺失）" };
  }

  const gapPct = pct(quote.open, quote.preClose);
  const fromOpenPct = pct(quote.price, quote.open);
  const dayPct = pct(quote.price, quote.preClose);
  const volumeRatio = volumeRatioOf(quote, indicators, elapsed);

  let gapFilled: boolean | undefined;
  if (gapPct !== undefined && quote.preClose > 0) {
    if (gapPct > 0.1 && quote.price <= quote.preClose) gapFilled = true;
    else if (gapPct < -0.1 && quote.price >= quote.preClose) gapFilled = true;
    else gapFilled = false;
  }

  const parts: string[] = [];
  if (elapsed <= 0) {
    parts.push(`未开盘（昨收 ${quote.preClose.toFixed(2)}）`);
  } else {
    parts.push(`开盘 ${elapsed} 分钟`);
    if (gapPct !== undefined) {
      const kind = gapPct > 0.1 ? "高开" : gapPct < -0.1 ? "低开" : "平开";
      parts.push(`${kind} ${signed(gapPct)}%（开 ${quote.open.toFixed(2)} / 昨收 ${quote.preClose.toFixed(2)}）`);
    }
    if (fromOpenPct !== undefined) {
      const trend = fromOpenPct >= 0.2 ? "较开盘走强" : fromOpenPct <= -0.2 ? "较开盘走弱" : "较开盘持平";
      parts.push(`现价 ${quote.price.toFixed(2)}（${signed(dayPct ?? 0)}%），${trend} ${signed(fromOpenPct)}%`);
    }
    if (gapFilled !== undefined) {
      const gap = gapPct ?? 0;
      parts.push(
        gapFilled
          ? gap > 0
            ? "高开缺口已回补（已跌破昨收）"
            : "低开缺口已回补（已收复昨收）"
          : gap > 0.1
            ? "高开缺口未回补"
            : gap < -0.1
              ? "低开缺口未回补"
              : "无缺口",
      );
    }
    if (volumeRatio !== undefined) {
      const level = volumeRatio >= 1.5 ? "明显放量" : volumeRatio >= 1.1 ? "略放量" : volumeRatio <= 0.7 ? "明显缩量" : "量能持平";
      // 与 15m 里的「量比」（最后一根 K 线量 / 均量）区分开，这里是全天口径
      parts.push(`今日量比 ${volumeRatio.toFixed(2)}（${level}）`);
    }
    if (early) {
      parts.push("开盘初期，量比与分时形态参考价值有限，需要后续 K 线确认");
    }
    // 今日振幅与开盘位置：判断「一字板 / 冲高回落 / 低开高走」的直观信息
    if (quote.high > 0 && quote.low > 0 && quote.open > 0) {
      parts.push(
        `今日区间 ${quote.low.toFixed(2)}–${quote.high.toFixed(2)}` +
          `（现价距最高 ${signed((pct(quote.price, quote.high) ?? 0), 2)}%）`,
      );
    }
  }

  return {
    elapsedMinutes: elapsed,
    early,
    gapPct,
    fromOpenPct,
    pct: dayPct,
    volumeRatio,
    gapFilled,
    text: parts.join(" · "),
  };
}
