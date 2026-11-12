import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import type {
  Adjust,
  Bar,
  BarPeriod,
  BoardKind,
  IntradaySeries,
  Quote,
} from "./types";

/**
 * 同花顺公开行情适配器（`d.10jqka.com.cn`）。
 *
 * 为什么只用这个域：它是同花顺的**免鉴权行情域** —— 不需要 cookie / UA / Referer，
 * 实时快照、K 线、分时、指数与板块指数都在这里。排行榜、板块成分、问财在
 * `q.` / `iwen` 域后面，需要 `hexin-v` 的 JS 挑战，本模块**刻意不碰**。
 *
 * 端点与字段码是外部契约，全部集中在 `decode*` 纯函数里；业务层只看到
 * `Quote` / `Bar`，接口改版时只改这一层。
 */

const BASE = "https://d.10jqka.com.cn";
const USER_AGENT = "xzh-ashare/1.0";

/** 周期 → 同花顺类型首位 */
const PERIOD_CODE: Record<BarPeriod, string> = {
  "1m": "6",
  "5m": "3",
  "15m": "",
  "30m": "4",
  "60m": "5",
  day: "0",
  week: "1",
  month: "2",
  quarter: "9",
  year: "8",
};

/** 复权 → 同花顺类型末位 */
const ADJUST_CODE: Record<Adjust, string> = {
  none: "0",
  forward: "1",
  backward: "2",
};

/** 同花顺指数代码：上证系列是 `1A`/`1B` 前缀，深证指数是 `399` 前缀 */
const INDEX_CODES = new Set(["1A0001", "1B0300", "1B0905", "1B0016", "399001", "399006"]);

/** 常见「交易所前缀」指数别名 → 同花顺代码 */
const INDEX_ALIASES: Record<string, string> = {
  sh000001: "1A0001",
  sh000300: "1B0300",
  sh000905: "1B0905",
  sh000016: "1B0016",
  sz399001: "399001",
  sz399006: "399006",
};

export interface ThsSymbol {
  /** 同花顺原生符号：股票 `hs_600519`、指数 `hs_1A0001`、板块 `bk_881101` */
  symbol: string;
  kind: "stock" | "index" | "board";
}

export function isIndexCode(code: string): boolean {
  return INDEX_CODES.has(code.toUpperCase()) || /^399\d{3}$/.test(code) || /^1[AB]\d{4}$/i.test(code);
}

export function isBoardCode(code: string): boolean {
  return /^88[15]\d{3}$/.test(code);
}

/**
 * 代码归类：决定涨跌停幅度与交易规则。
 *
 * 北交所只有新码段 `920xxx`（老 83/43 码已迁移，同花顺返回空）。
 */
export function classifyCode(code: string): BoardKind {
  const value = code.trim().toUpperCase();
  if (isIndexCode(value)) return "index";
  if (isBoardCode(value)) return "board";
  if (/^(600|601|603|605)\d{3}$/.test(value)) return "sh-main";
  if (/^(688|689)\d{3}$/.test(value)) return "star";
  if (/^(000|001|002|003)\d{3}$/.test(value)) return "sz-main";
  if (/^(300|301|302)\d{3}$/.test(value)) return "gem";
  if (/^(920|430|83|87)\d{3}$/.test(value)) return "bse";
  return "unknown";
}

export function isStName(name: string): boolean {
  return /(^|\*)ST/i.test(name.replace(/\s/g, ""));
}

/**
 * 用户输入 → 同花顺原生符号。
 *
 * 容忍常见写法：`600519` / `sh600519` / `600519.SH` / `hs_600519`。
 * 指数也可以写 `sh000001`（映射到同花顺的 `1A0001`）。
 */
export function toThsSymbol(input: string): ThsSymbol {
  const raw = input.trim().toLowerCase().replace(/\s/g, "");
  if (!raw) throw new Error("代码不能为空。");

  if (raw.startsWith("bk_")) return { symbol: raw, kind: "board" };
  if (raw.startsWith("hs_")) {
    const code = raw.slice(3).toUpperCase();
    return { symbol: `hs_${code}`, kind: isIndexCode(code) ? "index" : "stock" };
  }

  const aliased = INDEX_ALIASES[raw];
  if (aliased) return { symbol: `hs_${aliased}`, kind: "index" };

  const prefixed = /^(sh|sz|bj)(\d{6})$/.exec(raw);
  if (prefixed) {
    const code = prefixed[2];
    const alias = INDEX_ALIASES[`${prefixed[1]}${code}`];
    if (alias) return { symbol: `hs_${alias}`, kind: "index" };
    return { symbol: `hs_${code}`, kind: isIndexCode(code) ? "index" : "stock" };
  }

  const suffixed = /^(\d{6})\.(sh|sz|bj)$/.exec(raw);
  if (suffixed) {
    const code = suffixed[1];
    return { symbol: `hs_${code}`, kind: isIndexCode(code) ? "index" : "stock" };
  }

  if (/^\d{6}$/.test(raw)) {
    if (isBoardCode(raw)) return { symbol: `bk_${raw}`, kind: "board" };
    return { symbol: `hs_${raw}`, kind: isIndexCode(raw) ? "index" : "stock" };
  }

  if (/^1[ab]\d{4}$/i.test(raw)) {
    return { symbol: `hs_${raw.toUpperCase()}`, kind: "index" };
  }

  throw new Error(`无法识别的代码：${input}（示例：600519 / sh600519 / 1A0001 / 881101）`);
}

/** K 线的同花顺 type 参数（周期 + 复权） */
export function barsType(period: BarPeriod, adjust: Adjust): string {
  return `${PERIOD_CODE[period]}${ADJUST_CODE[adjust]}`;
}

/** 去掉 JSONP 包装（`cb({...})`）后解析；已经是纯 JSON 时直接解析 */
export function parseJsonp(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("同花顺返回了空内容。");
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  if (start < 0 || end <= start) {
    throw new Error(`同花顺返回格式无法解析：${trimmed.slice(0, 120)}`);
  }
  return JSON.parse(trimmed.slice(start + 1, end)) as Record<string, unknown>;
}

function numOf(items: Record<string, unknown>, key: string): number | undefined {
  const raw = items[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 实时快照字段码 → `Quote`。
 *
 * 字段码来自同花顺 `items`（`{"10":"1453.00", ...}`）：
 * 6 昨收 / 7 开 / 8 高 / 9 低 / 10 最新 / 13 成交量(股) / 19 成交额(元) /
 * 69 涨停价 / 70 跌停价 / 199112 涨跌幅(%) / 1968584 换手率(%) /
 * 1378761 当日均价 / 402 总股本 / 407 流通股本 / 3475914 总市值。
 */
export function decodeQuote(symbol: ThsSymbol, rawItems: unknown): Quote {
  const items = (rawItems ?? {}) as Record<string, unknown>;
  const code = String(items["5"] ?? symbol.symbol.replace(/^(hs_|bk_)/, ""));
  const name = String(items.name ?? "");
  const preClose = numOf(items, "6") ?? 0;
  const price = numOf(items, "10") ?? preClose;
  // 保留两位小数：直接相减会带出 9.840000000000003 这类浮点尾数
  const change = Math.round((price - preClose) * 100) / 100;
  const changePct =
    numOf(items, "199112") ?? (preClose > 0 ? (change / preClose) * 100 : 0);

  return {
    code,
    name,
    price,
    preClose,
    open: numOf(items, "7") ?? 0,
    high: numOf(items, "8") ?? 0,
    low: numOf(items, "9") ?? 0,
    change,
    changePct,
    volume: numOf(items, "13") ?? 0,
    amount: numOf(items, "19") ?? 0,
    turnoverPct: numOf(items, "1968584"),
    avgPrice: numOf(items, "1378761"),
    limitUp: numOf(items, "69"),
    limitDown: numOf(items, "70"),
    totalShares: numOf(items, "402"),
    floatShares: numOf(items, "407"),
    marketCap: numOf(items, "3475914"),
    stockStatus: items.stockStatus ? String(items.stockStatus) : undefined,
    marketType: items.marketType ? String(items.marketType) : undefined,
    updatedAt: items.updateTime ? String(items.updateTime) : undefined,
    board: classifyCode(code),
    st: isStName(name),
  };
}

/** `YYYYMMDD` / `YYYYMMDDHHmm` → 可读时间 */
export function formatBarTime(raw: string): string {
  const text = raw.trim();
  if (!/^\d{8}(\d{4})?$/.test(text)) return text;
  const year = text.slice(0, 4);
  const month = text.slice(4, 6);
  const day = text.slice(6, 8);
  if (text.length === 8) return `${year}-${month}-${day}`;
  return `${year}-${month}-${day} ${text.slice(8, 10)}:${text.slice(10, 12)}`;
}

/**
 * `last.js` 的行内格式：`date,open,high,low,close,vol(股),amount(元),turnover(%),…`
 * 固定返回最近 140 根。
 */
export function decodeLastBars(payload: unknown): Bar[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (typeof data !== "string" || !data) return [];
  const bars: Bar[] = [];
  for (const row of data.split(";")) {
    const fields = row.split(",");
    if (fields.length < 6) continue;
    const open = Number(fields[1]);
    const high = Number(fields[2]);
    const low = Number(fields[3]);
    const close = Number(fields[4]);
    const volume = Number(fields[5]);
    if (![open, high, low, close, volume].every(Number.isFinite)) continue;
    bars.push({
      time: formatBarTime(fields[0]),
      open,
      high,
      low,
      close,
      volume,
      amount: Number.isFinite(Number(fields[6])) ? Number(fields[6]) : undefined,
      turnoverPct: Number.isFinite(Number(fields[7])) ? Number(fields[7]) : undefined,
    });
  }
  return bars;
}

/**
 * `all.js` 的列式格式：
 * - `price` 每根 4 个值，单位「分」，含义是 `[low, open-low, high-low, close-low]`
 *   （同花顺为压缩体积只存差值，实测 2026-11-06 茅台：143600/1400/2172/1700 →
 *   1436.00 / 1450.00 / 1457.72 / 1453.00）；
 * - `volumn` 每根一个值（股）；
 * - `dates` 是 `MMDD`（分钟线为 `MMDDHHmm`），年份靠 `start` + 跨年回绕推断。
 */
export function decodeAllBars(payload: unknown): Bar[] {
  const data = (payload ?? {}) as Record<string, unknown>;
  const factor = Number(data.priceFactor) || 100;
  const prices = String(data.price ?? "").split(",");
  const volumes = String(data.volumn ?? "").split(",");
  const dates = String(data.dates ?? "").split(",");
  const startDate = String(data.start ?? "");
  const startYear = Number(startDate.slice(0, 4)) || new Date().getFullYear();

  const bars: Bar[] = [];
  let year = startYear;
  let previous = "";
  for (let index = 0; index < dates.length; index += 1) {
    const mark = dates[index]?.trim();
    if (!mark) continue;
    const key = mark.length >= 8 ? mark.slice(0, 8) : mark;
    if (previous && key < previous) year += 1;
    previous = key;

    const offset = index * 4;
    if (offset + 3 >= prices.length) break;
    const low = Number(prices[offset]) / factor;
    const open = low + Number(prices[offset + 1]) / factor;
    const high = low + Number(prices[offset + 2]) / factor;
    const close = low + Number(prices[offset + 3]) / factor;
    const volume = Number(volumes[index] ?? 0);
    if (![open, high, low, close].every(Number.isFinite)) continue;

    const month = mark.slice(0, 2);
    const day = mark.slice(2, 4);
    const time =
      mark.length >= 8
        ? `${year}-${month}-${day} ${mark.slice(4, 6)}:${mark.slice(6, 8)}`
        : `${year}-${month}-${day}`;
    bars.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return bars;
}

/** 分时：`{ hs_600519: { pre, date, isTrading, data: "0930,1450.00,226345000,1450.000,…" } }` */
export function decodeIntraday(symbol: ThsSymbol, payload: unknown): IntradaySeries {
  const data = (payload ?? {}) as Record<string, unknown>;
  const key = Object.keys(data)[0];
  const block = (key ? data[key] : {}) as Record<string, unknown>;
  const rows = typeof block.data === "string" ? block.data.split(";") : [];
  const points = [];
  for (const row of rows) {
    const fields = row.split(",");
    if (fields.length < 3) continue;
    const price = Number(fields[1]);
    const volume = Number(fields[2]);
    if (!Number.isFinite(price)) continue;
    points.push({
      time: /^\d{4}$/.test(fields[0]) ? `${fields[0].slice(0, 2)}:${fields[0].slice(2)}` : fields[0],
      price,
      volume: Number.isFinite(volume) ? volume : 0,
      avgPrice: Number(fields[3]) || price,
    });
  }
  return {
    code: symbol.symbol.replace(/^hs_/, ""),
    name: block.name ? String(block.name) : undefined,
    preClose: Number(block.pre) || undefined,
    date: block.date ? String(block.date) : undefined,
    trading: Boolean(Number(block.isTrading)),
    points,
  };
}

/* ------------------------------ 网络与节流 ------------------------------ */

function concurrency(): number {
  const raw = Number(process.env.XZH_A_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.min(32, Math.floor(raw)) : 8;
}

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < concurrency()) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

/**
 * 有上限的并发映射。
 *
 * 同花顺没有批量快照接口，全市场只能逐只请求；这里限流既是礼貌，也是
 * 防止某天被风控整段封掉。`XZH_A_CONCURRENCY` 可调（默认 8，上限 32）。
 */
export async function mapLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = concurrency(),
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function firstProxyEnv(): string | undefined {
  for (const key of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

let envDispatcher: Dispatcher | undefined;
let envDispatcherUrl: string | undefined;
let preferProxy = false;

function envProxyFetch(): typeof undiciFetch | null {
  const proxy = firstProxyEnv();
  if (!proxy) return null;
  if (!envDispatcher || envDispatcherUrl !== proxy) {
    envDispatcher = new ProxyAgent(proxy);
    envDispatcherUrl = proxy;
  }
  const dispatcher = envDispatcher;
  return ((input, init) =>
    undiciFetch(input, { ...(init ?? {}), dispatcher })) as typeof undiciFetch;
}

/**
 * 同花顺请求：**先直连，失败再走 shell 代理**。
 *
 * 同花顺是国内站点，多数环境直连即可；只有用户的网络必须走代理时才回退。
 * 和币安适配器同一策略，避免把「代理不可用」变成「行情永久不可用」。
 */
async function request(url: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  const direct = (globalThis as { fetch?: typeof undiciFetch }).fetch ?? undiciFetch;
  if (preferProxy) {
    const proxied = envProxyFetch();
    if (proxied) {
      try {
        return await proxied(url, init);
      } catch {
        preferProxy = false;
      }
    } else {
      preferProxy = false;
    }
  }
  try {
    return await direct(url, init);
  } catch (err) {
    const proxied = envProxyFetch();
    if (!proxied) throw err;
    preferProxy = true;
    return proxied(url, init);
  }
}

/**
 * 取一段 JSONP 并解析，带超时、重试与 404 归类。
 *
 * 返回 200 但空 body 也是「代码不存在」的常见表现（北交所老码段就是如此），
 * 这里统一报成可读错误，避免上层拿到 `NaN`。
 */
async function fetchJsonp(
  path: string,
  options: { timeoutMs?: number; retries?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const retries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await acquire();
    try {
      const response = await request(`${BASE}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": USER_AGENT },
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`同花顺未收录该代码（${path}）。`);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status >= 500 && attempt < retries) {
          lastError = new Error(`同花顺接口 HTTP ${response.status}`);
          continue;
        }
        throw new Error(
          `同花顺接口 HTTP ${response.status}${body ? `：${body.slice(0, 160)}` : ""}`,
        );
      }
      const text = await response.text();
      if (!text.trim()) {
        throw new Error("同花顺未返回数据（代码不存在、已退市，或接口改版）。");
      }
      return parseJsonp(text);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // 404 / 空数据不是瞬时故障，重试没有意义
      if (message.includes("未收录") || message.includes("未返回数据")) throw err;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    } finally {
      release();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 实时快照（股票 / 指数 / 板块都用同一个端点） */
export async function fetchQuote(input: string): Promise<Quote> {
  const symbol = toThsSymbol(input);
  const payload = await fetchJsonp(`/v6/realhead/${symbol.symbol}/last.js`);
  const items = (payload as { items?: unknown }).items;
  if (!items) throw new Error("同花顺快照缺少 items 字段（接口可能已改版）。");
  return decodeQuote(symbol, items);
}

export interface FetchBarsOptions {
  period?: BarPeriod;
  adjust?: Adjust;
  /** 返回最后 N 根；`<= 0` 或 `Infinity` 表示全部 */
  limit?: number;
  /** 起始日期 `YYYY-MM-DD`（含） */
  from?: string;
}

/**
 * K 线：短窗口走 `last.js`（140 根、带成交额），长窗口走 `all.js`（全历史、列式）。
 *
 * 注意前复权在高分红股上**早年可能为负**（茅台 2001 年 -314.67），做指标与回测
 * 请用 `adjust: "backward"`（后复权，恒正且收益连续）。
 */
export async function fetchBars(input: string, options: FetchBarsOptions = {}): Promise<Bar[]> {
  const symbol = toThsSymbol(input);
  const period = options.period ?? "day";
  if (period === "15m") {
    const { fetch15mBars } = await import("./fifteen");
    let bars = await fetch15mBars(input, options.limit ?? 160);
    if (options.from) bars = bars.filter((bar) => bar.time.slice(0, 10) >= options.from!);
    return bars;
  }
  const adjust = options.adjust ?? "backward";
  const limit = options.limit ?? 250;
  const type = barsType(period, adjust);
  const recent = !options.from && limit > 0 && Number.isFinite(limit) && limit <= 140;

  const payload = await fetchJsonp(
    `/v6/line/${symbol.symbol}/${type}/${recent ? "last" : "all"}.js`,
    recent ? {} : { timeoutMs: 15_000 },
  );
  let bars = recent ? decodeLastBars(payload) : decodeAllBars(payload);
  if (options.from) {
    bars = bars.filter((bar) => bar.time.slice(0, 10) >= options.from!);
  }
  if (limit > 0 && Number.isFinite(limit) && bars.length > limit) {
    bars = bars.slice(-limit);
  }
  return bars;
}

/** 当日分时（268 个点，含交易时段与昨收） */
export async function fetchIntraday(input: string): Promise<IntradaySeries> {
  const symbol = toThsSymbol(input);
  const payload = await fetchJsonp(`/v6/time/${symbol.symbol}/last.js`);
  return decodeIntraday(symbol, payload);
}
