import type { BoardKind } from "../exchange/ashare";
import type { Indicators } from "./indicators";
import type { MarketSnapshot, SnapshotRow } from "./snapshot";

/**
 * 横截面筛选器。
 *
 * 只接受**白名单字段**的结构化条件，不接受 SQL / JS 字符串：
 * - 同样的条件可以复用给回测，保证「筛选口径」可复现；
 * - 条件写错只会筛出 0 只，不会执行任意代码。
 *
 * 数据分工：价格/涨跌幅/成交额/换手来自**实时快照**；均线、20/60 日高、
 * 区间涨幅来自**盘后预计算指标**。缺指标的股票在需要指标的筛选里会被跳过
 * 并计入 `skippedNoIndicators`，不会被当成「不满足」。
 */

export type RankField =
  | "pct"
  | "amount"
  | "turnover"
  | "marketCap"
  | "ret5"
  | "ret20"
  | "ma20Distance"
  | "high20Distance";

export interface ScreenCondition {
  boards?: BoardKind[];
  /** 默认 true（A 股筛选通常先排掉 ST） */
  excludeSt?: boolean;
  pctMin?: number;
  pctMax?: number;
  priceMin?: number;
  priceMax?: number;
  /** 成交额下限（元） */
  amountMin?: number;
  turnoverMin?: number;
  marketCapMin?: number;
  marketCapMax?: number;
  aboveMa5?: boolean;
  aboveMa10?: boolean;
  aboveMa20?: boolean;
  aboveMa60?: boolean;
  ret5Min?: number;
  ret20Min?: number;
  ret20Max?: number;
  /** 距 20 日最高价不超过 N%（越小越接近新高） */
  nearHigh20Pct?: number;
  rankBy?: RankField;
  order?: "asc" | "desc";
  /** 默认 20，上限 50 */
  limit?: number;
  offset?: number;
}

const BOARD_VALUES: BoardKind[] = ["sh-main", "sz-main", "gem", "star", "bse"];
const RANK_VALUES: RankField[] = [
  "pct",
  "amount",
  "turnover",
  "marketCap",
  "ret5",
  "ret20",
  "ma20Distance",
  "high20Distance",
];

function pick(input: Record<string, unknown>, snake: string, camel: string): unknown {
  return input[snake] !== undefined ? input[snake] : input[camel];
}

function numberFrom(input: Record<string, unknown>, snake: string, camel: string): number | undefined {
  const raw = pick(input, snake, camel);
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`筛选条件 ${snake} 不是数值：${String(raw)}`);
  return value;
}

function booleanFrom(input: Record<string, unknown>, snake: string, camel: string): boolean | undefined {
  const raw = pick(input, snake, camel);
  if (raw === undefined) return undefined;
  return raw === true || raw === "true";
}

/**
 * 把模型/CLI 的原始参数归一成 `ScreenCondition`（同时接受 snake_case 与 camelCase）。
 *
 * 只认白名单字段：未知键被忽略，避免模型把 `sql` / 表达式塞进来。
 */
export function screenConditionFromInput(input: Record<string, unknown>): ScreenCondition {
  const condition: ScreenCondition = {};

  const boards = pick(input, "boards", "boards");
  if (Array.isArray(boards) && boards.length > 0) {
    const values = boards.map((item) => String(item).trim() as BoardKind);
    for (const value of values) {
      if (!BOARD_VALUES.includes(value)) throw new Error(`未知板块：${value}`);
    }
    condition.boards = values;
  }

  const excludeSt = booleanFrom(input, "exclude_st", "excludeSt");
  if (excludeSt !== undefined) condition.excludeSt = excludeSt;

  const numbers: Array<[keyof ScreenCondition, string, string]> = [
    ["pctMin", "pct_min", "pctMin"],
    ["pctMax", "pct_max", "pctMax"],
    ["priceMin", "price_min", "priceMin"],
    ["priceMax", "price_max", "priceMax"],
    ["amountMin", "amount_min", "amountMin"],
    ["turnoverMin", "turnover_min", "turnoverMin"],
    ["marketCapMin", "market_cap_min", "marketCapMin"],
    ["marketCapMax", "market_cap_max", "marketCapMax"],
    ["ret5Min", "ret5_min", "ret5Min"],
    ["ret20Min", "ret20_min", "ret20Min"],
    ["ret20Max", "ret20_max", "ret20Max"],
    ["nearHigh20Pct", "near_high20_pct", "nearHigh20Pct"],
    ["limit", "limit", "limit"],
    ["offset", "offset", "offset"],
  ];
  for (const [field, snake, camel] of numbers) {
    const value = numberFrom(input, snake, camel);
    if (value !== undefined) (condition as Record<string, unknown>)[field] = value;
  }

  for (const [field, snake, camel] of [
    ["aboveMa5", "above_ma5", "aboveMa5"],
    ["aboveMa10", "above_ma10", "aboveMa10"],
    ["aboveMa20", "above_ma20", "aboveMa20"],
    ["aboveMa60", "above_ma60", "aboveMa60"],
  ] as const) {
    const value = booleanFrom(input, snake, camel);
    if (value !== undefined) condition[field] = value;
  }

  const rank = pick(input, "rank_by", "rankBy");
  if (rank !== undefined) {
    const value = String(rank) as RankField;
    if (!RANK_VALUES.includes(value)) throw new Error(`未知排序字段：${value}`);
    condition.rankBy = value;
  }
  const order = pick(input, "order", "order");
  if (order !== undefined) {
    if (order !== "asc" && order !== "desc") throw new Error("order 只能是 asc 或 desc");
    condition.order = order;
  }
  return condition;
}

export interface ScreenRow {
  code: string;
  name: string;
  price: number;
  pct: number;
  amount: number;
  turnoverPct?: number;
  marketCap?: number;
  board: BoardKind;
  st: boolean;
  /** 以下来自预计算指标，可能缺失 */
  ma5?: number;
  ma20?: number;
  ma60?: number;
  ret5?: number;
  ret20?: number;
  /** 现价相对 MA20 的偏离（%）：正数 = 在均线上方 */
  ma20Distance?: number;
  /** 现价距 20 日最高价的距离（%）：0 = 创新高 */
  high20Distance?: number;
}

export interface ScreenResult {
  matched: number;
  total: number;
  /** 因缺少指标而跳过的数量（只在使用指标条件时统计） */
  skippedNoIndicators: number;
  byBoard: Record<string, number>;
  rows: ScreenRow[];
  /** 还有多少条未返回（翻页用） */
  remaining: number;
  condition: ScreenCondition;
}

/** 该条件是否需要预计算指标（决定要不要花几分钟全市场重算） */
export function screenNeedsIndicators(condition: ScreenCondition): boolean {
  return Boolean(
    condition.aboveMa5 ||
      condition.aboveMa10 ||
      condition.aboveMa20 ||
      condition.aboveMa60 ||
      condition.ret5Min !== undefined ||
      condition.ret20Min !== undefined ||
      condition.ret20Max !== undefined ||
      condition.nearHigh20Pct !== undefined ||
      (condition.rankBy && ["ret5", "ret20", "ma20Distance", "high20Distance"].includes(condition.rankBy)),
  );
}

function rankValue(row: ScreenRow, field: RankField): number | undefined {
  switch (field) {
    case "pct":
      return row.pct;
    case "amount":
      return row.amount;
    case "turnover":
      return row.turnoverPct;
    case "marketCap":
      return row.marketCap;
    case "ret5":
      return row.ret5;
    case "ret20":
      return row.ret20;
    case "ma20Distance":
      return row.ma20Distance;
    case "high20Distance":
      return row.high20Distance;
  }
}

function buildRow(row: SnapshotRow, indicators?: Indicators): ScreenRow {
  const ma20Distance =
    indicators?.ma20 && indicators.ma20 > 0
      ? ((row.price - indicators.ma20) / indicators.ma20) * 100
      : undefined;
  const high20Distance =
    indicators?.high20 && indicators.high20 > 0
      ? ((indicators.high20 - row.price) / indicators.high20) * 100
      : undefined;
  return {
    code: row.code,
    name: row.name,
    price: row.price,
    pct: row.pct,
    amount: row.amount,
    turnoverPct: row.turnoverPct,
    marketCap: row.marketCap,
    board: row.board,
    st: row.st,
    ma5: indicators?.ma5,
    ma20: indicators?.ma20,
    ma60: indicators?.ma60,
    ret5: indicators?.ret5,
    ret20: indicators?.ret20,
    ma20Distance,
    high20Distance,
  };
}

/** 执行筛选。价格为 0（停牌/无行情）与状态含「停」的一律排除。 */
export function screenStocks(
  snapshot: MarketSnapshot,
  indicators: Map<string, Indicators>,
  condition: ScreenCondition = {},
): ScreenResult {
  const limit = Math.min(Math.max(1, Math.floor(condition.limit ?? 20)), 50);
  const offset = Math.max(0, Math.floor(condition.offset ?? 0));
  const requireIndicators = screenNeedsIndicators(condition);
  const excludeSt = condition.excludeSt !== false;

  let skippedNoIndicators = 0;
  const passed: ScreenRow[] = [];

  for (const row of snapshot.rows) {
    if (row.price <= 0) continue;
    if (row.status && row.status.includes("停")) continue;
    if (excludeSt && row.st) continue;
    if (condition.boards && condition.boards.length > 0) {
      if (!condition.boards.includes(row.board)) continue;
    }
    if (condition.pctMin !== undefined && row.pct < condition.pctMin) continue;
    if (condition.pctMax !== undefined && row.pct > condition.pctMax) continue;
    if (condition.priceMin !== undefined && row.price < condition.priceMin) continue;
    if (condition.priceMax !== undefined && row.price > condition.priceMax) continue;
    if (condition.amountMin !== undefined && row.amount < condition.amountMin) continue;
    if (
      condition.turnoverMin !== undefined &&
      (row.turnoverPct ?? 0) < condition.turnoverMin
    ) {
      continue;
    }
    if (condition.marketCapMin !== undefined && (row.marketCap ?? 0) < condition.marketCapMin) {
      continue;
    }
    if (condition.marketCapMax !== undefined && (row.marketCap ?? Infinity) > condition.marketCapMax) {
      continue;
    }

    const indicator = indicators.get(row.code);
    if (requireIndicators && !indicator) {
      skippedNoIndicators += 1;
      continue;
    }

    const candidate = buildRow(row, indicator);
    if (condition.aboveMa5 && !(candidate.ma5 && row.price > candidate.ma5)) continue;
    if (condition.aboveMa10 && !(indicator?.ma10 && row.price > indicator.ma10)) continue;
    if (condition.aboveMa20 && !(candidate.ma20 && row.price > candidate.ma20)) continue;
    if (condition.aboveMa60 && !(candidate.ma60 && row.price > candidate.ma60)) continue;
    if (condition.ret5Min !== undefined && !(indicator?.ret5 !== undefined && indicator.ret5 >= condition.ret5Min)) {
      continue;
    }
    if (
      condition.ret20Min !== undefined &&
      !(indicator?.ret20 !== undefined && indicator.ret20 >= condition.ret20Min)
    ) {
      continue;
    }
    if (
      condition.ret20Max !== undefined &&
      !(indicator?.ret20 !== undefined && indicator.ret20 <= condition.ret20Max)
    ) {
      continue;
    }
    if (
      condition.nearHigh20Pct !== undefined &&
      !(candidate.high20Distance !== undefined && candidate.high20Distance <= condition.nearHigh20Pct)
    ) {
      continue;
    }

    passed.push(candidate);
  }

  const rankBy = condition.rankBy ?? "pct";
  const order = condition.order ?? "desc";
  const ranked = passed
    .map((row) => ({ row, value: rankValue(row, rankBy) }))
    .filter((item): item is { row: ScreenRow; value: number } => Number.isFinite(item.value))
    .sort((a, b) => (order === "asc" ? a.value - b.value : b.value - a.value));

  const rows = ranked.slice(offset, offset + limit).map((item) => item.row);
  const byBoard: Record<string, number> = {};
  for (const row of passed) byBoard[row.board] = (byBoard[row.board] ?? 0) + 1;

  return {
    matched: passed.length,
    total: snapshot.rows.length,
    skippedNoIndicators,
    byBoard,
    rows,
    remaining: Math.max(0, ranked.length - offset - rows.length),
    condition: { ...condition, limit, offset, rankBy, order },
  };
}
