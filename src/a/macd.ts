import type { Bar } from "../exchange/ashare";

/**
 * MACD（12/26/9），A 股软件口径：
 *
 * ```text
 * DIF  = EMA12(close) - EMA26(close)
 * DEA  = EMA9(DIF)
 * HIST = 2 × (DIF - DEA)
 * ```
 *
 * 选股只看「本周期 HIST 比上一周期高」（动量在改善），不要求金叉或零轴上方 ——
 * 这样能在趋势早期进入候选，而不是等三线全部走好再追高。
 */

export interface MacdPoint {
  dif: number;
  dea: number;
  hist: number;
}

function ema(values: number[], period: number): number[] {
  const result: number[] = [];
  if (values.length === 0) return result;
  const k = 2 / (period + 1);
  let prev = values[0];
  result.push(prev);
  for (let index = 1; index < values.length; index += 1) {
    prev = values[index] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function macdSeries(
  bars: Bar[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdPoint[] {
  const closes = bars.map((bar) => bar.close);
  if (closes.length === 0) return [];
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const dif = closes.map((_, index) => fastEma[index] - slowEma[index]);
  const dea = ema(dif, signal);
  return closes.map((_, index) => ({
    dif: dif[index],
    dea: dea[index],
    hist: 2 * (dif[index] - dea[index]),
  }));
}

/** 需要的最少根数：慢线 + 信号线 + 两根用于比较 */
export function macdBarsNeeded(slow = 26, signal = 9): number {
  return slow + signal + 2;
}

/** 本周期 HIST 是否高于上一周期 */
export function macdRising(bars: Bar[], slow = 26, signal = 9): boolean {
  if (bars.length < macdBarsNeeded(slow, signal)) return false;
  const series = macdSeries(bars, 12, slow, signal);
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  return last.hist > prev.hist;
}

function shanghaiDate(now: Date): Date {
  return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}

function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 周线只取「截止最近一次周末」的数据。
 *
 * 行情源会把当前未走完的一周也作为最后一根返回；周线比较必须剔除它，
 * 否则周一看到的是“半周 MACD”，和上周比没有意义。
 * 判断方式：最后一根属于本周且本周未到周五 15:05 → 剔除。
 */
export function dropIncompleteWeek(bars: Bar[], now = new Date()): Bar[] {
  if (bars.length === 0) return bars;
  const lastDate = bars[bars.length - 1].time.slice(0, 10);

  const current = shanghaiDate(now);
  const monday = new Date(current);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); // 本周一
  const fridayClose = new Date(monday);
  fridayClose.setDate(monday.getDate() + 4);
  fridayClose.setHours(15, 5, 0, 0);

  // 最后一根属于更早的周：已经完整
  if (lastDate < dateKey(monday)) return bars;
  // 本周且已收盘：完整
  if (current >= fridayClose) return bars;
  return bars.slice(0, -1);
}

/**
 * 日线是否用「上一交易日收盘」：盘前 / 盘中拿到的当日日线是半根，
 * 不能参与 MACD 比较。交易日 15:05 之后才把最后一根算作完整日线。
 */
export function dropIncompleteDay(bars: Bar[], now = new Date()): Bar[] {
  if (bars.length === 0) return bars;
  const current = shanghaiDate(now);
  const today = dateKey(current);
  const lastDate = bars[bars.length - 1].time.slice(0, 10);
  if (lastDate !== today) return bars;

  const h = current.getHours();
  const m = current.getMinutes();
  const closed = h > 15 || (h === 15 && m >= 5);
  return closed ? bars : bars.slice(0, -1);
}
