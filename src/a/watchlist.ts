import * as fs from "fs";
import * as path from "path";
import { ensureDir, getAShareHome } from "../utils/paths";
import { DEFAULT_POOL_SIZE } from "./settings";

/**
 * A 股自选股（监控池）。
 *
 * 与 btc 的「单标的」不同，A 股巡检要**轮询**一小组股票：池子容量默认 5 只
 * （`settings.json` 的 `poolSize`，用户可改），**持仓强制占名额**，
 * 剩余名额从全市场选出来。巡检顺序是「持仓优先」，其余按评分降序 —— 见 `orderedPool()`。
 */

export interface WatchItem {
  code: string;
  name: string;
  /** 0–100 综合分（月/周/日趋势 + 1h 择时） */
  score: number;
  /** 入选理由（给面板与模型看） */
  reason: string;
  source: "select" | "held" | "manual";
  addedAt: string;
}

export interface WatchlistFile {
  version: 1;
  updatedAt: string;
  items: WatchItem[];
}

export function monitorDir(): string {
  return path.join(getAShareHome(), "monitor");
}

export function watchlistPath(): string {
  return path.join(monitorDir(), "watchlist.json");
}

export function emptyWatchlist(): WatchlistFile {
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
}

export function loadWatchlist(): WatchlistFile {
  try {
    const raw = JSON.parse(fs.readFileSync(watchlistPath(), "utf8")) as Partial<WatchlistFile>;
    const items = Array.isArray(raw.items)
      ? raw.items
          .filter((item): item is WatchItem => Boolean(item && typeof item.code === "string"))
          .map((item) => ({
            code: item.code,
            name: typeof item.name === "string" ? item.name : item.code,
            score: Number(item.score) || 0,
            reason: typeof item.reason === "string" ? item.reason : "",
            source:
              item.source === "held" || item.source === "manual" || item.source === "select"
                ? item.source
                : "select",
            addedAt: typeof item.addedAt === "string" ? item.addedAt : new Date().toISOString(),
          }))
      : [];
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      items,
    };
  } catch {
    return emptyWatchlist();
  }
}

export function saveWatchlist(list: WatchlistFile): void {
  ensureDir(monitorDir());
  const tmp = `${watchlistPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, watchlistPath());
}

/**
 * 合并一次选股结果：持仓强制保留，其余按分数取前 N。
 *
 * 持仓可能因为停牌/数据缺失拿不到新分数，用旧分数或 0 保留；
 * 池子超过上限时允许超（持仓优先），但不会为了凑数把持仓挤掉。
 */
export function mergeWatchlist(
  candidates: WatchItem[],
  held: Array<{ code: string; name: string }>,
  now = new Date(),
  limit = DEFAULT_POOL_SIZE,
): WatchlistFile {
  const byCode = new Map<string, WatchItem>();
  for (const item of candidates) byCode.set(item.code, item);
  for (const position of held) {
    const existing = byCode.get(position.code);
    byCode.set(position.code, {
      code: position.code,
      name: existing?.name ?? position.name,
      score: existing?.score ?? 0,
      reason: existing?.reason ?? "已持仓，强制保留",
      source: "held",
      addedAt: existing?.addedAt ?? now.toISOString(),
    });
  }

  const heldCodes = new Set(held.map((item) => item.code));
  const sorted = [...byCode.values()].sort((a, b) => {
    // 持仓排前面（同一分数下），其余按分数降序
    if (heldCodes.has(a.code) !== heldCodes.has(b.code)) return heldCodes.has(a.code) ? -1 : 1;
    return b.score - a.score;
  });
  const kept = sorted.filter((item) => heldCodes.has(item.code));
  for (const item of sorted) {
    if (kept.length >= limit) break;
    if (!heldCodes.has(item.code)) kept.push(item);
  }
  return { version: 1, updatedAt: now.toISOString(), items: kept };
}

export function addWatchItem(
  item: WatchItem,
  limit = DEFAULT_POOL_SIZE,
): { ok: boolean; error?: string; list: WatchlistFile } {
  const list = loadWatchlist();
  if (list.items.some((existing) => existing.code === item.code)) {
    return { ok: false, error: `${item.code} 已在自选股中`, list };
  }
  if (list.items.length >= limit) {
    return { ok: false, error: `自选池最多 ${limit} 只（xzh a settings 可调），请先移除`, list };
  }
  list.items.push(item);
  list.updatedAt = new Date().toISOString();
  saveWatchlist(list);
  return { ok: true, list };
}

export interface PoolEntry {
  code: string;
  name: string;
  /** 是否持仓（巡检时排在最前） */
  held: boolean;
  score: number;
  reason: string;
}

/**
 * 巡检轮询顺序：**持仓优先**，其余按评分降序，最多 `limit` 只（默认 `poolSize`）。
 *
 * 持仓可能不在自选文件里（手工删过、或刚买入），这里做并集补回来 ——
 * 「池子容量含持仓」是硬约束，不能因为文件不同步就让持仓漏出巡检视野。
 */
export function orderedPool(
  held: Array<{ code: string; name?: string }> = [],
  list: WatchlistFile = loadWatchlist(),
  limit = DEFAULT_POOL_SIZE,
): PoolEntry[] {
  const heldCodes = new Map(held.map((item) => [item.code, item.name]));
  const entries: PoolEntry[] = [];
  for (const [code, name] of heldCodes) {
    const existing = list.items.find((item) => item.code === code);
    entries.push({
      code,
      name: existing?.name ?? name ?? code,
      held: true,
      score: existing?.score ?? 0,
      reason: existing?.reason ?? "持仓（强制保留在池内）",
    });
  }
  const rest = list.items
    .filter((item) => !heldCodes.has(item.code))
    .sort((a, b) => b.score - a.score);
  for (const item of rest) {
    if (entries.length >= limit) break;
    entries.push({
      code: item.code,
      name: item.name,
      held: false,
      score: item.score,
      reason: item.reason,
    });
  }
  return entries;
}

export function removeWatchItem(
  code: string,
  heldCodes: Set<string>,
): { ok: boolean; error?: string; list: WatchlistFile } {
  const list = loadWatchlist();
  if (heldCodes.has(code)) {
    return { ok: false, error: `${code} 已持仓，必须保留在自选股中`, list };
  }
  const before = list.items.length;
  list.items = list.items.filter((item) => item.code !== code);
  if (list.items.length === before) return { ok: false, error: `${code} 不在自选股中`, list };
  list.updatedAt = new Date().toISOString();
  saveWatchlist(list);
  return { ok: true, list };
}
