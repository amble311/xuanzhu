import { readCache, writeCache } from "./cache";
import { classifyCode, fetchQuote, isStName, mapLimit } from "./ths";
import type { UniverseStock } from "./types";

/**
 * A 股股票池（代码 → 名称 / 板块）。
 *
 * 同花顺没有「全市场列表」的免鉴权接口：`q.10jqka.com.cn` 的排行榜与成分股
 * ajax 需要 `hexin-v` 的 JS 挑战。这里改成**按代码段逐只探测** —— 沪市
 * 600/601/603/605、科创板 688/689、深市 000/001/002/003、创业板 300/301/302、
 * 北交所 920，共约 1.4 万个候选，未上市的代码返回 404/空，直接跳过。
 *
 * 结果按 7 天缓存（新股上市不会立刻出现在池里，可用 `xzh a sync --force` 刷新）。
 */

export interface StockCodeRange {
  from: number;
  to: number;
  note: string;
}

export const STOCK_CODE_RANGES: StockCodeRange[] = [
  { from: 600000, to: 601999, note: "沪市主板" },
  { from: 603000, to: 603999, note: "沪市主板" },
  { from: 605000, to: 605999, note: "沪市主板" },
  { from: 688000, to: 688999, note: "科创板" },
  { from: 689000, to: 689999, note: "科创板（CDR）" },
  { from: 1, to: 1999, note: "深市主板" },
  { from: 2000, to: 3999, note: "深市主板（中小板并入）" },
  { from: 300000, to: 301999, note: "创业板" },
  { from: 302000, to: 302999, note: "创业板" },
  { from: 920000, to: 920999, note: "北交所" },
];

export const UNIVERSE_CACHE = "universe.json";
const DEFAULT_TTL_DAYS = 7;

function ttlMs(): number {
  const days = Number(process.env.XZH_A_UNIVERSE_TTL_DAYS);
  const value = Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS;
  return value * 24 * 60 * 60 * 1000;
}

/** 展开所有候选代码（6 位、补零） */
export function stockCodes(): string[] {
  const codes: string[] = [];
  for (const range of STOCK_CODE_RANGES) {
    for (let value = range.from; value <= range.to; value += 1) {
      codes.push(String(value).padStart(6, "0"));
    }
  }
  return codes;
}

export interface ScanUniverseOptions {
  onProgress?: (done: number, total: number) => void;
  /** 只扫一部分（调试 / 测试用） */
  codes?: string[];
}

/** 逐只探测并返回有效股票（并发由 `mapLimit` 限制） */
export async function scanUniverse(
  options: ScanUniverseOptions = {},
): Promise<UniverseStock[]> {
  const codes = options.codes ?? stockCodes();
  let done = 0;
  const found = await mapLimit(codes, async (code): Promise<UniverseStock | null> => {
    try {
      const quote = await fetchQuote(code);
      if (!quote.name) return null;
      const board = classifyCode(code);
      if (board === "unknown" || board === "index" || board === "board") return null;
      return {
        code,
        name: quote.name,
        board,
        marketType: quote.marketType,
        st: quote.st || isStName(quote.name),
      };
    } catch {
      return null;
    } finally {
      done += 1;
      options.onProgress?.(done, codes.length);
    }
  });
  return found
    .filter((item): item is UniverseStock => item !== null)
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** 读缓存；过期或 `refresh` 时重新扫描（约 1.4 万个候选，几十秒） */
export async function loadUniverse(
  options: { refresh?: boolean } = {},
): Promise<UniverseStock[]> {
  if (!options.refresh) {
    const cached = readCache<UniverseStock[]>(UNIVERSE_CACHE, ttlMs());
    if (cached) return cached.value;
  }
  const stocks = await scanUniverse();
  if (stocks.length === 0) {
    throw new Error("股票池扫描没有拿到任何数据（同花顺接口不可达或被限频）。");
  }
  writeCache(UNIVERSE_CACHE, stocks);
  return stocks;
}

export function findStock(stocks: UniverseStock[], code: string): UniverseStock | undefined {
  return stocks.find((stock) => stock.code === code);
}

export function universeSummary(stocks: UniverseStock[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const stock of stocks) summary[stock.board] = (summary[stock.board] ?? 0) + 1;
  return summary;
}
