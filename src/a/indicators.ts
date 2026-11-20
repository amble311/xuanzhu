import { macdSeries } from "./macd";
import { adx, rsi } from "./ta";
import {
  readCache,
  writeCache,
  fetchBars,
  loadUniverse,
  mapLimit,
  sessionKind,
  todayString,
  type Bar,
} from "../exchange/ashare";
import { openDailyBarStore, type DailyBarStore } from "./bar-store";
import type { SnapshotRow } from "./snapshot";

/**
 * 全市场预计算指标。
 *
 * 为什么不让筛选器现算：横截面筛选要遍历 5000+ 只，每只都拉 140 根日线
 * 等于每次筛选 60MB 流量、几分钟等待。指标每天只需要重算一次（收盘后），
 * 盘中筛选只读快照 + 这份表。
 *
 * 口径：后复权（`02`）。前复权在高分红股上早年为负，无法参与均线/涨幅计算。
 */

export const INDICATORS_CACHE = "indicators-v3.json";
// 36 小时：收盘后算一次，足够覆盖**下一个交易日全天**而不在盘中突然过期重算；
// 需要日内最新口径时显式 `xzh a sync`（指标本身按收盘价计算，盘中重算意义不大）。
const CACHE_TTL_MS = 36 * 60 * 60 * 1000;

export interface Indicators {
  code: string;
  /** 最后一根日线的日期 `YYYY-MM-DD` */
  asOf: string;
  /** 后复权收盘价 */
  close: number;
  ma5?: number;
  ma10?: number;
  ma20?: number;
  ma50?: number;
  ma60?: number;
  high20?: number;
  high60?: number;
  low20?: number;
  /** 区间涨幅（%） */
  ret5?: number;
  ret20?: number;
  ret60?: number;
  /** 近 N 日平均成交额（元） */
  avgAmount5?: number;
  avgAmount20?: number;
  /**
   * 20 日平均真实波幅（后复权价格单位）。
   *
   * 止损 / 仓位按 `atr20 / close` 的比例使用，因此后复权的绝对价格不影响结论。
   */
  atr20?: number;
  /** 日线 MACD 柱体（2×(DIF-DEA)），选股漏斗用它比较「今天是否比昨天高」 */
  macdHist?: number;
  macdHistPrev?: number;
  macdDif?: number;
  macdDea?: number;
  /** 日线 RSI14 / ADX14，用于三周期趋势打分 */
  rsi14?: number;
  adx14?: number;
  /** 参与计算的日线根数 */
  bars: number;
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(current: number, previous: number | undefined): number | undefined {
  if (!previous || !Number.isFinite(previous) || previous === 0) return undefined;
  return ((current - previous) / previous) * 100;
}

/**
 * 一根日线是否可用。
 *
 * 必须挡掉「占位 K 线」：实测 16:00 时同花顺对部分股票（601939 / 601328 / 601838）
 * 返回的当天日线是 `open/high/low = 0、volume = 0`、只有 close 有值 ——
 * 这种行一旦入库，`low20` 会算成 0，`dailyTrend()` 的 `!low20` 判定就让整只股票
 * 变成「日线指标不足」，巡检里看到的就是「日线数据不足」，而且**每天都复现**。
 */
export function isValidDailyBar(bar: Bar): boolean {
  return (
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.open > 0 &&
    bar.high > 0 &&
    bar.low > 0 &&
    bar.close > 0 &&
    bar.high >= bar.low
  );
}

/** 从升序日线计算指标；不足根数的字段留空（不要用 0 冒充） */
export function computeIndicators(code: string, input: Bar[]): Indicators | null {
  // 脏行（占位 K 线 / 数据源异常）直接剔除：宁可少一根，也不能让 low20 变成 0
  const bars = input.filter(isValidDailyBar);
  if (bars.length === 0) return null;
  const closes = bars.map((bar) => bar.close);
  const last = bars[bars.length - 1];
  const tail = (count: number) => closes.slice(-count);

  const ma = (count: number): number | undefined =>
    bars.length >= count ? average(tail(count)) : undefined;

  const recent = bars.slice(-20);
  const recent60 = bars.slice(-60);
  const amounts5 = bars.slice(-5).map((bar) => bar.amount);
  const amounts20 = bars.slice(-20).map((bar) => bar.amount);

  // 真实波幅：max(高-低, |高-昨收|, |低-昨收|)，取最近 20 根的均值
  const trueRanges: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const prevClose = bars[index - 1].close;
    trueRanges.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - prevClose),
        Math.abs(bar.low - prevClose),
      ),
    );
  }
  const atr20 = trueRanges.length >= 20 ? average(trueRanges.slice(-20)) : undefined;

  // MACD 需要足够长的 EMA 预热；不足时留空，选股时会自然排除
  let macdHist: number | undefined;
  let macdHistPrev: number | undefined;
  let macdDif: number | undefined;
  let macdDea: number | undefined;
  if (bars.length >= 37) {
    const series = macdSeries(bars);
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    macdHist = last?.hist;
    macdHistPrev = prev?.hist;
    macdDif = last?.dif;
    macdDea = last?.dea;
  }

  return {
    code,
    asOf: last.time.slice(0, 10),
    close: last.close,
    ma5: ma(5),
    ma10: ma(10),
    ma20: ma(20),
    ma50: ma(50),
    ma60: ma(60),
    high20: recent.length > 0 ? Math.max(...recent.map((bar) => bar.high)) : undefined,
    high60: recent60.length > 0 ? Math.max(...recent60.map((bar) => bar.high)) : undefined,
    low20: recent.length > 0 ? Math.min(...recent.map((bar) => bar.low)) : undefined,
    ret5: bars.length > 5 ? percentChange(last.close, closes[closes.length - 6]) : undefined,
    ret20: bars.length > 20 ? percentChange(last.close, closes[closes.length - 21]) : undefined,
    ret60: bars.length > 60 ? percentChange(last.close, closes[closes.length - 61]) : undefined,
    avgAmount5: average(amounts5.filter((value): value is number => Number.isFinite(value))),
    avgAmount20: average(amounts20.filter((value): value is number => Number.isFinite(value))),
    atr20,
    macdHist,
    macdHistPrev,
    macdDif,
    macdDea,
    rsi14: rsi(bars),
    adx14: adx(bars),
    bars: bars.length,
  };
}

export interface SnapshotBarSource {
  /** 快照所属交易日 `YYYY-MM-DD` */
  date: string;
  rows: Map<string, SnapshotRow>;
}

export interface BuildIndicatorsOptions {
  onProgress?: (done: number, total: number) => void;
  /** 只算一部分（调试 / 指定股票池） */
  codes?: string[];
  /**
   * 当日收盘快照：给出后，库里已有历史的股票**只补今天这一根**（原始价 × 复权比例），
   * 不再逐只重取 140 根。盘中快照不会落库（那一根还没收完）。
   */
  snapshot?: SnapshotBarSource;
  /** 日线仓库；`undefined` 用默认库，`null` 显式禁用（退回老路径） */
  store?: DailyBarStore | null;
  /** 基准时间（测试用） */
  now?: Date;
  /** 测试注入：替代 `fetchBars(day, 140)` */
  fetchDaily?: (code: string) => Promise<Bar[]>;
  /**
   * 每天抽样校对几只「刚补过今天」的股票（与官方日线比收盘），默认 3；
   * 0 = 关闭。校对不一致时按官方数据覆盖并重算，用来兜住复权比例漂移。
   */
  verifySample?: number;
}

/** 复权价按 2 位小数落库：与官方日线口径一致，避免浮点尾数在指标里累积 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 原始 bar × 复权比例 → 后复权 bar。
 *
 * 复权只改价格，成交量 / 成交额保持原值（同花顺的后复权口径同样不调量）。
 */
export function toAdjustedBar(row: SnapshotRow, date: string, ratio: number): Bar {
  return {
    time: date,
    open: round2(row.open * ratio),
    high: round2(row.high * ratio),
    low: round2(row.low * ratio),
    close: round2(row.price * ratio),
    volume: row.volume,
    amount: row.amount,
  };
}

/**
 * 除权检测：昨收（后复权）应该等于「今日原始 preClose × 旧 ratio」。
 *
 * 分红 / 送转当天，交易所给的 preClose 已经是除权后的价格，而库里的 ratio 还是旧的 ——
 * 两者一比就会差出一个除权幅度（通常 >1%）。偏差超过 `tolerance` 就判定除权，
 * 该股票必须整段重取（历史后复权价全变了），不能按旧 ratio 补今天的 bar。
 */
export function adjustmentChanged(
  prevAdjustedClose: number,
  rawPreClose: number,
  ratio: number,
  tolerance = 0.003,
): boolean {
  if (!(prevAdjustedClose > 0) || !(rawPreClose > 0) || !(ratio > 0)) return false;
  const expected = rawPreClose * ratio;
  return Math.abs(expected - prevAdjustedClose) / prevAdjustedClose > tolerance;
}

/** 「今天这根」是否已经收盘、可以落库 */
function appendPlan(
  snapshot: SnapshotBarSource | undefined,
  now: Date,
): SnapshotBarSource | undefined {
  if (!snapshot || snapshot.rows.size === 0) return undefined;
  // 盘中落库会把「没收完的那一根」写进历史，之后所有指标都被这根脏数据带偏
  if (sessionKind(now) !== "closed") return undefined;
  const today = todayString(now);
  // 周末 / 节假日拿到的是上一次的快照（quotesAt 不是今天），不能当成新的一根
  if (snapshot.date !== today) return undefined;
  return snapshot;
}

/**
 * 两个日期之间还有几个工作日（周一至周五，含头不含尾）。
 *
 * 用来判断「库里最后一根到目标日期之间，是不是漏了交易日」：
 * - 0 = 相邻交易日（周五 → 下周一也算 0），可以只补一根；
 * - >0 = 中间漏了交易日（进程停过 / 长假），历史不连续，必须整段重取。
 *
 * 故意不查交易日历：日历本身要拉指数日线（网络），而这里只做保守判断 ——
 * 长假后会多取一次全市场，代价可以接受，比用旧数据算错趋势好得多。
 */
export function weekdayGap(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let gap = 0;
  for (let at = start + 86_400_000; at < end; at += 86_400_000) {
    const day = new Date(at).getUTCDay();
    if (day !== 0 && day !== 6) gap += 1;
  }
  return gap;
}

/**
 * 批量取日线并计算指标。
 *
 * 有日线仓库时走**增量**：只对「库里没有 / 落后太多 / 除权了」的代码发请求，
 * 其余直接读库 + 补今天一根。没有 `node:sqlite`（或显式 `store: null`）时行为与以前一致。
 */
export interface BuildIndicatorsResult {
  items: Indicators[];
  failed: number;
  /** 直接读库的只数 */
  reused: number;
  /** 走了网络请求的只数 */
  fetched: number;
  /** 抽样校对发现的差异只数（已按官方数据覆盖） */
  mismatched: number;
}

/**
 * 盘中取回的日线里，最后一根可能是**还没收盘**的当天 K 线。
 *
 * 绝不能把它写进仓库：A 股一天只有一根，写进去之后「今天」就变成过去时，
 * 第二天再也分不清这根是收盘价还是 14:00 的价格 —— 指标会永久带着这个错误。
 * 因此未收盘时统一丢掉落库，等收盘后再用快照补一根最终的。
 */
export function dropUnclosedDaily(now: Date, bars: Bar[]): Bar[] {
  if (bars.length === 0) return bars;
  // 占位 K 线（OHLC 为 0）任何时候都不能留：它不是「没收盘」，而是**坏数据**
  const clean = bars.filter(isValidDailyBar);
  if (clean.length === 0 || sessionKind(now) === "closed") return clean;
  const last = clean[clean.length - 1];
  return last.time.slice(0, 10) === todayString(now) ? clean.slice(0, -1) : clean;
}

/**
 * 构建全市场指标（有日线仓库时走增量）。
 *
 * **数据新鲜度不变量**（回答「盘中更新后崩了怎么保证正确」）：
 * 1. 只有当 `sessionKind(now) === "closed"`、且快照就是当天的，才把「今天」写进仓库；
 * 2. 盘中取回的官方日线里，若最后一根是当天，直接丢掉（`dropUnclosedDaily`）——
 *    宁可少一根，也不把没收盘的价格当真收盘；
 * 3. 每根 bar 与 `meta` 在同一个事务里写入，崩溃只会「这根没写」，不会写一半；
 * 4. 重启后若库内 `lastDate` 与目标日期之间漏了交易日（`weekdayGap > 0`），
 *    该股票整段重取 —— 崩溃/停机漏掉的交易日会在这里补回来；
 * 5. 每天抽样校对少量「刚补过今天」的股票（`verifySample`，默认 3 只）：
 *    与官方日线收盘差超过 0.5% 就按官方覆盖重算，及早发现复权/数据源口径问题。
 */
export async function buildIndicators(
  codes: string[],
  options: BuildIndicatorsOptions = {},
): Promise<BuildIndicatorsResult> {
  let done = 0;
  let failed = 0;
  let reused = 0;
  let fetched = 0;
  let mismatched = 0;
  const now = options.now ?? new Date();
  const store = options.store === undefined ? openDailyBarStore() : options.store;
  const snapshot = store ? appendPlan(options.snapshot, now) : undefined;
  const today = todayString(now);
  const fetchDaily =
    options.fetchDaily ??
    ((code: string) =>
      fetchBars(code, { period: "day", adjust: "backward", limit: 140 }));
  /** 「今天这根」是刚补/刚确认的代码：抽样校对只挑这些人（它们最可能出错） */
  const appended: string[] = [];

  const rows = await mapLimit(codes, async (code) => {
    try {
      const saved = store?.meta(code);
      let bars = saved ? store!.load(code, 140) : [];
      let fromStore = Boolean(saved) && bars.length >= 140;

      // 库里最后一根是占位 K 线（open/high/low = 0）→ 既不能拿它算指标，也不能认为
      // 「今天已入库」；整段重取一次，顺便把 ratio 按正确口径重算。
      if (fromStore && bars.length > 0 && !isValidDailyBar(bars[bars.length - 1])) {
        fromStore = false;
      }

      // 库里漏了交易日 → 历史不连续，老数据算出来的三周期是错的，整段重取。
      // 有当日快照时严格判断（漏一天就重取）；没有快照时容忍 2 个工作日（长假）。
      if (fromStore && saved) {
        const stale = snapshot
          ? saved.lastDate < snapshot.date && weekdayGap(saved.lastDate, snapshot.date) > 0
          : weekdayGap(saved.lastDate, today) > 2;
        if (stale) fromStore = false;
      }

      if (fromStore && saved && snapshot && bars.length > 0) {
        const quote = snapshot.rows.get(code);
        const last = bars[bars.length - 1];
        if (
          quote &&
          saved.ratio > 0 &&
          saved.lastDate < snapshot.date &&
          quote.price > 0 &&
          quote.open > 0 &&
          quote.high > 0 &&
          quote.low > 0 &&
          quote.volume > 0
        ) {
          if (adjustmentChanged(last.close, quote.preClose, saved.ratio)) {
            // 除权：历史后复权价全部失效，按新口径整段重取
            fromStore = false;
          } else {
            const bar = toAdjustedBar(quote, snapshot.date, saved.ratio);
            store!.append(code, bar, {
              code,
              ratio: saved.ratio,
              lastDate: snapshot.date,
              rawClose: quote.price,
              updatedAt: now.toISOString(),
            });
            bars = store!.load(code, 140);
            appended.push(code);
          }
        }
      }

      if (!fromStore) {
        // 盘中取回的最后那根是「正在走」的，不能入库（见函数注释的不变量 2）
        const fresh = dropUnclosedDaily(now, await fetchDaily(code));
        const last = fresh[fresh.length - 1];
        const lastDate = last?.time.slice(0, 10) ?? "";
        // 复权比例 = 后复权价 / 原始价。两种取法：
        // ① 官方日线已包含快照当天 → 用「后复权收盘 / 当日原始价」；
        // ② 官方日线还停在昨天（实测 21:00 时部分股票仍只到前一交易日）→
        //    用「最后一根后复权收盘 / 快照的 preClose」（preClose 就是那一天的原始收盘）。
        // 取不到就记 0：宁可让这只票明天多取一次，也不要猜一个比例把历史带偏。
        const quote = snapshot?.rows.get(code);
        let ratio = 0;
        if (quote && last && snapshot) {
          if (lastDate === snapshot.date && quote.price > 0) {
            ratio = last.close / quote.price;
          } else if (quote.preClose > 0 && weekdayGap(lastDate, snapshot.date) === 0) {
            ratio = last.close / quote.preClose;
          }
        }
        store?.upsert(code, fresh, {
          code,
          ratio,
          lastDate,
          rawClose: quote?.price ?? 0,
          updatedAt: now.toISOString(),
        });
        bars = fresh;
        fetched += 1;
      } else {
        reused += 1;
      }

      return computeIndicators(code, bars);
    } catch {
      failed += 1;
      return null;
    } finally {
      done += 1;
      options.onProgress?.(done, codes.length);
    }
  });

  const items = rows.filter((row): row is Indicators => row !== null);

  // 抽样校对：只挑「今天这根刚补过」的股票，与官方日线比收盘价。
  // 差异 >0.5% 视为增量结果有问题（复权比例漂移 / 快照口径不对），按官方覆盖重算。
  const sampleSize = Math.min(
    Math.max(0, Math.floor(options.verifySample ?? 3)),
    appended.length,
  );
  if (store && snapshot && sampleSize > 0) {
    for (const code of appended.slice(0, sampleSize)) {
      try {
        const official = dropUnclosedDaily(now, await fetchDaily(code));
        const last = official[official.length - 1];
        const index = items.findIndex((item) => item.code === code);
        const item = index >= 0 ? items[index] : undefined;
        if (!last || !item || last.time.slice(0, 10) !== item.asOf) continue;
        if (Math.abs(last.close - item.close) / Math.max(item.close, 1e-9) <= 0.005) continue;

        const quote = snapshot.rows.get(code);
        const lastDate = last.time.slice(0, 10);
        const ratio =
          quote && quote.price > 0 && lastDate === snapshot.date
            ? last.close / quote.price
            : store.meta(code)?.ratio ?? 0;
        store.upsert(code, official, {
          code,
          ratio,
          lastDate,
          rawClose: quote?.price ?? 0,
          updatedAt: now.toISOString(),
        });
        const fixed = computeIndicators(code, official);
        if (fixed) items[index] = fixed;
        mismatched += 1;
      } catch {
        // 校对失败只影响这一次的可信度标注，不打断整体构建
      }
    }
  }

  return { items, failed, reused, fetched, mismatched };
}

/**
 * **只读**指标缓存，缺了/过期返回 undefined，**不触发全市场重算**。
 *
 * 给「只给几只股票补分数」的场景用（收盘选股的持仓打分段）：那时日线指标要么刚由
 * 选股流程刷过、要么完全没有 —— 没有就按单只日线现算，绝不能因为一只股票把
 * 5000+ 只重算一遍（1–2 分钟），更不能把全市场缓存覆盖成 5 条。
 */
export function readCachedIndicators(): Map<string, Indicators> | undefined {
  const cached = readCache<Indicators[]>(INDICATORS_CACHE, CACHE_TTL_MS);
  if (!cached) return undefined;
  return new Map(cached.value.map((item) => [item.code, item]));
}

export async function loadIndicators(
  options: {
    refresh?: boolean;
    codes?: string[];
    /**
     * 允许「部分缓存」：老版本收盘选股后会把指标裁剪成只剩自选池（`complete:false`）。
     * 巡检 / 风控只查池内股票，用部分缓存就够，不必为了 5 只把全市场重算一遍；
     * 全市场筛选（`a_screen` / 选股）**不能**传它，否则拿 5 条数据当全市场。
     */
    allowPartial?: boolean;
    /** 缺缓存时会全市场重算，进度回调给工具/CLI 显示 */
    onProgress?: (done: number, total: number) => void;
    /** 当日收盘快照：有它就能「只补今天一根」，不必逐只重取 140 根 */
    snapshot?: SnapshotBarSource;
    /** 日线仓库注入（测试用）；默认用 `<XZH_A_HOME>/cache/bars.db` */
    store?: DailyBarStore | null;
  } = {},
): Promise<Map<string, Indicators>> {
  if (!options.refresh) {
    const cached = readCache<Indicators[]>(INDICATORS_CACHE, CACHE_TTL_MS);
    if (cached && (cached.complete !== false || options.allowPartial)) {
      // 缓存「没过 TTL」不等于「是今天收盘的」：昨天 16:00 写入的指标到今天晚上仍在新旧
      // 36 小时窗口内，但快照已经是今天收盘 —— 这时候必须按快照补今天那根。
      // 判定用「缓存里最新的一根」而不是逐只：停牌股本来就停在旧日期，不该拖累整体。
      const snapshot = options.snapshot;
      const afterClose =
        snapshot &&
        sessionKind(new Date()) === "closed" &&
        snapshot.date === todayString();
      const newest = cached.value.reduce(
        (latest, item) => (item.asOf > latest ? item.asOf : latest),
        "",
      );
      if (!afterClose || newest >= snapshot!.date) {
        return new Map(cached.value.map((item) => [item.code, item]));
      }
    }
  }
  const codes =
    options.codes && options.codes.length > 0
      ? options.codes
      : (await loadUniverse()).map((stock) => stock.code);
  const { items } = await buildIndicators(codes, {
    onProgress: options.onProgress,
    snapshot: options.snapshot,
    store: options.store,
  });
  if (items.length > 0) writeCache(INDICATORS_CACHE, items);
  return new Map(items.map((item) => [item.code, item]));
}
