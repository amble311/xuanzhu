import {
  loadUniverse,
  readCache,
  writeCache,
  fetchQuote,
  isTradingTime,
  mapLimit,
  sessionKind,
  sessionLabel,
  type BoardKind,
  type Quote,
} from "../exchange/ashare";

/**
 * 全市场快照。
 *
 * 同花顺没有批量快照接口，一次全市场 = 5000+ 个请求（并发 16 约 30 秒、
 * gzip 后约 3.7MB）。因此策略是：
 * - **按需刷新**，不做常驻轮询（用户接受 ≤2 分钟延迟）；
 * - 交易时段缓存 2 分钟，非交易时段直接复用上一次结果（收盘快照当天有效）；
 * - 同一时刻只允许一个刷新在跑（single-flight），避免多个工具并发各扫一遍。
 */

export const SNAPSHOT_CACHE = "snapshot.json";
const SESSION_TTL_MS = 2 * 60 * 1000;
const IDLE_TTL_MS = 12 * 60 * 60 * 1000;

export interface SnapshotRow {
  code: string;
  name: string;
  price: number;
  preClose: number;
  pct: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  turnoverPct?: number;
  marketCap?: number;
  limitUp?: number;
  limitDown?: number;
  board: BoardKind;
  st: boolean;
  status?: string;
}

export interface IndexRow {
  code: string;
  name: string;
  price: number;
  pct: number;
}

export interface MarketSnapshot {
  /** 抓取完成时间（ISO） */
  asOf: string;
  /** 同花顺行情自带的时间（updateTime） */
  quotesAt?: string;
  /** 抓取时的时段 */
  session: string;
  /** 股票池规模与失败数 */
  universeSize: number;
  failed: number;
  indices: IndexRow[];
  rows: SnapshotRow[];
}

export interface SnapshotSummary {
  total: number;
  up: number;
  down: number;
  flat: number;
  limitUp: number;
  limitDown: number;
  /** 无有效价格（停牌 / 未开盘） */
  suspended: number;
  amount: number;
  byBoard: Record<string, number>;
  /** 涨跌幅分布（左开右闭），用于判断市场温度 */
  buckets: Array<{ label: string; count: number }>;
}

const INDEX_LIST: Array<{ code: string; label: string }> = [
  { code: "1A0001", label: "上证指数" },
  { code: "399001", label: "深证成指" },
  { code: "399006", label: "创业板指" },
  { code: "1B0300", label: "沪深300" },
  { code: "1B0905", label: "中证500" },
  { code: "1B0016", label: "上证50" },
];

const BUCKET_EDGES: Array<{ label: string; min: number; max: number }> = [
  { label: "≤-9.5%", min: -Infinity, max: -9.5 },
  { label: "-9.5%~-7%", min: -9.5, max: -7 },
  { label: "-7%~-5%", min: -7, max: -5 },
  { label: "-5%~-3%", min: -5, max: -3 },
  { label: "-3%~0", min: -3, max: 0 },
  { label: "0", min: 0, max: 0 },
  { label: "0~3%", min: 0, max: 3 },
  { label: "3%~5%", min: 3, max: 5 },
  { label: "5%~7%", min: 5, max: 7 },
  { label: "7%~9.5%", min: 7, max: 9.5 },
  { label: ">9.5%", min: 9.5, max: Infinity },
];

function toRow(quote: Quote): SnapshotRow {
  return {
    code: quote.code,
    name: quote.name,
    price: quote.price,
    preClose: quote.preClose,
    pct: quote.changePct,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    amount: quote.amount,
    turnoverPct: quote.turnoverPct,
    marketCap: quote.marketCap,
    limitUp: quote.limitUp,
    limitDown: quote.limitDown,
    board: quote.board,
    st: quote.st,
    status: quote.stockStatus,
  };
}

/** 聚合涨跌家数、涨跌停、成交额与分布 */
export function summarizeSnapshot(rows: SnapshotRow[]): SnapshotSummary {
  const summary: SnapshotSummary = {
    total: rows.length,
    up: 0,
    down: 0,
    flat: 0,
    limitUp: 0,
    limitDown: 0,
    suspended: 0,
    amount: 0,
    byBoard: {},
    buckets: BUCKET_EDGES.map((edge) => ({ label: edge.label, count: 0 })),
  };
  for (const row of rows) {
    if (row.price > 0) {
      if (row.pct > 0) summary.up += 1;
      else if (row.pct < 0) summary.down += 1;
      else summary.flat += 1;
    }
    if (row.price > 0 && row.limitUp && row.price >= row.limitUp - 0.001) summary.limitUp += 1;
    if (row.price > 0 && row.limitDown && row.price <= row.limitDown + 0.001) {
      summary.limitDown += 1;
    }
    summary.amount += row.amount;
    summary.byBoard[row.board] = (summary.byBoard[row.board] ?? 0) + 1;
    // 停牌 / 无行情不进涨跌幅分布
    if (row.price <= 0) {
      summary.suspended += 1;
      continue;
    }
    // 平盘单独一档，否则会落进「-3%~0」区间里
    if (row.pct === 0) {
      const zero = summary.buckets.findIndex((bucket) => bucket.label === "0");
      if (zero >= 0) summary.buckets[zero].count += 1;
      continue;
    }
    for (let index = 0; index < BUCKET_EDGES.length; index += 1) {
      const edge = BUCKET_EDGES[index];
      if (edge.label === "0") continue;
      if (row.pct > edge.min && row.pct <= edge.max) {
        summary.buckets[index].count += 1;
        break;
      }
    }
  }
  return summary;
}

/** 抓一次全市场快照（会先确保股票池存在） */
export async function refreshSnapshot(
  options: { onProgress?: (done: number, total: number) => void } = {},
): Promise<MarketSnapshot> {
  const universe = await loadUniverse();
  const codes = universe.map((stock) => stock.code);
  let done = 0;
  let failed = 0;

  const quotes = await mapLimit(codes, async (code) => {
    try {
      return await fetchQuote(code);
    } catch {
      failed += 1;
      return null;
    } finally {
      done += 1;
      options.onProgress?.(done, codes.length);
    }
  });

  const rows = quotes
    .filter((quote): quote is Quote => quote !== null)
    .map(toRow)
    .filter((row) => row.name.length > 0);

  const indices = await mapLimit(INDEX_LIST, async (item) => {
    try {
      const quote = await fetchQuote(item.code);
      return { code: item.code, name: item.label, price: quote.price, pct: quote.changePct };
    } catch {
      return null;
    }
  });

  const snapshot: MarketSnapshot = {
    asOf: new Date().toISOString(),
    quotesAt: quotes.find((quote) => quote?.updatedAt)?.updatedAt,
    session: sessionLabel(sessionKind()),
    universeSize: codes.length,
    failed,
    indices: indices.filter((item): item is IndexRow => item !== null),
    rows,
  };
  writeCache(SNAPSHOT_CACHE, snapshot);
  return snapshot;
}

export interface LoadedSnapshot {
  snapshot: MarketSnapshot;
  /** 是否超过了期望时效（工具/命令应提示「数据不是最新」） */
  stale: boolean;
  ageMs: number;
}

let inflight: Promise<MarketSnapshot> | undefined;

/**
 * 读快照；超过 TTL 时刷新。
 *
 * 交易时段 TTL 2 分钟，非交易时段 12 小时 —— 收盘后实时接口返回的就是收盘值，
 * 反复抓 5000 只既慢又没必要。
 */
export async function loadSnapshot(
  options: { refresh?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<LoadedSnapshot> {
  const ttl = isTradingTime() ? SESSION_TTL_MS : IDLE_TTL_MS;
  const cached = readCache<MarketSnapshot>(SNAPSHOT_CACHE, Number.POSITIVE_INFINITY);
  const ageMs = cached ? Date.now() - Date.parse(cached.updatedAt) : Number.POSITIVE_INFINITY;

  if (!options.refresh && cached && ageMs <= ttl) {
    return { snapshot: cached.value, stale: false, ageMs };
  }

  if (!inflight) {
    inflight = refreshSnapshot({ onProgress: options.onProgress }).finally(() => {
      inflight = undefined;
    });
  }
  const snapshot = await inflight;
  return { snapshot, stale: false, ageMs: 0 };
}
