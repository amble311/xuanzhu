import { fetch as undiciFetch } from "undici";
import type {
  ExchangeAdapter,
  FetchKlinesOptions,
  FetchTickerOptions,
  KlineInterval,
  KlineRow,
  Ticker,
} from "./types";
import { intervalMs } from "./types";

/**
 * 币安适配器（公开行情）。
 *
 * 取**运行时**的 fetch：`applyProxyConfig()` 会把 `globalThis.fetch` 换成带代理
 * dispatcher 的版本，直接 import undici 的 fetch 会绕过代理。类型只在编译期用。
 */
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

const SPOT_BASE = "https://api.binance.com";
const FUTURES_BASE = "https://fapi.binance.com";
const PAGE_LIMIT = 1000;

/**
 * 合约还是现货。
 *
 * 读 `BTC_USE_FUTURES` 而不是新造一个环境变量：与原 btc 项目的 `.env` 保持兼容，
 * 用户已有的配置不用改。默认合约（`fapi`），与策略的资金费口径一致。
 */
function useFutures(): boolean {
  return (process.env.BTC_USE_FUTURES ?? "1").trim() !== "0";
}

function endpoints(): { base: string; klines: string; ticker: string } {
  return useFutures()
    ? {
        base: FUTURES_BASE,
        klines: "/fapi/v1/klines",
        ticker: "/fapi/v1/ticker/24hr",
      }
    : {
        base: SPOT_BASE,
        klines: "/api/v3/klines",
        ticker: "/api/v3/ticker/24hr",
      };
}

function httpError(status: number, body: string): Error {
  return new Error(
    `币安行情接口返回 HTTP ${status}${body ? `：${body.slice(0, 200)}` : ""}` +
      `（若在中国大陆，请先用 \`xzh vpn\` 配置代理）`,
  );
}

interface BinanceKline extends Array<string | number> {
  0: number;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
}

export const binanceExchange: ExchangeAdapter = {
  id: "binance",
  label: "币安（Binance）",
  notes:
    "合约端点 fapi.binance.com/fapi/v1，现货 api.binance.com/api/v3；" +
    "K 线时间为 UTC 毫秒、日线按 UTC 00:00 对齐（读库后转北京时间）；" +
    "公开行情无需 API Key；单次最多 1000 根；限频超限返回 418/429。",

  toNativeSymbol(symbol: string): string {
    return symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  },

  async fetchTicker(symbol: string, options: FetchTickerOptions = {}): Promise<Ticker> {
    const { base, ticker } = endpoints();
    const url = new URL(`${base}${ticker}`);
    url.searchParams.set("symbol", binanceExchange.toNativeSymbol(symbol));

    const response = await runtimeFetch()(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: { "user-agent": "xzh-btc/1.0" },
    });
    if (!response.ok) {
      throw httpError(response.status, await response.text().catch(() => ""));
    }

    const data = (await response.json()) as Record<string, string>;
    return {
      symbol: binanceExchange.toNativeSymbol(symbol),
      price: Number(data.lastPrice),
      changePct: Number(data.priceChangePercent),
      high24h: Number(data.highPrice),
      low24h: Number(data.lowPrice),
      quoteVolume: Number(data.quoteVolume),
    };
  },

  /**
   * 分页用 `startTime` 往后推（而不是 `endTime` 往前）：币安在两者都给时会以
   * `startTime` 为准，用 endTime 反而可能重复拉同一段；往后推的游标天然去重。
   */
  async fetchKlines(options: FetchKlinesOptions): Promise<KlineRow[]> {
    const { base, klines } = endpoints();
    const symbol = binanceExchange.toNativeSymbol(options.symbol);
    const interval: KlineInterval = options.interval;
    const max = options.limit ?? Number.POSITIVE_INFINITY;
    const timeoutMs = options.timeoutMs ?? 20_000;

    const rows: KlineRow[] = [];
    let cursor = options.startMs ?? 0;

    while (rows.length < max) {
      const pageLimit = Math.min(PAGE_LIMIT, Math.max(1, max - rows.length));
      const url = new URL(`${base}${klines}`);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("limit", String(pageLimit));
      if (cursor > 0) url.searchParams.set("startTime", String(cursor));
      if (options.endMs) url.searchParams.set("endTime", String(options.endMs));

      const response = await runtimeFetch()(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "xzh-btc/1.0" },
      });
      if (!response.ok) {
        throw httpError(response.status, await response.text().catch(() => ""));
      }

      const data = (await response.json()) as BinanceKline[];
      if (!Array.isArray(data) || data.length === 0) break;

      for (const item of data) {
        rows.push([
          Number(item[0]),
          Number(item[1]),
          Number(item[2]),
          Number(item[3]),
          Number(item[4]),
          Number(item[5]),
        ]);
      }

      if (data.length < pageLimit) break;
      const lastTs = Number(data[data.length - 1][0]);
      const next = lastTs + intervalMs(interval);
      // 防御：接口没有前进就停下，避免死循环把内存吃满
      if (next <= cursor) break;
      cursor = next;
    }

    return rows;
  },
};
