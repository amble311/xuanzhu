/**
 * A 股数据层门面。
 *
 * 目前只有同花顺一个适配器：快照 / K 线 / 分时 / 指数 / 板块 / 交易日历 / 股票池。
 * 工具层（将来的 `a_quote`、`a_bars` 等）与模拟撮合只从这里取数，不直接拼 HTTP。
 */
export * from "./types";
export * from "./ths";
export * from "./cache";
export * from "./calendar";
export * from "./boards";
export * from "./universe";
export * from "./fifteen";
