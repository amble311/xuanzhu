/**
 * 交易所适配层。
 *
 * 为什么要有这一层：行情与（将来的）下单接口属于**外部平台契约**，各家的端点、
 * 符号命名、分页语义、限频与错误码都不同。工具层只该关心「拿 K 线 / 拿 ticker」，
 * 不该知道 `fapi.binance.com` 或 `BTCUSDT` 这种平台细节。
 *
 * 与「做成技能」的分界：
 * - **代码**（本目录）：可靠地拿到数据 —— 代理、分页去重、错误归类、时间戳口径；
 * - **技能**（`skills/btc-data-sync/references/exchange-*.md`）：平台口径说明 ——
 *   合约/现货差异、资金费、限频、精度。技能是给模型看的，不能替代执行层，
 *   否则模型只能 `bash` 拼 HTTP，绕过代理与签名，还会把密钥写进对话。
 */

export type KlineInterval = "1d" | "1h";

/** [开盘毫秒时间戳, open, high, low, close, volume] */
export type KlineRow = [number, number, number, number, number, number];

export interface Ticker {
  /** 平台原生符号，如 `BTCUSDT` */
  symbol: string;
  price: number;
  /** 24h 涨跌幅（%） */
  changePct: number;
  high24h: number;
  low24h: number;
  /** 24h 成交额（计价货币） */
  quoteVolume: number;
}

export interface FetchTickerOptions {
  timeoutMs?: number;
}

export interface FetchKlinesOptions {
  /** **通用**符号写法（`BTC/USDT`），由适配器自己转成平台符号 */
  symbol: string;
  interval: KlineInterval;
  /** 起始时间（毫秒，含） */
  startMs?: number;
  /** 结束时间（毫秒，含） */
  endMs?: number;
  /** 最多拉多少根 */
  limit?: number;
  timeoutMs?: number;
}

export interface ExchangeAdapter {
  /** 注册表 id，也是 `BTC_EXCHANGE` 的取值 */
  id: string;
  /** 展示名（状态输出与错误提示里用） */
  label: string;
  /** 该平台口径的一句话摘要，供状态输出引用 */
  notes: string;
  /** 通用符号 → 平台符号（`BTC/USDT` → `BTCUSDT`） */
  toNativeSymbol(symbol: string): string;
  fetchTicker(symbol: string, options?: FetchTickerOptions): Promise<Ticker>;
  /** 分页拉取 K 线，按时间升序返回 */
  fetchKlines(options: FetchKlinesOptions): Promise<KlineRow[]>;
}

/** 通用周期长度（毫秒）：同步窗口与增量起点都按它推算 */
export function intervalMs(interval: KlineInterval): number {
  return interval === "1d" ? 86_400_000 : 3_600_000;
}
