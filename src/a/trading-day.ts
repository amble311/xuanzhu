import {
  isTradingDay,
  loadTradingCalendar,
  resolveTradingDay,
  todayString,
  type TradingCalendar,
} from "../exchange/ashare";

/**
 * 「今天是不是交易日」的唯一判断入口。
 *
 * 为什么单独一层：`sessionKind()` / `inWorkWindow()` 只按**星期 + 时间**判断，
 * 节假日落在工作日时它们照样返回「连续竞价」—— 后台会照常拉行情、跑巡检、
 * 叫模型分析一份冻结的数据（纯烧 token，还可能按节前价格下单）。
 * 交易日必须用**真实日历**（上证指数日线日期序列）判断。
 *
 * 数据源与缓存：
 * - 日历来自 `loadTradingCalendar()`（`assets` 里抓的上证指数日线，缓存 24 小时）；
 * - 本模块再叠一层 10 分钟的内存缓存，避免每个 tick 都读文件；
 * - **取不到日历时退回「工作日」判断**（宁可多跑一天，也不要因为网络问题整个模式停摆），
 *   并在返回值里标明 `source = "weekday"`，让模型和日志都知道这是降级结论。
 */

export interface TradingDayStatus {
  /** 本地日期 `YYYY-MM-DD` */
  today: string;
  /** 今天是否交易日 */
  tradingDay: boolean;
  /** 判断依据：真实日历 / 指数行情（当日日线还没入库）/ 降级为工作日 */
  source: "calendar" | "quote" | "weekday";
  /** 日历更新时间（ISO），降级时为空 */
  calendarUpdatedAt?: string;
  /** 最近一个 <= 今天的交易日 */
  lastTradingDay?: string;
  /** 下一个 > 今天的交易日（日历里有才给） */
  nextTradingDay?: string;
  /** 降级原因 */
  error?: string;
}

/** 内存缓存：10 分钟内不重复读文件；`refresh` 时强制刷新 */
const MEMORY_TTL_MS = 10 * 60_000;
let cache:
  | { at: number; today: string; status: TradingDayStatus; calendar: TradingCalendar | null }
  | null = null;

/** 日历里下一个交易日（严格大于 `today`） */
export function nextTradingDay(
  calendar: TradingCalendar,
  today = todayString(),
): string | undefined {
  return calendar.days.find((day) => day > today);
}

/** 最近一个已收盘的交易日（含当天） */
export function lastTradingDayOf(
  calendar: TradingCalendar,
  today = todayString(),
): string | undefined {
  for (let index = calendar.days.length - 1; index >= 0; index -= 1) {
    if (calendar.days[index] <= today) return calendar.days[index];
  }
  return undefined;
}

function weekdayFallback(today: string, now: Date, error?: string): TradingDayStatus {
  const day = now.getDay();
  return {
    today,
    tradingDay: day !== 0 && day !== 6,
    source: "weekday",
    ...(error ? { error } : {}),
  };
}

/**
 * 今天是否交易日。
 *
 * `refresh=true` 会强制重拉日历（`xzh a calendar --refresh`、排查「明明是交易日却说不是」时用）。
 */
export async function todayTradingStatus(
  now = new Date(),
  options: { refresh?: boolean } = {},
): Promise<TradingDayStatus> {
  const today = todayString(now);
  if (
    !options.refresh &&
    cache &&
    cache.today === today &&
    Date.now() - cache.at < MEMORY_TTL_MS
  ) {
    return cache.status;
  }

  let calendar: TradingCalendar | null = null;
  let status: TradingDayStatus;
  try {
    calendar = await loadTradingCalendar({ refresh: options.refresh });
    // 日历只到「上一个已收盘交易日」，盘中今天一定不在里面 —— 必须再看指数行情，
    // 否则每个交易日盘中都会被判成休市（巡检：「非交易日，不能交易」）。
    const verdict = await resolveTradingDay(calendar, now);
    status = {
      today,
      tradingDay: verdict.trading,
      source: verdict.basis === "calendar" ? "calendar" : verdict.basis === "quote" ? "quote" : "weekday",
      calendarUpdatedAt: calendar.updatedAt,
      lastTradingDay: lastTradingDayOf(calendar, today),
      nextTradingDay: nextTradingDay(calendar, today),
    };
  } catch (err) {
    status = weekdayFallback(
      today,
      now,
      err instanceof Error ? err.message : String(err),
    );
  }

  cache = { at: Date.now(), today, status, calendar };
  return status;
}

/** 仅供测试与「切换交易日」时清理内存缓存 */
export function resetTradingDayCache(): void {
  cache = null;
}

/** 一行可读描述（日志 / 工具返回 / 巡检上下文共用） */
export function describeTradingDay(status: TradingDayStatus): string {
  const parts = [
    `${status.today} ${status.tradingDay ? "是交易日" : "非交易日（休市）"}`,
    status.lastTradingDay ? `最近交易日 ${status.lastTradingDay}` : "",
    status.nextTradingDay ? `下一交易日 ${status.nextTradingDay}` : "",
    status.source === "calendar"
      ? `数据源 上证指数日线${status.calendarUpdatedAt ? `（${status.calendarUpdatedAt.slice(0, 10)} 更新）` : ""}`
      : status.source === "quote"
        ? "依据 上证指数实时行情（当日日线尚未入库）"
        : `降级判断：按工作日${status.error ? `（日历不可用：${status.error}）` : ""}`,
  ].filter(Boolean);
  return parts.join(" · ");
}
