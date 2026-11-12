/**
 * A 股行情的数据契约。
 *
 * 工具层与（将来的）模拟撮合只依赖这里的类型，不关心同花顺的端点、JSONP 包装
 * 与数字字段码 —— 那些属于 `ths.ts` 的适配职责。换数据源时只改适配器。
 */

/** 股票所属板块：决定涨跌停幅度、交易规则与代码前缀校验 */
export type BoardKind = "sh-main" | "sz-main" | "gem" | "star" | "bse" | "index" | "board" | "unknown";

/** K 线周期（同花顺只提供这些，没有 15 分钟线） */
export type BarPeriod =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "60m"
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year";

/** 复权方式：none 不复权 / forward 前复权 / backward 后复权 */
export type Adjust = "none" | "forward" | "backward";

export interface Quote {
  /** 6 位代码（指数为同花顺代码，如 `1A0001`） */
  code: string;
  name: string;
  /** 最新价 */
  price: number;
  /** 昨收 */
  preClose: number;
  open: number;
  high: number;
  low: number;
  /** 涨跌额（元） */
  change: number;
  /** 涨跌幅（%） */
  changePct: number;
  /** 成交量（股） */
  volume: number;
  /** 成交额（元） */
  amount: number;
  /** 换手率（%） */
  turnoverPct?: number;
  /** 均价（元） */
  avgPrice?: number;
  /** 涨停价（元） */
  limitUp?: number;
  /** 跌停价（元） */
  limitDown?: number;
  totalShares?: number;
  floatShares?: number;
  marketCap?: number;
  /** 同花顺的原始状态，如「交易中」「闭市」「停牌」 */
  stockStatus?: string;
  /** 同花顺的板块标识，如 `HS_stock_gem` */
  marketType?: string;
  /** 行情时间（同花顺 updateTime） */
  updatedAt?: string;
  board: BoardKind;
  /** 名称带 ST / *ST */
  st: boolean;
}

export interface Bar {
  /** 日线 `YYYY-MM-DD`；分钟线 `YYYY-MM-DD HH:mm` */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量（股） */
  volume: number;
  /** 成交额（元）；`all.js` 不带成交额，因此可能缺失 */
  amount?: number;
  /** 换手率（%）；仅 `last.js` 提供 */
  turnoverPct?: number;
}

/** 分时（当日逐分钟）点 */
export interface IntradayPoint {
  time: string;
  price: number;
  /** 该分钟成交量（股） */
  volume: number;
  /** 当日累计均价 */
  avgPrice: number;
}

export interface IntradaySeries {
  code: string;
  name?: string;
  /** 昨收 */
  preClose?: number;
  date?: string;
  /** 是否处于交易时段（同花顺 isTrading） */
  trading: boolean;
  points: IntradayPoint[];
}

/** 板块类型：同花顺行业（881xxx）/ 概念（885xxx） */
export type BoardType = "industry" | "concept";

export interface BoardRef {
  code: string;
  name: string;
  type: BoardType;
}

/** 股票池条目（`xzh a sync` 扫描落盘） */
export interface UniverseStock {
  code: string;
  name: string;
  board: BoardKind;
  marketType?: string;
  st: boolean;
}
