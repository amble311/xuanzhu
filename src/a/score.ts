import { mapLimit, fetchBars, type Bar } from "../exchange/ashare";
import { loadIndicators, type Indicators } from "./indicators";
import { loadSnapshot, type SnapshotRow } from "./snapshot";
import type { WatchItem } from "./watchlist";

/**
 * A 股选股打分：月线定方向、周线定波段、日线定趋势、1h 定买点。
 *
 * 全市场只用**已缓存的日线指标**做初筛（5583 行毫秒级），只对前 30 名补
 * 周线 / 月线 / 1h K 线（90 个请求），避免「5000 只 × 多周期」的请求风暴。
 */

export interface ScoreBreakdown {
  daily: number;
  weekly: number;
  monthly: number;
  hourly: number;
  total: number;
}

export interface ScoredCandidate {
  row: SnapshotRow;
  indicators?: Indicators;
  weekly: Bar[];
  monthly: Bar[];
  hourly: Bar[];
  score: ScoreBreakdown;
  reason: string;
}

function closes(bars: Bar[]): number[] {
  return bars.map((bar) => bar.close).filter((value) => Number.isFinite(value) && value > 0);
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ma(bars: Bar[], days: number): number | undefined {
  if (bars.length < days) return undefined;
  return average(closes(bars.slice(-days)));
}

function returnPct(bars: Bar[], days: number): number | undefined {
  if (bars.length < days + 1) return undefined;
  const first = bars[bars.length - 1 - days]?.close;
  const last = bars[bars.length - 1]?.close;
  if (!first || !last) return undefined;
  return ((last - first) / first) * 100;
}

/** 日线初筛分（0–45）：全市场可用，不拉 K 线 */
export function scoreDaily(row: SnapshotRow, indicators?: Indicators): number {
  if (!indicators) return 0;
  let score = 0;
  if (indicators.ma20 && indicators.close > indicators.ma20) score += 10;
  if (indicators.ma5 && indicators.ma20 && indicators.ma5 > indicators.ma20) score += 8;
  if (indicators.ret20 !== undefined) {
    if (indicators.ret20 > 0) score += 8;
    if (indicators.ret20 > 10) score += 2;
  }
  if (indicators.high20 && indicators.close) {
    const distance = ((indicators.high20 - indicators.close) / indicators.high20) * 100;
    if (distance <= 5) score += 8;
    else if (distance <= 10) score += 4;
  }
  const avgAmount = indicators.avgAmount20 ?? 0;
  if (avgAmount >= 200_000_000) score += 5;
  else if (avgAmount >= 100_000_000) score += 3;
  if ((row.turnoverPct ?? 0) >= 3 && (row.turnoverPct ?? 0) <= 15) score += 4;
  return Math.min(45, score);
}

function scoreWeekly(bars: Bar[]): number {
  if (bars.length < 21) return 0;
  let score = 0;
  const close = bars[bars.length - 1].close;
  const ma20 = ma(bars, 20);
  const ma5 = ma(bars, 5);
  if (ma20 && close > ma20) score += 8;
  if (ma5 && ma20 && ma5 > ma20) score += 7;
  const ret5 = returnPct(bars, 5);
  if (ret5 !== undefined && ret5 > 0) score += 5;
  return score;
}

function scoreMonthly(bars: Bar[]): number {
  if (bars.length < 21) return 0;
  let score = 0;
  const close = bars[bars.length - 1].close;
  const ma20 = ma(bars, 20);
  const ma5 = ma(bars, 5);
  if (ma20 && close > ma20) score += 8;
  if (ma5 && ma20 && ma5 > ma20) score += 7;
  return score;
}

function scoreHourly(bars: Bar[]): number {
  if (bars.length < 21) return 0;
  let score = 0;
  const close = bars[bars.length - 1].close;
  const ma20 = ma(bars, 20);
  if (ma20 && close > ma20) score += 8;

  const previous = bars.slice(-11, -1);
  if (previous.length === 10) {
    const high = Math.max(...previous.map((bar) => bar.high));
    if (close > high) score += 6;
  }
  const volumes = bars.slice(-20, -1).map((bar) => bar.volume);
  const avgVolume = average(volumes);
  if (avgVolume && bars[bars.length - 1].volume > avgVolume) score += 3;

  if (bars.length >= 3) {
    const [a, b, c] = bars.slice(-3).map((bar) => bar.close);
    if (a < b && b < c) score += 3;
  }
  return score;
}

export function scoreCandidate(
  row: SnapshotRow,
  indicators: Indicators | undefined,
  weekly: Bar[],
  monthly: Bar[],
  hourly: Bar[],
): { score: ScoreBreakdown; reason: string } {
  const daily = scoreDaily(row, indicators);
  const week = scoreWeekly(weekly);
  const month = scoreMonthly(monthly);
  const hour = scoreHourly(hourly);
  const total = daily + week + month + hour;
  const parts = [`日${daily}`, `周${week}`, `月${month}`, `1h${hour}`];
  if (weekly.length < 21) parts.push("周线不足");
  if (monthly.length < 21) parts.push("月线不足");
  if (hourly.length < 21) parts.push("1h不足");
  return {
    score: { daily, weekly: week, monthly: month, hourly: hour, total },
    reason: parts.join(" "),
  };
}

/** 无持仓时的全市场选股：日线初筛 30 → 补多周期 → 前 10 */
export async function selectTopWatchlist(
  limit = 10,
  onProgress?: (message: string) => void,
): Promise<WatchItem[]> {
  onProgress?.("读取全市场快照与日线指标…");
  const [loaded, indicators] = await Promise.all([loadSnapshot(), loadIndicators()]);
  const snapshot = loaded.snapshot;

  const rows = snapshot.rows
    .filter(
      (row) =>
        row.price > 0 &&
        !row.st &&
        !row.status?.includes("停") &&
        row.amount > 0 &&
        row.board !== "index" &&
        row.board !== "board",
    )
    .map((row) => ({ row, daily: scoreDaily(row, indicators.get(row.code)) }))
    .sort((a, b) => b.daily - a.daily)
    .slice(0, 30);

  onProgress?.(`对前 ${rows.length} 只补周线 / 月线 / 1h…`);
  const scored = await mapLimit(rows, async ({ row, daily }): Promise<WatchItem> => {
    try {
      const [weekly, monthly, hourly] = await Promise.all([
        fetchBars(row.code, { period: "week", adjust: "backward", limit: 80 }),
        fetchBars(row.code, { period: "month", adjust: "backward", limit: 36 }),
        fetchBars(row.code, { period: "60m", adjust: "backward", limit: 80 }),
      ]);
      const result = scoreCandidate(row, indicators.get(row.code), weekly, monthly, hourly);
      return {
        code: row.code,
        name: row.name,
        score: result.score.total,
        reason: result.reason,
        source: "select" as const,
        addedAt: new Date().toISOString(),
      } satisfies WatchItem;
    } catch {
      return {
        code: row.code,
        name: row.name,
        score: daily,
        reason: `日${daily}（多周期取数失败）`,
        source: "select" as const,
        addedAt: new Date().toISOString(),
      } satisfies WatchItem;
    }
  }, 6);

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
