/**
 * A 股**可巡检时段**：正常交易时段 09:30–11:30 / 13:00–15:00（工作日）。
 *
 * 为什么不是「09:30–15:30」：11:30–13:00 是午休、15:00 之后已经收盘，这两段时间没有成交，
 * 拿到的价格是冻结的（上午收盘价 / 当日收盘价）——
 * - 巡检在 12:00 跑，会把「上午最后一笔」当成现价做 15 分钟择时；
 * - 排期落在 15:20 更糟，等于用收盘价重新判断一遍，还以为在盘中。
 * 集合竞价（09:15–09:30）同理：只有参考价，没有连续成交。
 *
 * 分工仍然不变：
 * - 本窗口只决定「要不要拉行情 / 跑巡检 / 监控 / 消费排期」；
 * - **成交**必须走 `exchange/ashare/calendar.ts::continuousSession()`
 *   （同两个时段 + 当天是交易日）。窗口不判交易日，节假日由闸门兜住。
 */

export interface TradingSession {
  /** 开始（分钟，含） */
  start: number;
  /** 结束（分钟，含；收盘那一分钟的数据是完整的） */
  end: number;
}

export const TRADING_SESSIONS: TradingSession[] = [
  { start: 9 * 60 + 30, end: 11 * 60 + 30 },
  { start: 13 * 60, end: 15 * 60 },
];

/** 展示用（提示词 / 帮助 / 日志统一取这个，别再各写一份） */
export const WORK_WINDOW_LABEL = "09:30–11:30、13:00–15:00";

function minutesOf(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

function isWeekend(now: Date): boolean {
  return now.getDay() === 0 || now.getDay() === 6;
}

export function inWorkWindow(now = new Date()): boolean {
  if (isWeekend(now)) return false;
  const minutes = minutesOf(now);
  return TRADING_SESSIONS.some((session) => minutes >= session.start && minutes <= session.end);
}

/**
 * 把时间夹进**交易时段**：
 * - 早于 09:30 → 当日 09:30；
 * - 午休 11:30–13:00 → 当日 13:00；
 * - 15:00 之后（含夜间）→ 下一个工作日 09:30；
 * - 周末 → 下一个周一 09:30。
 *
 * 「跨日」是允许的：15:00 之后排期一律落到下一个工作日的开盘，而不是当天晚些时候。
 */
export function clampToTradingSession(
  at: Date,
  now = new Date(),
): { at: Date; clamped: boolean } {
  const result = new Date(at);
  let clamped = false;
  for (let guard = 0; guard < 20; guard += 1) {
    if (isWeekend(result)) {
      result.setDate(result.getDate() + (result.getDay() === 6 ? 2 : 1));
      result.setHours(9, 30, 0, 0);
      clamped = true;
      continue;
    }
    const minutes = minutesOf(result);
    if (minutes < TRADING_SESSIONS[0].start) {
      result.setHours(9, 30, 0, 0);
      clamped = true;
      continue;
    }
    if (minutes > TRADING_SESSIONS[0].end && minutes < TRADING_SESSIONS[1].start) {
      result.setHours(13, 0, 0, 0);
      clamped = true;
      continue;
    }
    if (minutes > TRADING_SESSIONS[1].end) {
      result.setDate(result.getDate() + 1);
      result.setHours(9, 30, 0, 0);
      clamped = true;
      continue;
    }
    break;
  }
  // 不允许排到过去：至少 now + 1 分钟（再夹一次，避免落在午休/夜间）
  if (result.getTime() < now.getTime() + 60_000) {
    const next = clampToTradingSession(new Date(now.getTime() + 60_000), now);
    return { at: next.at, clamped: true };
  }
  return { at: result, clamped };
}
