import { getBtcHome } from "../utils/paths";
import { binanceExchange } from "./binance";
import { readPlatformSetting } from "./platform";
import type { ExchangeAdapter } from "./types";

/**
 * 交易所注册表。
 *
 * 新增平台 = 在 `EXCHANGES` 里加一个适配器 + 写一份
 * `skills/btc-data-sync/references/exchange-<id>.md`（口径说明），
 * 工具层与 Python 计算层都不用动。
 *
 * 接口刻意只包含**已经用到**的三个能力（ticker / klines / 符号转换）：
 * 先按真实需求长，不为想象中的平台预留空方法 —— 那些方法永远实现不对。
 */

export type {
  ExchangeAdapter,
  FetchKlinesOptions,
  FetchTickerOptions,
  KlineInterval,
  KlineRow,
  Ticker,
} from "./types";
export { intervalMs } from "./types";
export { binanceExchange } from "./binance";

export const EXCHANGES: ExchangeAdapter[] = [binanceExchange];

/** 默认平台；`BTC_EXCHANGE` 可覆盖（写在 `~/.btc/.env` 或环境变量里） */
export const DEFAULT_EXCHANGE_ID = "binance";

export function findExchange(id: string | undefined): ExchangeAdapter | undefined {
  const wanted = (id ?? "").trim().toLowerCase();
  if (!wanted) return undefined;
  return EXCHANGES.find((exchange) => exchange.id.toLowerCase() === wanted);
}

/** 当前平台来自哪里：环境变量 / 配置文件 / 默认值 */
export type ExchangeSource = "env" | "config" | "default";

export interface ActiveExchange {
  exchange: ExchangeAdapter;
  source: ExchangeSource;
  /** 实际生效的配置值（`env` 或配置文件里的 id） */
  requested?: string;
  /** 配置里指定的平台不存在时的说明（此时 exchange 回退到默认，但调用方必须先报错） */
  error?: string;
}

/**
 * 当前使用的交易所。
 *
 * 优先级：`BTC_EXCHANGE` 环境变量 > `~/.btc/platform.json` > 默认 binance。
 * 环境变量优先是为了 CI / 多环境脚本能临时覆盖，不被交互选择的值锁死。
 *
 * 写了不存在的平台时**不静默回退** —— 否则用户以为在用 OKX，实际数据来自币安，
 * 回测与信号全错。调用方拿到 `error` 应当直接拒绝执行。
 */
export function activeExchange(home = getBtcHome()): ActiveExchange {
  const fromEnv = process.env.BTC_EXCHANGE?.trim();
  const fromConfig = readPlatformSetting(home);
  const requested = fromEnv || fromConfig;
  const source: ExchangeSource = fromEnv
    ? "env"
    : fromConfig
      ? "config"
      : "default";

  if (!requested) {
    return {
      exchange: findExchange(DEFAULT_EXCHANGE_ID) ?? EXCHANGES[0],
      source,
    };
  }

  const found = findExchange(requested);
  if (!found) {
    return {
      exchange: findExchange(DEFAULT_EXCHANGE_ID) ?? EXCHANGES[0],
      source,
      requested,
      error:
        `${fromEnv ? "BTC_EXCHANGE" : "platform.json"}=${requested} 不是已接入的交易所。` +
        `可选：${EXCHANGES.map((item) => item.id).join(" / ")}`,
    };
  }
  return { exchange: found, source, requested: found.id };
}
