import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { Bar } from "./types";

/**
 * 15 分钟 K 线（新浪）。
 *
 * 同花顺免鉴权域没有 15 分钟周期（只有 5/30/60），东财 push2his 对部分网络
 * 不稳定；选股要求 15m 深度分析，因此单独使用新浪 `getKLineData`。
 */

function firstProxy(): string | undefined {
  for (const key of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function sinaSymbol(code: string): string {
  if (/^[69]/.test(code)) return `sh${code}`;
  if (/^[48]/.test(code) || /^92/.test(code)) return `bj${code}`;
  return `sz${code}`;
}

export async function fetch15mBars(code: string, limit = 160): Promise<Bar[]> {
  const datalen = Math.max(40, Math.min(500, limit));
  const url =
    "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData" +
    `?symbol=${sinaSymbol(code)}&scale=15&ma=no&datalen=${datalen}`;
  const headers = { "user-agent": "Mozilla/5.0 xzh-ashare/1.0", accept: "application/json" };
  const proxy = firstProxy();
  const request = async (dispatcher?: ProxyAgent) =>
    undiciFetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
      ...(dispatcher ? { dispatcher } : {}),
    });
  let response = await request(proxy ? new ProxyAgent(proxy) : undefined).catch(async (err) => {
    if (!proxy) throw err;
    return request(undefined);
  });
  if (!response.ok) throw new Error(`新浪 15m HTTP ${response.status}`);
  const payload = (await response.json()) as Array<{
    day?: string;
    open?: string;
    high?: string;
    low?: string;
    close?: string;
    volume?: string;
    amount?: string;
  }>;
  const bars: Bar[] = [];
  for (const row of Array.isArray(payload) ? payload : []) {
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Number(row.volume);
    if (![open, high, low, close, volume].every(Number.isFinite)) continue;
    const amount = Number(row.amount);
    bars.push({
      time: String(row.day ?? "").replace(" ", "T"),
      open,
      high,
      low,
      close,
      volume,
      amount: Number.isFinite(amount) ? amount : close * volume,
    });
  }
  return bars.slice(-datalen);
}
