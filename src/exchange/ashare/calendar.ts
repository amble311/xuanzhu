import { readCache, writeCache } from "./cache";
import { fetchBars } from "./ths";

/**
 * A 股交易日历。
 *
 * 数据源用**上证指数的日线日期序列**（`hs_1A0001`，1990 年至今 8700+ 根）：
 * 指数有行情的日子就是交易日，比维护一份节假日表可靠 —— 调休、临时休市
 * 都不会漏。结果缓存一天，避免每次启动都拉 300KB。
 */

export interface TradingSession {
  start: string;
  end: string;
}

/** 连续竞价时段（集合竞价与盘后固定价格交易不在此列） */
export const CN_TRADING_SESSIONS: TradingSession[] = [
  { start: "09:30", end: "11:30" },
  { start: "13:00", end: "15:00" },
];

export interface TradingCalendar {
  updatedAt: string;
  /** 交易日 `YYYY-MM-DD`，升序 */
  days: string[];
}

export const CALENDAR_CACHE = "calendar.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 拉取并缓存交易日；`refresh` 强制重拉 */
export async function loadTradingCalendar(
  options: { refresh?: boolean } = {},
): Promise<TradingCalendar> {
  if (!options.refresh) {
    const cached = readCache<TradingCalendar>(CALENDAR_CACHE, CACHE_TTL_MS);
    if (cached) return cached.value;
  }
  const bars = await fetchBars("1A0001", { period: "day", adjust: "none", limit: 0 });
  const days = bars
    .map((bar) => bar.time.slice(0, 10))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day));
  if (days.length === 0) throw new Error("上证指数没有返回日线，无法建立交易日历。");
  const calendar: TradingCalendar = {
    updatedAt: new Date().toISOString(),
    days: [...new Set(days)].sort(),
  };
  writeCache(CALENDAR_CACHE, calendar);
  return calendar;
}

/** 某天是否交易日（`YYYY-MM-DD`） */
export function isTradingDay(calendar: TradingCalendar, date: string): boolean {
  return calendar.days.includes(date);
}

/** 最近一个已收盘的交易日（含当天） */
export function lastTradingDay(
  calendar: TradingCalendar,
  today = todayString(),
): string | undefined {
  for (let index = calendar.days.length - 1; index >= 0; index -= 1) {
    if (calendar.days[index] <= today) return calendar.days[index];
  }
  return undefined;
}

/** 交易时段细分（用于给模型标注数据是否新鲜） */
export type SessionKind =
  | "weekend"
  | "pre-open"
  | "auction"
  | "continuous"
  | "lunch"
  | "closed";

/**
 * 当前处于哪个时段。
 *
 * 只按工作日 + 时间判断，**不判断节假日** —— 需要精确判断时用 `isTradingDay()`。
 * 节假日的工作日会返回 `continuous`，因此工具返回里必须同时带 `asOf`。
 */
export function sessionKind(now = new Date()): SessionKind {
  const weekday = now.getDay();
  if (weekday === 0 || weekday === 6) return "weekend";
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < 9 * 60 + 15) return "pre-open";
  if (minutes < 9 * 60 + 25) return "auction";
  if (minutes < 9 * 60 + 30) return "pre-open";
  if (minutes <= 11 * 60 + 30) return "continuous";
  if (minutes < 13 * 60) return "lunch";
  if (minutes <= 15 * 60) return "continuous";
  return "closed";
}

export function sessionLabel(kind: SessionKind): string {
  switch (kind) {
    case "weekend":
      return "周末休市";
    case "pre-open":
      return "盘前";
    case "auction":
      return "集合竞价";
    case "continuous":
      return "连续竞价";
    case "lunch":
      return "午间休市";
    case "closed":
      return "已收盘";
  }
}

/**
 * 当前是否处于连续竞价时段（09:30–11:30 / 13:00–15:00）。
 *
 * 只按时间判断，**不含集合竞价 09:15–09:25、盘前 09:00–09:30 与午休**；
 * 要连节假日一起判断用 `continuousSession()`。
 */
export function isTradingTime(now = new Date()): boolean {
  return sessionKind(now) === "continuous";
}

export interface SessionGate {
  /** 是否可撮合 / 成交 */
  open: boolean;
  /** 不可交易的原因（`open` 为 true 时缺省） */
  reason?: string;
}

/** 当天交易日状态的内存缓存：避免每轮 tick 都读日历文件 */
let dayStatusCache: { day: string; trading: boolean; expiresAt: number } | null = null;

/** 今天是否交易日；日历不可用时按工作日放行（10 分钟后重试） */
export async function tradingDayStatus(now = new Date()): Promise<boolean> {
  const today = todayString(now);
  const nowMs = now.getTime();
  if (dayStatusCache && dayStatusCache.day === today && dayStatusCache.expiresAt > nowMs) {
    return dayStatusCache.trading;
  }
  if (now.getDay() === 0 || now.getDay() === 6) {
    dayStatusCache = { day: today, trading: false, expiresAt: nowMs + 6 * 60 * 60_000 };
    return false;
  }
  try {
    const calendar = await loadTradingCalendar();
    const trading = isTradingDay(calendar, today);
    dayStatusCache = { day: today, trading, expiresAt: nowMs + 6 * 60 * 60_000 };
    return trading;
  } catch {
    dayStatusCache = { day: today, trading: true, expiresAt: nowMs + 10 * 60_000 };
    return true;
  }
}

/**
 * 撮合 / 成交闸门：连续竞价时段 + 当天是交易日。
 *
 * 交易链路（挂单撮合、模拟盘立即成交）必须走这里，不能只看 09:00–15:30 的工作窗口 ——
 * 那个窗口包含集合竞价与午休，A 股在这两段时间里不成交。
 */
export async function continuousSession(now = new Date()): Promise<SessionGate> {
  const kind = sessionKind(now);
  if (kind !== "continuous") {
    return {
      open: false,
      reason: `${sessionLabel(kind)}（连续竞价 09:30–11:30 / 13:00–15:00）`,
    };
  }
  if (!(await tradingDayStatus(now))) {
    return { open: false, reason: `${todayString(now)} 非交易日，休市` };
  }
  return { open: true };
}

/** 本地日期 `YYYY-MM-DD` */
export function todayString(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
