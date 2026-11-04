import { fetch as undiciFetch } from "undici";

/**
 * 交易对精度（下单必需）。
 *
 * 币安对数量/价格有 `stepSize` / `tickSize` 约束，传错会直接 `-1111`。
 * 这里拉一次 `exchangeInfo` 缓存半小时 —— 它属于**公开**接口，不需要签名。
 */

const FUTURES_BASE = "https://fapi.binance.com";
const CACHE_TTL_MS = 30 * 60_000;

/**
 * 取**运行时**的 fetch。
 *
 * 不能存成模块级常量：`applyProxyConfig()` 会把 `globalThis.fetch` 换成带代理
 * dispatcher 的版本，而模块在进程启动时就已加载完 —— 存下来的旧函数虽然因为
 * `setGlobalDispatcher` 也走代理，但一旦哪天改掉那行就会静默失效。
 */
function runtimeFetch(): typeof undiciFetch {
  return (globalThis as { fetch?: typeof undiciFetch }).fetch ?? undiciFetch;
}

export interface SymbolFilters {
  symbol: string;
  /** 数量步长，如 0.001 */
  stepSize: number;
  /** 价格步长（最小变动） */
  tickSize: number;
  /** 最小名义价值（USDT） */
  minNotional: number;
}

interface RawExchangeInfo {
  symbols?: Array<{
    symbol?: string;
    filters?: Array<{
      filterType?: string;
      stepSize?: string;
      tickSize?: string;
      minQty?: string;
      notional?: string;
    }>;
  }>;
}

const cache = new Map<string, { at: number; filters: SymbolFilters }>();

function decimalsOf(step: number): number {
  const text = step.toString();
  if (text.includes("e-")) {
    return Number(text.split("e-")[1]);
  }
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** 数量向下取整到步长（宁可少一点，也不能超） */
export function quantizeQty(qty: number, stepSize: number): string {
  if (!(stepSize > 0)) return qty.toFixed(8);
  const steps = Math.floor(qty / stepSize + 1e-9);
  return (steps * stepSize).toFixed(decimalsOf(stepSize));
}

/** 价格按 tickSize 四舍五入 */
export function quantizePrice(price: number, tickSize: number): string {
  if (!(tickSize > 0)) return price.toFixed(2);
  const steps = Math.round(price / tickSize);
  return (steps * tickSize).toFixed(decimalsOf(tickSize));
}

export async function getSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const key = symbol.toUpperCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.filters;

  const response = await runtimeFetch()(`${FUTURES_BASE}/fapi/v1/exchangeInfo`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`获取交易对精度失败：HTTP ${response.status}`);
  }

  const data = (await response.json()) as RawExchangeInfo;
  const entry = data.symbols?.find((item) => item.symbol === key);
  if (!entry) throw new Error(`交易所没有这个合约：${key}`);

  const find = (type: string) =>
    entry.filters?.find((filter) => filter.filterType === type);
  const filters: SymbolFilters = {
    symbol: key,
    stepSize: Number(find("LOT_SIZE")?.stepSize ?? "0.001"),
    tickSize: Number(find("PRICE_FILTER")?.tickSize ?? "0.1"),
    minNotional: Number(find("MIN_NOTIONAL")?.notional ?? "5"),
  };
  cache.set(key, { at: Date.now(), filters });
  return filters;
}
