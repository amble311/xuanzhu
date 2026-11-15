/**
 * A 股**工作窗口**：工作日 09:30–15:30。
 *
 * 起点必须是 09:30，不能是 09:00 —— 09:15–09:25 是开盘集合竞价，09:25–09:30 没有连续成交，
 * 这段时间拿到的「最新价」只是竞价参考价或昨天的收盘价。巡检若在这半小时内开跑，
 * 三周期方向、15 分钟择时、涨跌幅全部建立在假价格上（典型误判：竞价高开 3% 判成突破，
 * 开盘直接回落），所以工作窗口从连续竞价开始算。
 *
 * 与撮合闸门的分工不变：
 * - 本窗口只决定「要不要拉数据 / 跑巡检 / 监控」；
 * - **成交**必须走 `exchange/ashare/calendar.ts::continuousSession()`
 *   （09:30–11:30 / 13:00–15:00 且当天是交易日）。两者起点相同，但窗口包含午休，
 *   不能拿窗口去放行成交。
 */

export const WORK_START_MIN = 9 * 60 + 30;
export const WORK_END_MIN = 15 * 60 + 30;

/** 展示用（提示词 / 帮助 / 日志统一取这个，别再各写一份） */
export const WORK_WINDOW_LABEL = "09:30–15:30";

export function inWorkWindow(now = new Date()): boolean {
  if (now.getDay() === 0 || now.getDay() === 6) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= WORK_START_MIN && minutes <= WORK_END_MIN;
}
