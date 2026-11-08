import { readCache, writeCache } from "./cache";
import { fetchQuote, mapLimit } from "./ths";
import type { BoardRef, BoardType, Quote } from "./types";

/**
 * 同花顺板块清单（行业 881xxx / 概念 885xxx）。
 *
 * 为什么不用板块列表页：`q.10jqka.com.cn` 的列表与成分股 ajax 需要 `hexin-v`
 * 的 JS 挑战。板块代码段本身就是连续的，**扫 `bk_` 快照**即可拿到代码 + 名称 +
 * 涨跌幅，全程留在免鉴权的 `d.` 域内（881000–881999 / 885000–885999）。
 */

export const BOARDS_CACHE = "boards.json";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const BOARD_RANGES: Array<{ type: BoardType; from: number; to: number }> = [
  { type: "industry", from: 881000, to: 881999 },
  { type: "concept", from: 885000, to: 885999 },
];

/** 待扫描的板块代码（`881xxx` / `885xxx`） */
export function boardCodes(): Array<{ code: string; type: BoardType }> {
  const codes: Array<{ code: string; type: BoardType }> = [];
  for (const range of BOARD_RANGES) {
    for (let value = range.from; value <= range.to; value += 1) {
      codes.push({ code: String(value), type: range.type });
    }
  }
  return codes;
}

export interface ScanBoardsOptions {
  onProgress?: (done: number, total: number) => void;
}

/** 扫描板块清单（约 2000 个候选，并发 8 时数秒） */
export async function scanBoards(options: ScanBoardsOptions = {}): Promise<BoardRef[]> {
  const candidates = boardCodes();
  let done = 0;
  const found = await mapLimit(candidates, async (item) => {
    try {
      const quote = await fetchQuote(`bk_${item.code}`);
      if (!quote.name) return null;
      return { code: item.code, name: quote.name, type: item.type } satisfies BoardRef;
    } catch {
      return null;
    } finally {
      done += 1;
      options.onProgress?.(done, candidates.length);
    }
  });
  return found
    .filter((item): item is BoardRef => item !== null)
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** 读缓存；过期或 `refresh` 时重新扫描 */
export async function loadBoards(options: { refresh?: boolean } = {}): Promise<BoardRef[]> {
  if (!options.refresh) {
    const cached = readCache<BoardRef[]>(BOARDS_CACHE, CACHE_TTL_MS);
    if (cached) return cached.value;
  }
  const boards = await scanBoards();
  if (boards.length > 0) writeCache(BOARDS_CACHE, boards);
  return boards;
}

export function boardsByType(boards: BoardRef[], type: BoardType): BoardRef[] {
  return boards.filter((board) => board.type === type);
}

export interface BoardQuote {
  board: BoardRef;
  quote: Quote;
}

/** 批量拉板块快照（用于涨幅榜；单个失败不影响整体） */
export async function fetchBoardQuotes(boards: BoardRef[]): Promise<BoardQuote[]> {
  const rows = await mapLimit(boards, async (board) => {
    try {
      return { board, quote: await fetchQuote(`bk_${board.code}`) };
    } catch {
      return null;
    }
  });
  return rows.filter((row): row is BoardQuote => row !== null);
}
