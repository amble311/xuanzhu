import { fetchBars, mapLimit } from "../exchange/ashare";
import { loadIndicators, type Indicators } from "./indicators";
import { dropIncompleteWeek, macdRising } from "./macd";
import { loadSnapshot, type SnapshotRow } from "./snapshot";
import { applyNewsAdjustments } from "./news";
import { reviewWithAgent } from "./agent-review";
import type { WatchItem } from "./watchlist";

/**
 * A 股选股：三周期 MACD 漏斗 + 日线详细评分。
 *
 * 与用户确认的规则一致：
 * 1. 日线 MACD 柱体高于昨天（全市场缓存指标，零额外请求）；
 * 2. 周线 MACD 柱体高于上一周（只取截止最近一次周末的完整周）；
 * 3. 月线 MACD 柱体高于上一月（当月未走完，按当前月线比较）；
 * 4. 对最后剩下的做日线详细评分，取前 10；**不足 10 只不补**。
 *
 * 刻意不使用 1h / 30m：A 股 T+1 + 4 小时交易，日内触发容易追涨杀跌；
 * 进场由日线信号决定，盘中只负责卖出风控。
 */

/**
 * 日线详细评分（0–100），只用于通过三周期 MACD 过滤后的候选。
 */
export function scoreDailyDetailed(row: SnapshotRow, indicators?: Indicators): number {
  if (!indicators) return 0;
  let score = 0;

  // 趋势 30
  if (indicators.ma20 && indicators.close > indicators.ma20) score += 15;
  if (indicators.ma5 && indicators.ma20 && indicators.ma5 > indicators.ma20) score += 10;
  if (indicators.ma60 && indicators.close > indicators.ma60) score += 5;

  // 动量 20
  if ((indicators.ret5 ?? 0) > 0) score += 5;
  if ((indicators.ret20 ?? 0) > 0) score += 10;
  if ((indicators.ret60 ?? 0) > 0) score += 5;

  // 位置 15
  if (indicators.high20 && indicators.close) {
    const distance = ((indicators.high20 - indicators.close) / indicators.high20) * 100;
    if (distance <= 5) score += 10;
    else if (distance <= 10) score += 5;
  }
  if (indicators.ma20 && indicators.close) {
    const distance = ((indicators.close - indicators.ma20) / indicators.ma20) * 100;
    if (distance >= -8 && distance <= 8) score += 5;
  }

  // 流动性与量能 20
  const amount = indicators.avgAmount20 ?? 0;
  if (amount >= 200_000_000) score += 10;
  else if (amount >= 100_000_000) score += 5;
  if (amount >= 500_000_000) score += 5;
  if ((row.turnoverPct ?? 0) >= 3 && (row.turnoverPct ?? 0) <= 15) score += 5;

  // 波动率 15：太死或太疯都降分
  const atrPct =
    indicators.atr20 && indicators.close ? (indicators.atr20 / indicators.close) * 100 : undefined;
  if (atrPct !== undefined) {
    if (atrPct >= 2 && atrPct <= 6) score += 10;
    else if (atrPct >= 1 && atrPct <= 8) score += 5;
  }

  return Math.min(100, score);
}

/** 全市场基础过滤：价格、ST、停牌、指数成分等 */
function baseUniverse(rows: SnapshotRow[]): SnapshotRow[] {
  return rows.filter(
    (row) =>
      row.price > 0 &&
      !row.st &&
      !row.status?.includes("停") &&
      row.amount > 0 &&
      row.board !== "index" &&
      row.board !== "board",
  );
}

export async function selectTopWatchlist(
  limit = 10,
  onProgress?: (message: string) => void,
  options: { refresh?: boolean } = {},
): Promise<WatchItem[]> {
  onProgress?.(
    options.refresh ? "刷新全市场快照与日线指标（收盘后选股）…" : "读取全市场快照与日线指标…",
  );
  const [loaded, indicators] = await Promise.all([
    loadSnapshot({ refresh: options.refresh }),
    loadIndicators({
      refresh: options.refresh,
      onProgress: (done, total) => {
        if (done === total || done % 1000 === 0) {
          onProgress?.(`重算日线指标 ${done}/${total}…`);
        }
      },
    }),
  ]);
  const universe = baseUniverse(loaded.snapshot.rows);

  // 1) 日线 MACD 柱体回升（缓存指标，零额外请求）
  const daily = universe.filter((row) => {
    const ind = indicators.get(row.code);
    return (
      ind?.macdHist !== undefined &&
      ind.macdHistPrev !== undefined &&
      ind.macdHist > ind.macdHistPrev
    );
  });
  onProgress?.(`日线 MACD 回升 ${daily.length}/${universe.length}`);

  // 2) 周线 MACD 柱体回升（截止最近一次周末）
  let done = 0;
  const weekly = (
    await mapLimit(
      daily,
      async (row) => {
        try {
          const bars = dropIncompleteWeek(
            await fetchBars(row.code, { period: "week", adjust: "backward", limit: 80 }),
          );
          return macdRising(bars) ? row : null;
        } catch {
          return null;
        } finally {
          done += 1;
          if (done % 200 === 0) onProgress?.(`周线 MACD 检查 ${done}/${daily.length}…`);
        }
      },
      6,
    )
  ).filter((row): row is SnapshotRow => row !== null);
  onProgress?.(`周线 MACD 回升 ${weekly.length}`);

  // 3) 月线 MACD 柱体回升（当月未走完，按当前月线比较）
  done = 0;
  const monthly = (
    await mapLimit(
      weekly,
      async (row) => {
        try {
          const bars = await fetchBars(row.code, {
            period: "month",
            adjust: "backward",
            limit: 60,
          });
          return macdRising(bars) ? row : null;
        } catch {
          return null;
        } finally {
          done += 1;
          if (done % 100 === 0) onProgress?.(`月线 MACD 检查 ${done}/${weekly.length}…`);
        }
      },
      6,
    )
  ).filter((row): row is SnapshotRow => row !== null);
  onProgress?.(`月线 MACD 回升 ${monthly.length}`);

  // 4) 日线详细评分，取前 10，不足不补；同分按成交额、20 日动量排序
  const scored: WatchItem[] = monthly
    .map((row) => {
      const ind = indicators.get(row.code);
      return {
        row,
        score: scoreDailyDetailed(row, ind),
        amount: row.amount,
        ret20: ind?.ret20 ?? 0,
      };
    })
    .sort((a, b) => b.score - a.score || b.amount - a.amount || b.ret20 - a.ret20)
    .slice(0, limit)
    .map((item) => ({
      code: item.row.code,
      name: item.row.name,
      score: item.score,
      reason: "MACD 日/周/月回升 + 日线评分",
      source: "select" as const,
      addedAt: new Date().toISOString(),
    }));

  onProgress?.(`选股完成 ${scored.length} 只，开始消息面检查…`);
  const withNews = await applyNewsAdjustments(scored, { onProgress });

  // 每日一次的 Agent 复核：只能剔除/重排，失败回退规则结果
  const reviewed = await reviewWithAgent(withNews, onProgress);
  if (reviewed.error) onProgress?.(`Agent 复核跳过：${reviewed.error}`);

  onProgress?.(
    `最终入选 ${reviewed.items.length} 只${reviewed.items.length < limit ? "（不足 10 只，不补）" : ""}`,
  );
  return reviewed.items;
}
