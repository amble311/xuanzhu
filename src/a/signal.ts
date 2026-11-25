import { fetch15mBars, fetchBars, fetchQuote, mapLimit, type Bar } from "../exchange/ashare";
import { openDailyBarStore, type BarPeriodKey, type DailyBarStore } from "./bar-store";
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
import { openingContext, type OpeningContext } from "./opening";
import { dropIncomplete15m, dropIncompleteMonth } from "./window";

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
  /** 今天开盘后的真实态势（高开/低开、相对开盘、量比、缺口）—— 决策必须结合它 */
  opening?: OpeningContext;
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

export interface DailyIndicatorDeps {
  /** 全市场日线指标缓存（巡检/工具应当传，省掉每只一次 140 根日线的请求） */
  indicators?: Map<string, Indicators>;
  /** 测试注入：替代 `fetchBars(day, 140)` */
  fetchDaily?: (code: string) => Promise<Bar[]>;
  /** 本地日线仓库；`undefined` 用默认库，`null` 禁用 */
  store?: DailyBarStore | null;
}

/**
 * 取一只股票的日线指标，三级兜底：
 * 1. 全市场缓存（正常路径，`readCachedIndicators()` 一次读 5500 只）；
 * 2. 单只拉 140 根日线现算（缓存缺失/过期时）；
 * 3. **本地日线仓库**（`cache/bars.db`）—— 网络抖动时用它，避免巡检把方向判成 unknown。
 *
 * 为什么必须有第 3 级：同花顺对连续请求会偶发失败，而 `a_signal` 一次要跑 5 只；
 * 以前任何一只的日线请求失败就直接「日线指标缺失 → unknown」，结论里看到的就是
 * 「日线数据不足」，而本地其实已经有一份完整的日线。
 */
export interface PeriodBarDeps {
  /** 本地日线仓库（周/月线缓存在同一库里）；`undefined` 用默认库，`null` 禁用 */
  store?: DailyBarStore | null;
  /** 测试注入：替代 `fetchBars(week|month)` */
  fetch?: (code: string, period: BarPeriodKey) => Promise<Bar[]>;
}

/**
 * 取数重试：同花顺的偶发失败大多是网关 502（实测 600886 周线：第 1 次 502、
 * 第 2 次就好）。再试一次的成本远低于「整只股票方向变 unknown」。
 */
async function fetchWithRetry<T>(task: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (index < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  throw lastError;
}

/**
 * 周线 / 月线：**先取网络，失败用上次成功的结果兜底**。
 *
 * 巡检每轮要给池内每只各拉一次周线（80 根）与月线（60 根），同花顺连续请求会偶发失败。
 * 失败一次就 `weeklyTrend → null` → 三周期 unknown，结论里显示「周线获取失败 / 月线失败」。
 * 周线一周才更新一次、月线更慢，用上一次成功的序列顶一下完全够用 ——
 * 顶不上（从没成功过）才返回 null，让结论如实说数据缺失。
 */
export async function periodBarsFor(
  code: string,
  period: BarPeriodKey,
  limit: number,
  deps: PeriodBarDeps = {},
): Promise<Bar[] | null> {
  const store = deps.store === undefined ? openDailyBarStore() : deps.store;
  const fetchPeriod =
    deps.fetch ??
    ((target: string, kind: BarPeriodKey) =>
      fetchBars(target, { period: kind, adjust: "backward", limit }));
  try {
    const bars = await fetchWithRetry(() => fetchPeriod(code, period));
    if (bars.length > 0) {
      store?.upsertPeriod(code, period, bars);
      return bars;
    }
  } catch {
    // 两次都失败：走缓存（下面统一读）
  }
  const cached = store?.loadPeriod(code, period, limit) ?? [];
  return cached.length > 0 ? cached : null;
}

export async function dailyIndicatorsFor(
  code: string,
  deps: DailyIndicatorDeps = {},
): Promise<Indicators | null> {
  const hit = deps.indicators?.get(code);
  if (hit) return hit;

  const fetchDaily =
    deps.fetchDaily ??
    ((target: string) =>
      fetchBars(target, { period: "day", adjust: "backward", limit: 140 }));
  const bars = await fetchWithRetry(() => fetchDaily(code)).catch(() => null);
  if (bars && bars.length > 0) return computeIndicators(code, bars);

  const store = deps.store === undefined ? openDailyBarStore() : deps.store;
  const stored = store?.load(code, 140) ?? [];
  return stored.length > 0 ? computeIndicators(code, stored) : null;
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
    // 周/月线：网络失败时用上次成功的缓存顶上（见 periodBarsFor）
    periodBarsFor(code, "week", 80),
    periodBarsFor(code, "month", 60),
    fetch15mBars(code, 160).catch(() => null),
    // 日线指标：全市场缓存 → 单只现算 → 本地日线仓库兜底（见 dailyIndicatorsFor）
    dailyIndicatorsFor(code, { indicators: options.indicators }),
  ]);

  const now = new Date();
  const weekly = weeklyBars
    ? weeklyTrend(dropIncompleteWeek(weeklyBars, now))
    : failed("周线获取失败");
  // 月线同样剔除「本月还没走完」的那根：月初几天用半根月线算 MA/ADX 会失真
  const monthly = monthlyBars
    ? monthlyTrend(dropIncompleteMonth(monthlyBars, now))
    : failed("月线获取失败");
  const daily = dailyTrend(cachedDaily ?? undefined);
  const trend = combineTrend(monthly, weekly, daily);
  // 15m 评分只用**已走完**的 K 线（结构/量能要稳定）；
  // 「当前这一根 + 开盘缺口 + 量比」由 opening 补上，避免拿昨晚的日线给今天的开盘下单。
  const intraday = shortBars ? score15m(dropIncomplete15m(shortBars, now)) : null;
  const opening = openingContext(quote, cachedDaily ?? undefined, now);

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
    ` · ${intraday?.reason ?? "15m 数据不足"}` +
    ` · ${opening.text}` +
    `${cappedNote}`;

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
    opening,
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

/**
 * 全池横评（按**本轮实时** 15m 分排序 + 换仓参考）。
 *
 * 为什么要单独一块：`a_signal` 的遍历顺序来自 `orderedPool()`，用的是**收盘选股时**
 * 写入的静态分（`watchlist.json` 的 `score`）。巡检期间池子不变，但强弱是变化的 ——
 * 只看逐只明细，模型容易「每只都还行」就都不动，或者让最弱的持仓一直占着名额。
 *
 * 这里不替模型做决定，只把比较摆出来：排名、最弱持仓 vs 最强候选、分差与建议阈值。
 */
export function formatPoolRanking(signals: StockSignal[]): string {
  if (signals.length === 0) return "";
  const scoreOf = (signal: StockSignal): number => signal.intraday?.score ?? -1;
  const shown = (signal: StockSignal): string =>
    signal.intraday ? String(signal.intraday.score) : "?";
  const tagOf = (signal: StockSignal): string => {
    if (signal.sideFilter === "long") {
      return signal.entry === "now"
        ? "方向多·可买"
        : signal.entry === "wait"
          ? "方向多·等时机"
          : "方向多·15m 数据不足";
    }
    return signal.sideFilter === "none" ? "方向不做" : "数据不足";
  };

  const sorted = [...signals].sort((a, b) => scoreOf(b) - scoreOf(a));
  const lines = ["全池横评（按本轮实时 15m 分排序，顺序与上面的逐只明细可能不同）："];
  sorted.forEach((signal, index) => {
    lines.push(
      `  ${index + 1}. ${signal.code} ${signal.name}${signal.held ? "（持仓）" : ""}` +
        ` 15m ${shown(signal)} · ${tagOf(signal)}`,
    );
  });

  const weakness = sorted.filter((signal) => signal.held).sort((a, b) => scoreOf(a) - scoreOf(b))[0];
  const best = sorted
    .filter((signal) => !signal.held && signal.sideFilter === "long")
    .sort((a, b) => scoreOf(b) - scoreOf(a))[0];
  if (weakness && best) {
    const gap = scoreOf(best) - scoreOf(weakness);
    lines.push(
      `  换仓参考：最弱持仓 ${weakness.code} ${weakness.name} ${shown(weakness)} 分` +
        ` vs 最强候选 ${best.code} ${best.name} ${shown(best)} 分` +
        `（差 ${gap >= 0 ? "+" : ""}${gap}）` +
        (gap >= 20
          ? " → 差 ≥20：若候选 entry=now 且持仓方向已破坏，本轮应考虑换仓"
          : " → 差 <20：差额通常不足以覆盖手续费与滑点，倾向不换仓"),
    );
  } else if (weakness && !best) {
    lines.push("  换仓参考：池内暂无「方向可做」的非持仓候选，本轮不考虑换仓。");
  }
  return lines.join("\n");
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
    ...(signal.opening ? [`  开盘态势：${signal.opening.text}`] : []),
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
