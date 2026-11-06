/**
 * 行情获取的健康检查。
 *
 * 为什么需要它：行情拉不到时，后面的三周期打分、1h 机会评分、止损与挂单时效
 * 全都建立在旧数据上 —— 表面上「还在盯盘」，实际上所有结论都已失效。
 * 用户设定：**连续两次失败就唤醒模型排查**，而不是等下一次常规巡检
 * （那可能是几小时后，期间还可能按旧数据下单）。
 */
export const MARKET_FAILURE_THRESHOLD = 2;

/**
 * 健康检查节拍：5 分钟。
 *
 * 与叫醒条件同频：更密会每分钟打一次交易所（权重白吃），更疏则故障发现太慢。
 * 注意 K 线同步的失败也会计入同一个计数器，两个来源任一成功即清零。
 */
export const MARKET_HEALTH_INTERVAL_MS = 5 * 60_000;

/** 是否该叫醒：达到阈值且本轮故障还没叫过 */
export function shouldAlertMarket(failures: number, alerted: boolean): boolean {
  return failures >= MARKET_FAILURE_THRESHOLD && !alerted;
}

/** `btc_status` / 面板用的一句话 */
export function marketStatusText(failures: number, lastOkAt?: string): string {
  if (failures <= 0) return "正常";
  const suffix = lastOkAt
    ? `，上次成功 ${lastOkAt.slice(0, 16).replace("T", " ")}`
    : "，启动后从未成功";
  return `连续失败 ${failures} 次${suffix}`;
}
