import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 「当前是实盘还是模拟盘」的**任务级**上下文。
 *
 * 历史：btc 工具一直靠 `process.env.XZH_BTC_ROLE` 判断角色。单个进程只服务一个
 * 角色时没问题，但 gateway 现在允许**不同对端并发**：同一个进程里可能同时有
 * 「实盘会话」和「模拟盘会话」，环境变量只能有一个值 —— A 的 `btc_buy` 会按 B
 * 的角色落到错误账本上，这是绝对不能接受的。
 *
 * 因此角色改成 AsyncLocalStorage：`withBtcRole()` 开一个异步上下文，里面所有
 * `await`（含工具执行、子进程调用）都读得到正确角色，且与其他并发任务隔离。
 * 环境变量保留为**兜底**（CLI / 后端守护进程 / TUI 仍是单角色进程）。
 */

export type BtcRole = "live" | "paper";

const storage = new AsyncLocalStorage<BtcRole>();

/** 在指定角色上下文里执行（async 函数内部的 await 会继承该上下文） */
export function withBtcRole<T>(role: BtcRole, fn: () => T): T {
  return storage.run(role, fn);
}

/**
 * 当前任务的角色。
 *
 * 优先任务上下文，其次环境变量（`XZH_BTC_ROLE=paper`），默认实盘。
 * **所有**需要区分角色的代码都应走这里，不要再直接读 env。
 */
export function currentBtcRole(): BtcRole {
  return storage.getStore() ?? (process.env.XZH_BTC_ROLE === "paper" ? "paper" : "live");
}
