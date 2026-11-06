/**
 * 无人值守（后台巡检）下允许**自动执行**的工具白名单。
 *
 * 用户要求：被监控/排期唤醒时，模型要「自主决策到底」—— 真开仓、真平仓、真撤单，
 * 而不是只写一份方案等用户确认（用户此时不在，等不到）。
 *
 * 原来的实现是 `confirm: () => false`：后台能看见机会，但一执行就被拒，
 * 表现为「巡检说要做多，却什么也没发生」。
 *
 * 边界（刻意没有全部放开）：
 * - 只放行**交易动作本身**与巡检自身的记账工具；
 * - 不放行 `btc_paper_reset`（清账本不可逆、且不属于决策）、`btc_transfer_profit`
 *   （资金划转不是交易决策，误操作代价高）；
 * - 不放行 `write_file` / `edit_file` / `bash` / `device_*`：后台不需要改环境，
 *   放开等于给无人值守进程一个任意代码入口。
 *
 * 放开 confirm 不等于无约束：硬性风控（持仓亏损/当日亏损/连亏）、三周期方向闸门、
 * 保证金与倍率校验都是**代码强制**的，在工具内部执行。
 */
export const UNATTENDED_ALLOWED_TOOLS = new Set([
  "btc_order",
  "btc_close",
  "btc_cancel",
  "btc_renew",
  "btc_sync",
  "btc_schedule",
  "btc_unschedule",
  "btc_policy",
  "btc_trigger",
  "btc_paper_open",
  "btc_paper_close",
  "btc_paper_cancel",
]);

/** 该工具在无人值守时是否可以不经确认直接执行 */
export function canAutoApproveUnattended(tool: string): boolean {
  return UNATTENDED_ALLOWED_TOOLS.has(tool);
}
