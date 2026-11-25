import { fetch15mBars, fetchBars, mapLimit } from "../exchange/ashare";
import {
  computeIndicators,
  loadIndicators,
  readCachedIndicators,
  type Indicators,
} from "./indicators";
import { dropIncompleteWeek } from "./macd";
import { loadSnapshot, type SnapshotRow } from "./snapshot";
import { applyNewsAdjustments } from "./news";
import { score15m } from "./deep15";
import { combineTrend, dailyTrend, monthlyTrend, weeklyTrend, type CycleTrend } from "./trend";
import { poolSize } from "./settings";
import { dropIncomplete15m, dropIncompleteMonth } from "./window";
import type { WatchItem } from "./watchlist";

/**
 * A 股选股：三周期趋势过滤 + 15 分钟深度技术分析 + 消息面打分。
 *
 * 1. 月/周/日各算 -1 / 0 / +1；任一周期 -1、数据不足、三周期全 0、**日线不是 +1**
 *    都丢弃（最短周期必须与做多方向同向）；
 * 2. 非涨停，按趋势强度和成交额取前 20；
 * 3. 对 20 只逐只拉 15 分钟 K 线，做结构/位置/动量/量能/形态评分（0–100）；
 * 4. 消息面硬否决 + ±10 微调，按最终得分取前 `poolSize` 只（默认 5，含持仓），不足不补。
 *
 * 选股不看 MACD 单指标，也不在盘中执行；固定由收盘后 16:00 任务调用。
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

/**
 * 本轮还需要新选几只：**池子容量 − 现有持仓数**（`xzh a` 的选股口径）。
 *
 * 池子含持仓（默认 5 只），持仓已经是池子的占用，所以只补差额；
 * 满仓返回 0（此时不该再跑全市场筛选，省掉一轮全市场抓取与指标重算）。
 */
export function selectionNeed(size: number, heldCount: number): number {
  return Math.max(0, Math.floor(size) - Math.max(0, Math.floor(heldCount)));
}

/**
 * 收盘后给**持仓**单独打分（与选股同一口径）。
 *
 * 为什么需要：选股只对「全市场三周期过滤后的前 20 只」做 15 分钟深度评分，
 * 持仓通常不在那 20 只里 —— 于是 `mergeWatchlist()` 只能给它记 0 分 +
 * 「已持仓，强制保留」，面板和推送里看不出这只持仓还行不行（100 分的票和
 * 快跌破 MA20 的票长得一模一样）。
 *
 * 这里按与选股**完全相同**的算法逐只现算：月/周/日趋势 + 15 分钟 0–100 评分，
 * 理由格式也一致（`趋势 月+1/周+1/日-1 · 15m 42 分 wait`）。
 *
 * 只补分数，不做筛选：持仓不参与新闻否决与排名淘汰，分低也照样留在池内。
 */
export async function scoreHeldItems(
  held: Array<{ code: string; name: string }>,
  onProgress?: (message: string) => void,
): Promise<WatchItem[]> {
  if (held.length === 0) return [];
  // 只读缓存：缺了就让每只自己算 140 根日线（下面 `dailyBars` 分支），
  // 不能在这里触发全市场重算 —— 满仓时选股流程根本没跑过，缓存是空的。
  const indicators = readCachedIndicators();
  onProgress?.(`持仓打分：${held.length} 只（三周期 + 15 分钟，口径同选股）…`);

  let done = 0;
  return mapLimit(
    held,
    async (position) => {
      try {
        const [weekBars, monthBars, shortBars, dailyBars] = await Promise.all([
          fetchBars(position.code, { period: "week", adjust: "backward", limit: 80 }).catch(
            () => null,
          ),
          fetchBars(position.code, { period: "month", adjust: "backward", limit: 60 }).catch(
            () => null,
          ),
          fetch15mBars(position.code, 160).catch(() => null),
          indicators?.get(position.code)
            ? Promise.resolve(null)
            : fetchBars(position.code, { period: "day", adjust: "backward", limit: 140 }).catch(
                () => null,
              ),
        ]);

        const dailyIndicators =
          indicators?.get(position.code) ??
          (dailyBars ? computeIndicators(position.code, dailyBars) : undefined);
        const daily = dailyTrend(dailyIndicators ?? undefined);
        const now = new Date();
        const weekly = weekBars
          ? weeklyTrend(dropIncompleteWeek(weekBars, now))
          : { score: null, reason: "周线获取失败" };
        const monthly = monthBars
          ? monthlyTrend(dropIncompleteMonth(monthBars, now))
          : { score: null, reason: "月线获取失败" };
        const trend = combineTrend(monthly, weekly, daily);
        // 15m 只用走完的 K 线（否则 09:30 拿几十秒的 K 线打分）
        const deep = shortBars ? score15m(dropIncomplete15m(shortBars, now)) : null;

        return {
          code: position.code,
          name: position.name,
          score: deep?.score ?? 0,
          reason:
            `趋势 ${trend.reason} · ${deep?.reason ?? "15m 数据不足（0 分）"} · 持仓保留`,
          source: "held" as const,
          addedAt: new Date().toISOString(),
        } satisfies WatchItem;
      } catch (err) {
        return {
          code: position.code,
          name: position.name,
          score: 0,
          reason: `打分失败（${err instanceof Error ? err.message : String(err)}）· 持仓保留`,
          source: "held" as const,
          addedAt: new Date().toISOString(),
        } satisfies WatchItem;
      } finally {
        done += 1;
        if (done === held.length) onProgress?.(`持仓打分完成 ${done}/${held.length}`);
      }
    },
    3,
  );
}

export async function selectTopWatchlist(
  limit = poolSize(),
  onProgress?: (message: string) => void,
  options: { refresh?: boolean } = {},
): Promise<WatchItem[]> {
  onProgress?.(
    options.refresh ? "刷新全市场快照与日线指标（收盘后选股）…" : "读取全市场快照与日线指标…",
  );
  // 先拿快照，再算指标：快照里今天的 OHLCV 就是「缺的那一根」，
  // 指标可以据此只补当天数据，不用对 5000+ 只各重取 140 根日线
  const loaded = await loadSnapshot({ refresh: options.refresh });
  const snapshotDate = (
    loaded.snapshot.quotesAt ?? loaded.snapshot.asOf
  ).slice(0, 10);
  const indicators = await loadIndicators({
    refresh: options.refresh,
    snapshot: {
      date: snapshotDate,
      rows: new Map(loaded.snapshot.rows.map((row) => [row.code, row])),
    },
    onProgress: (done, total) => {
      if (done === total || done % 1000 === 0) {
        onProgress?.(`更新日线指标 ${done}/${total}…`);
      }
    },
  });
  const universe = baseUniverse(loaded.snapshot.rows);

  // 1) 日线趋势：缓存指标计算，-1 / 数据不足直接丢弃
  const dailyPass: Array<{ row: SnapshotRow; daily: CycleTrend }> = [];
  for (const row of universe) {
    const daily = dailyTrend(indicators.get(row.code));
    if (daily.score === null || daily.score === -1) continue;
    dailyPass.push({ row, daily });
  }
  onProgress?.(`日线趋势通过 ${dailyPass.length}/${universe.length}`);

  // 2) 周线趋势（截止最近一次完整周末）
  let done = 0;
  const weeklyPass = (
    await mapLimit(
      dailyPass,
      async (item) => {
        try {
          const bars = dropIncompleteWeek(
            await fetchBars(item.row.code, { period: "week", adjust: "backward", limit: 80 }),
          );
          const weekly = weeklyTrend(bars);
          if (weekly.score === null || weekly.score === -1) return null;
          return { ...item, weekly };
        } catch {
          return null;
        } finally {
          done += 1;
          if (done % 200 === 0) onProgress?.(`周线趋势检查 ${done}/${dailyPass.length}…`);
        }
      },
      6,
    )
  ).filter((item): item is { row: SnapshotRow; daily: CycleTrend; weekly: CycleTrend } => item !== null);
  onProgress?.(`周线趋势通过 ${weeklyPass.length}`);

  // 3) 月线趋势（包含当月未走完）
  done = 0;
  const monthlyPass = (
    await mapLimit(
      weeklyPass,
      async (item) => {
        try {
          const bars = await fetchBars(item.row.code, {
            period: "month",
            adjust: "backward",
            limit: 60,
          });
          const monthly = monthlyTrend(dropIncompleteMonth(bars));
          if (monthly.score === null || monthly.score === -1) return null;
          return { ...item, monthly };
        } catch {
          return null;
        } finally {
          done += 1;
          if (done % 100 === 0) onProgress?.(`月线趋势检查 ${done}/${weeklyPass.length}…`);
        }
      },
      6,
    )
  ).filter(
    (item): item is {
      row: SnapshotRow;
      daily: CycleTrend;
      weekly: CycleTrend;
      monthly: CycleTrend;
    } => item !== null,
  );

  // 4) 三周期合成：任一向下 / 全 0 / 日线不是 +1 都丢弃
  const trendPass = monthlyPass
    .map((item) => ({ ...item, trend: combineTrend(item.monthly, item.weekly, item.daily) }))
    .filter((item) => item.trend.pass);
  onProgress?.(`三周期趋势通过 ${trendPass.length}`);

  // 5) 非涨停，按趋势强度/成交额取前 20，做 15 分钟深度分析
  const shortlist = trendPass
    .filter((item) => {
      const row = item.row;
      return !(row.limitUp && row.price >= row.limitUp - 0.001);
    })
    .sort(
      (a, b) =>
        b.trend.sum - a.trend.sum ||
        b.row.amount - a.row.amount,
    )
    .slice(0, 20);
  onProgress?.(`非涨停趋势池 ${shortlist.length}/20，开始 15 分钟深度分析…`);

  done = 0;
  const analyzed = await mapLimit(
    shortlist,
    async (item) => {
      const deep = await fetch15mBars(item.row.code, 160)
        .then((bars) => score15m(dropIncomplete15m(bars)))
        .catch(() => null);
      done += 1;
      if (done % 5 === 0) onProgress?.(`15 分钟分析 ${done}/${shortlist.length}…`);
      return {
        code: item.row.code,
        name: item.row.name,
        score: deep?.score ?? 0,
        reason:
          `趋势 ${item.trend.reason} · ${deep?.reason ?? "15m 数据不足（0 分）"}`,
        source: "select" as const,
        addedAt: new Date().toISOString(),
      } satisfies WatchItem;
    },
    4,
  );

  // 6) 消息面：硬风险否决 + ±10 微调；最后按得分取前 5（不足不补）
  onProgress?.("15 分钟分析完成，开始消息面打分…");
  const withNews = await applyNewsAdjustments(analyzed, { onProgress });
  const final = withNews.sort((a, b) => b.score - a.score).slice(0, limit);
  onProgress?.(
    `最终入选 ${final.length} 只${final.length < limit ? `（不足 ${limit} 只，不补）` : ""}`,
  );
  return final;
}
