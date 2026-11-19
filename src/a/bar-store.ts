import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import type { Bar } from "../exchange/ashare";
import { getAShareHome } from "../utils/paths";

/**
 * 全市场**日线仓库**（`<XZH_A_HOME>/cache/bars.db`）。
 *
 * 为什么需要：选股每天都要算一遍全市场日线指标，而 `loadIndicators()` 每次都
 * 对 5000+ 只各拉 140 根日线 —— 这是选股里最贵的一步（1–2 分钟 + 几十 MB 流量）。
 * 日线的增量其实只有「今天这一根」：把历史留在库里、每天只补一根，
 * 就能把 5583 个请求降到个位数。
 *
 * **后复权怎么处理**（这是整套设计里唯一必须小心的地方）：
 * - 官方 `fetchBars(adjust:"backward")` 返回的是后复权价，而快照（`fetchQuote`）是**原始价**，
 *   两者差一个累计因子（实测 600886：后复权 747.44 vs 原始 16.18，约 46 倍）；
 * - 因此每个代码存一个 `ratio = 后复权收盘 / 原始收盘`，今天的原始 bar × ratio 才是后复权 bar；
 * - 送转 / 分红会让 ratio 变化（除权），所以补今天这根之前必须校验：
 *   `今日原始 preClose × ratio` 应该等于库里最后一根的后复权收盘，偏差超过 0.3% 就当作除权，
 *   该股票**整段重取**（ratio 一并重算）。校验放在 `indicators.ts::appendTodayBar()`。
 *
 * 兼容性：`node:sqlite` 是 Node 22.5+ 的内置模块，`package.json` 仍写着 `>=18`。
 * 拿不到 SQLite 时 `openDailyBarStore()` 返回 null，调用方退回「每只现取 140 根」的老路径。
 */

const DB_FILE = "bars.db";
/** 每个代码保留的日线根数：指标要 140 根，留余量避免「刚补完今天就不够 140」 */
const KEEP_BARS = 200;
/** 超过这个条数才裁剪一次（每次补一根都裁剪太费） */
const TRIM_THRESHOLD = KEEP_BARS + 60;

export interface BarMeta {
  code: string;
  /** 后复权收盘 / 原始收盘（同一交易日）；0 表示未知（不能用来补当天 bar） */
  ratio: number;
  /** 已入库的最后一个交易日 `YYYY-MM-DD` */
  lastDate: string;
  /** 该交易日的**原始**收盘价（排障用） */
  rawClose: number;
  updatedAt: string;
}

export interface DailyBarStore {
  /** 升序返回最近 `limit` 根（不足就返回全部） */
  load(code: string, limit?: number): Bar[];
  /** 整段替换（首次入库 / 除权重取） */
  upsert(code: string, bars: Bar[], meta: BarMeta): void;
  /** 追加一根（当天增量），并顺手裁剪过老的行 */
  append(code: string, bar: Bar, meta: BarMeta): void;
  meta(code: string): BarMeta | undefined;
  /** 库里有多少个代码（状态展示 / 测试） */
  size(): number;
  close(): void;
}

/** 极简 `node:sqlite` 类型（Node 18 的类型定义里没有这个模块） */
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function barStorePath(home = getAShareHome()): string {
  return path.join(home, "cache", DB_FILE);
}

function openDatabase(file: string): SqliteDatabase | null {
  try {
    const requireFromHere = createRequire(__filename);
    const module = requireFromHere("node:sqlite") as {
      DatabaseSync: new (file: string) => SqliteDatabase;
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new module.DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec(
      `CREATE TABLE IF NOT EXISTS daily (
         code TEXT NOT NULL,
         date TEXT NOT NULL,
         open REAL NOT NULL,
         high REAL NOT NULL,
         low REAL NOT NULL,
         close REAL NOT NULL,
         volume REAL NOT NULL DEFAULT 0,
         amount REAL,
         PRIMARY KEY (code, date)
       )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS meta (
         code TEXT PRIMARY KEY,
         ratio REAL NOT NULL DEFAULT 0,
         last_date TEXT NOT NULL,
         raw_close REAL,
         updated_at TEXT NOT NULL
       )`,
    );
    return db;
  } catch {
    // 没有 node:sqlite（Node < 22.5）或文件不可写 → 由调用方退回老路径
    return null;
  }
}

function toBar(row: Record<string, unknown>): Bar | null {
  const close = Number(row.close);
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) return null;
  return {
    time: String(row.date ?? ""),
    open,
    high,
    low,
    close,
    volume: Number(row.volume) || 0,
    amount: row.amount === null || row.amount === undefined ? undefined : Number(row.amount),
  };
}

function normalizeMeta(meta: BarMeta): BarMeta {
  return {
    code: meta.code,
    ratio: Number.isFinite(meta.ratio) && meta.ratio > 0 ? meta.ratio : 0,
    lastDate: meta.lastDate,
    rawClose: Number.isFinite(meta.rawClose) ? meta.rawClose : 0,
    updatedAt: meta.updatedAt || new Date().toISOString(),
  };
}

function createStore(db: SqliteDatabase): DailyBarStore {
  const selectMeta = db.prepare("SELECT * FROM meta WHERE code = ?");
  const selectBars = db.prepare(
    "SELECT date, open, high, low, close, volume, amount FROM daily WHERE code = ? ORDER BY date DESC LIMIT ?",
  );
  const deleteBars = db.prepare("DELETE FROM daily WHERE code = ?");
  const insertBar = db.prepare(
    `INSERT OR REPLACE INTO daily (code, date, open, high, low, close, volume, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertMeta = db.prepare(
    `INSERT INTO meta (code, ratio, last_date, raw_close, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       ratio = excluded.ratio, last_date = excluded.last_date,
       raw_close = excluded.raw_close, updated_at = excluded.updated_at`,
  );
  const countBars = db.prepare("SELECT COUNT(*) AS total FROM daily WHERE code = ?");
  const trimBars = db.prepare(
    `DELETE FROM daily WHERE code = ?
       AND date NOT IN (SELECT date FROM daily WHERE code = ? ORDER BY date DESC LIMIT ${KEEP_BARS})`,
  );
  const countCodes = db.prepare("SELECT COUNT(*) AS total FROM meta");

  const writeMeta = (meta: BarMeta): void => {
    const value = normalizeMeta(meta);
    upsertMeta.run(value.code, value.ratio, value.lastDate, value.rawClose, value.updatedAt);
  };

  return {
    load(code, limit = 140) {
      const rows = selectBars.all(code, Math.max(1, Math.floor(limit)));
      const bars: Bar[] = [];
      for (const row of rows) {
        const bar = toBar(row);
        if (bar) bars.push(bar);
      }
      return bars.reverse();
    },

    upsert(code, bars, meta) {
      const clean = bars
        .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
        .slice(-KEEP_BARS);
      if (clean.length === 0) return;
      db.exec("BEGIN IMMEDIATE");
      try {
        deleteBars.run(code);
        for (const bar of clean) {
          insertBar.run(
            code,
            bar.time.slice(0, 10),
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            bar.amount ?? null,
          );
        }
        writeMeta(meta);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    append(code, bar, meta) {
      db.exec("BEGIN IMMEDIATE");
      try {
        insertBar.run(
          code,
          bar.time.slice(0, 10),
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.amount ?? null,
        );
        writeMeta(meta);
        const total = Number(countBars.get(code)?.total ?? 0);
        if (total > TRIM_THRESHOLD) trimBars.run(code, code);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    meta(code) {
      const row = selectMeta.get(code);
      if (!row) return undefined;
      return {
        code,
        ratio: Number(row.ratio) || 0,
        lastDate: String(row.last_date ?? ""),
        rawClose: Number(row.raw_close) || 0,
        updatedAt: String(row.updated_at ?? ""),
      };
    },

    size() {
      return Number(countCodes.get()?.total ?? 0);
    },

    close() {
      try {
        db.close();
      } catch {
        // 已经关了 / 被 GC
      }
    },
  };
}

/** 进程内单例：同一路径只开一次（SQLite 连接不便宜） */
let cached: { file: string; store: DailyBarStore | null } | null = null;

/** 打开日线仓库；拿不到 SQLite 时返回 null（调用方必须能接受） */
export function openDailyBarStore(home = getAShareHome()): DailyBarStore | null {
  const file = barStorePath(home);
  if (cached?.file === file) return cached.store;
  if (cached) {
    try {
      cached.store?.close();
    } catch {
      // ignore
    }
  }
  const db = openDatabase(file);
  const store = db ? createStore(db) : null;
  cached = { file, store };
  return store;
}

/** 仅供测试：关闭并重置连接（换 home / 删库后重新打开） */
export function resetDailyBarStore(): void {
  try {
    cached?.store?.close();
  } catch {
    // ignore
  }
  cached = null;
}

/** 内存实现：单测用（不依赖 node:sqlite，也不留文件） */
export function createMemoryBarStore(): DailyBarStore {
  const bars = new Map<string, Bar[]>();
  const metas = new Map<string, BarMeta>();
  return {
    load: (code, limit = 140) => (bars.get(code) ?? []).slice(-Math.max(1, limit)),
    upsert(code, list, meta) {
      bars.set(code, list.slice(-KEEP_BARS).map((bar) => ({ ...bar })));
      metas.set(code, normalizeMeta(meta));
    },
    append(code, bar, meta) {
      const list = bars.get(code) ?? [];
      list.push({ ...bar });
      bars.set(code, list.slice(-KEEP_BARS));
      metas.set(code, normalizeMeta(meta));
    },
    meta: (code) => metas.get(code),
    size: () => metas.size,
    close() {
      bars.clear();
      metas.clear();
    },
  };
}
