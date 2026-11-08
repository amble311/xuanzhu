/**
 * A 股分析核心（横截面）。
 *
 * 分工：
 * - `snapshot.ts`：全市场快照 + 涨跌分布（按需刷新，不做常驻轮询）；
 * - `indicators.ts`：盘后预计算（均线 / 20-60 日高 / 区间涨幅）；
 * - `screen.ts`：白名单字段的确定性筛选器；
 * - `format.ts`：终端与模型共用的紧凑文本。
 *
 * 数据获取仍在 `src/exchange/ashare`；这里只做聚合与筛选。
 */
export * from "./indicators";
export * from "./snapshot";
export * from "./screen";
export * from "./format";
export * from "./paper";
export * from "./watchlist";
export * from "./score";
export * from "./monitor";
