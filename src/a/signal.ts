import { fetch15mBars, fetchBars, fetchQuote, mapLimit } from "../exchange/ashare";
import { score15m } from "./deep15";
import { computeIndicators, type Indicators } from "./indicators";
import { dropIncompleteWeek } from "./macd";
import { loadPaperAccount, type PaperAccount } from "./paper";
import { maxPositions, poolSize } from "./settings";
import {
  combineTrend,
  dailyTrend,
  monthlyTrend,
  weeklyTrend,
  type CombinedTrend,
  type CycleTrend,
} from "./trend";
import { orderedPool, type PoolEntry } from "./watchlist";

/**
 * 单只 A 股的「三周期 + 15 分钟」打分 —— 对齐 btc 的 `btc_signal`。
 *
 * 分工必须记住：
 * - **月 / 周 / 日只定方向**（各 -1/0/+1，任一 -1 或全 0 就不做，A 股只能做多）；
 * - **15 分钟做择时**（0–100，≥60 且形态成立才是「现在有机会」）；
 * - 这里只给结论与依据，**不下单** —— 买卖由巡检模型自己调 `a_order` 决策。
 *
 * 巡检与选股共用这一份实现，保证「同一只股票在两处的打分口径一致」。
 */

export interface StockSignal {
  code: string;
  name: string;
  /** 是否持仓（巡检时排最前） */
  held: boolean;
  position?: { qty: number; available: number; avgCost: number; pnlPct: number };
  price?: number;
  pct?: number;
  monthly: CycleTrend;
  weekly: CycleTrend;
  daily: CycleTrend;
  trend: CombinedTrend;
  intraday: { score: number; reason: string } | null;
  /** 方向闸门：`long` 才允许开新仓；`none` 不做；`unknown` 数据不足 */
  sideFilter: "long" | "none" | "unknown";
  /** 15 分钟择时：`now` 可以现在动手，`wait` 继续等 */
  entry: "now" | "wait" | "unknown";
  suggestion: "买入候选" | "持有" | "减仓/卖出" | "观望";
  /** 一行依据（写进巡检日志/结论用） */
  reason: string;
}

/** 15 分钟评分达到这个分数才算「现在有机会」（与 btc 的 60 分门槛一致） */
export const ENTRY_SCORE = 60;

export interface ScoreStockOptions {
  /** 复用的全市场日线指标（有则直接用，没有就按单只日线现算，避免全市场重算） */
  indicators?: Map<string, Indicators>;
  /** 复用的账本（判断持仓、可卖数量） */
  account?: PaperAccount;
}

function failed(reason: string): CycleTrend {
  return { score: null, reason };
}

export async function scoreStock(
  target: { code: string; name?: string; held?: boolean },
  options: ScoreStockOptions = {},
): Promise<StockSignal> {
  const code = target.code;
  const account = options.account ?? loadPaperAccount();
  const position = account.positions.find((item) => item.code === code);

  const quote = await fetchQuote(code).catch(() => null);

  const [weeklyBars, monthlyBars, shortBars, cachedDaily] = await Promise.all([
    fetchBars(code, { period: "week", adjust: "backward", limit: 80 }).catch(() => null),
    fetchBars(code, { period: "month", adjust: "backward", limit: 60 }).catch(() => null),
    fetch15mBars(code, 160).catch(() => null),
    // 日线指标：有全市场缓存就直接用；否则按这一只的日线现算（140 根一次请求，
    // 比触发一次全市场重算便宜得多）
    (async () => {
      const hit = options.indicators?.get(code);
      if (hit) return hit;
      const bars = await fetchBars(code, { period: "day", adjust: "backward", limit: 140 }).catch(
        () => null,
      );
      return bars ? computeIndicators(code, bars) : null;
    })(),
  ]);

  const weekly = weeklyBars ? weeklyTrend(dropIncompleteWeek(weeklyBars)) : failed("周线获取失败");
  const monthly = monthlyBars ? monthlyTrend(monthlyBars) : failed("月线获取失败");
  const daily = dailyTrend(cachedDaily ?? undefined);
  const trend = combineTrend(monthly, weekly, daily);
  const intraday = shortBars ? score15m(shortBars) : null;

  // 方向闸门与 btc 的 side_filter 同义：数据不足 = unknown，趋势不过 = none（不开新仓）
  const sideFilter: StockSignal["sideFilter"] = [monthly.score, weekly.score, daily.score].some(
    (score) => score === null,
  )
    ? "unknown"
    : trend.pass
      ? "long"
      : "none";

  const entry: StockSignal["entry"] =
    intraday === null ? "unknown" : intraday.score >= ENTRY_SCORE ? "now" : "wait";

  const held = Boolean(position);
  const heldCount = account.positions.filter((item) => item.qty > 0).length;
  const cap = maxPositions();
  let suggestion: StockSignal["suggestion"] = "观望";
  let cappedNote = "";
  if (held) {
    const bearish =
      monthly.score === -1 ||
      weekly.score === -1 ||
      daily.score === -1 ||
      (intraday !== null && intraday.score < 40);
    suggestion = bearish ? "减仓/卖出" : "持有";
  } else if (sideFilter === "long" && entry === "now") {
    if (heldCount >= cap) {
      // 池子容量 > 持仓上限：满了就只能换仓，不能当买入候选
      suggestion = "观望";
      cappedNote = `（持仓已达上限 ${cap} 只，要买只能先减/清一只）`;
    } else {
      suggestion = "买入候选";
    }
  }

  const reason =
    `${trend.reason}` +
    `（月 ${monthly.score ?? "?"} / 周 ${weekly.score ?? "?"} / 日 ${daily.score ?? "?"}）` +
    ` · ${intraday?.reason ?? "15m 数据不足"}${cappedNote}`;

  return {
    code,
    name: target.name ?? quote?.name ?? code,
    held,
    position: position
      ? {
          qty: position.qty,
          available: position.available,
          avgCost: position.avgCost,
          pnlPct: position.pnlPct,
        }
      : undefined,
    price: quote?.price,
    pct: quote?.changePct,
    monthly,
    weekly,
    daily,
    trend,
    intraday,
    sideFilter,
    entry,
    suggestion,
    reason,
  };
}

/**
 * 按巡检顺序轮询整个池子（**持仓优先**，池内共 `poolSize` 只，含持仓）。
 *
 * `concurrency` 刻意压到 3：每只要拉周线 + 月线 + 15 分钟（必要时再加日线）四份数据，
 * 5 只并发打满会被行情源限频。
 */
export async function scanPool(
  options: ScoreStockOptions & { pool?: PoolEntry[] } = {},
): Promise<StockSignal[]> {
  const account = options.account ?? loadPaperAccount();
  const pool =
    options.pool ??
    orderedPool(
      account.positions.map((item) => ({ code: item.code, name: item.name })),
      undefined,
      poolSize(),
    );
  return mapLimit(
    pool,
    (item) =>
      // 日线指标按需算：传了全市场缓存就用，否则每只现算 140 根日线
      scoreStock({ code: item.code, name: item.name, held: item.held }, {
        account,
        indicators: options.indicators,
      }),
    3,
  );
}

/** 一只股票的多行明细（`a_signal` 与巡检结论共用） */
export function formatSignal(signal: StockSignal): string {
  const score = (value: CycleTrend["score"]): string =>
    value === null ? "?" : value > 0 ? "+1" : `${value}`;
  const price = signal.price === undefined ? "—" : signal.price.toFixed(2);
  const pct = signal.pct === undefined ? "—" : `${signal.pct >= 0 ? "+" : ""}${signal.pct.toFixed(2)}%`;
  const lines = [
    `${signal.code} ${signal.name}${signal.held ? "（持仓）" : ""} 现价 ${price} ${pct}`,
    `  三周期：月 ${score(signal.monthly.score)} · 周 ${score(signal.weekly.score)} · 日 ${score(signal.daily.score)}` +
      ` → 方向闸门 ${signal.sideFilter}`,
    `  月线：${signal.monthly.reason}`,
    `  周线：${signal.weekly.reason}`,
    `  日线：${signal.daily.reason}`,
    `  15 分钟：${signal.intraday?.reason ?? "数据不足"} → 择时 ${signal.entry}`,
  ];
  if (signal.position) {
    lines.push(
      `  持仓：${signal.position.qty} 股（可卖 ${signal.position.available}）` +
        ` 成本 ${signal.position.avgCost.toFixed(2)} 盈亏 ${signal.position.pnlPct}%`,
    );
  }
  lines.push(`  建议：${signal.suggestion}`);
  return lines.join("\n");
}
