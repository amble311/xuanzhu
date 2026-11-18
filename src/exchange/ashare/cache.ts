import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import { getAShareHome } from "../../utils/paths";

/**
 * A 股模块的磁盘缓存 —— **SQLite 单库**（`<XZH_A_HOME>/cache/ashare.db`）。
 *
 * 为什么换掉「一堆 JSON 文件」：全市场快照 / 日线指标都是几千行的大数组，
 * 每次读都要整文件 JSON.parse、写要整文件重写；而且「删掉非自选股的数据」在 JSON 里
 * 只能整份重写，SQLite 里是一行删除。选股后清理非池内数据，磁盘能一直保持在 MB 级。
 *
 * 兼容性：`node:sqlite` 是 Node 22.5+ 的内置模块，`package.json` 仍写着 `>=18` ——
 * 老 Node 上自动退回原来的 JSON 文件实现（行为不变），新 Node 用 SQLite。
 * 首次打开数据库时会把已有的 `cache/*.json` 迁进来并删掉旧文件。
 */

export interface CacheEnvelope<T> {
  updatedAt: string;
  value: T;
  /**
   * 数据是否**完整**（默认 true）。
   *
   * 选股后会把日线指标裁剪成「只保留自选池」，此时标记 `false`：
   * - 巡检/风控这类只查池内股票的地方可以接受部分缓存（`loadIndicators({ allowPartial: true })`）；
   * - 全市场筛选（`a_screen` / 选股）看到 `false` 必须重算，**不能**拿着 5 条数据当全市场。
   */
  complete?: boolean;
}

const DB_FILE = "ashare.db";

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

let databaseState: { db: SqliteDatabase | null } | null = null;

export function ashareCacheDir(): string {
  return path.join(getAShareHome(), "cache");
}

export function ashareCachePath(name: string): string {
  return path.join(ashareCacheDir(), name);
}

export function ashareCacheDbPath(): string {
  return path.join(ashareCacheDir(), DB_FILE);
}

/**
 * 打开（并初始化）缓存库；拿不到 `node:sqlite` 时返回 null → 调用方退回 JSON。
 *
 * 用 `createRequire` 而不是静态 import：静态 import 会让 Node 18 在**加载模块时**就崩，
 * 而这个文件被很多命令引用（`xzh a quote` 都要走缓存）。
 */
function database(): SqliteDatabase | null {
  if (databaseState) return databaseState.db;
  let db: SqliteDatabase | null = null;
  try {
    const requireFromHere = createRequire(__filename);
    const module = requireFromHere("node:sqlite") as {
      DatabaseSync: new (file: string) => SqliteDatabase;
    };
    fs.mkdirSync(ashareCacheDir(), { recursive: true });
    db = new module.DatabaseSync(ashareCacheDbPath());
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(
      `CREATE TABLE IF NOT EXISTS cache (
         name TEXT PRIMARY KEY,
         updated_at TEXT NOT NULL,
         complete INTEGER NOT NULL DEFAULT 1,
         value TEXT NOT NULL
       )`,
    );
  } catch {
    db = null;
  }
  databaseState = { db };
  if (db) migrateJsonCacheFiles(db);
  return db;
}

/** 旧版 `cache/*.json` → 数据库（只补缺失的，不覆盖；迁完删文件） */
function migrateJsonCacheFiles(db: SqliteDatabase): void {
  let files: string[];
  try {
    files = fs.readdirSync(ashareCacheDir()).filter((file) => file.endsWith(".json"));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(ashareCacheDir(), file), "utf8");
      const parsed = JSON.parse(raw) as Partial<CacheEnvelope<unknown>>;
      if (!parsed || typeof parsed !== "object" || !("value" in parsed)) continue;
      const existing = db.prepare("SELECT 1 FROM cache WHERE name = ?").get(file);
      if (!existing) {
        db.prepare(
          "INSERT INTO cache (name, updated_at, complete, value) VALUES (?, ?, ?, ?)",
        ).run(
          file,
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
          parsed.complete === false ? 0 : 1,
          JSON.stringify(parsed.value),
        );
      }
      fs.rmSync(path.join(ashareCacheDir(), file), { force: true });
    } catch {
      // 单个文件坏了就跳过：不能因为迁移失败让整个 A 股模块不可用
    }
  }
}

function readJson<T>(name: string, ttlMs: number): CacheEnvelope<T> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ashareCachePath(name), "utf8")) as CacheEnvelope<T>;
    if (!parsed || typeof parsed !== "object" || !("value" in parsed)) return null;
    const updated = Date.parse(parsed.updatedAt);
    if (!Number.isFinite(updated) || Date.now() - updated > ttlMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readCache<T>(name: string, ttlMs: number): CacheEnvelope<T> | null {
  const db = database();
  if (!db) return readJson<T>(name, ttlMs);
  try {
    const row = db.prepare("SELECT updated_at, complete, value FROM cache WHERE name = ?").get(name);
    if (!row) return null;
    const updatedAt = String(row.updated_at ?? "");
    const updated = Date.parse(updatedAt);
    if (!Number.isFinite(updated) || Date.now() - updated > ttlMs) return null;
    return {
      updatedAt,
      value: JSON.parse(String(row.value)) as T,
      complete: Number(row.complete) !== 0,
    };
  } catch {
    return null;
  }
}

export function writeCache<T>(
  name: string,
  value: T,
  options: { complete?: boolean; updatedAt?: string } = {},
): CacheEnvelope<T> {
  const envelope: CacheEnvelope<T> = {
    updatedAt: options.updatedAt ?? new Date().toISOString(),
    value,
    complete: options.complete ?? true,
  };
  const db = database();
  if (db) {
    try {
      db.prepare(
        `INSERT INTO cache (name, updated_at, complete, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at,
           complete = excluded.complete, value = excluded.value`,
      ).run(name, envelope.updatedAt, envelope.complete === false ? 0 : 1, JSON.stringify(value));
      return envelope;
    } catch {
      // 写库失败退回文件，至少别丢这一轮数据
    }
  }
  const target = ashareCachePath(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(envelope)}\n`, "utf8");
  return envelope;
}

/** 删除某个缓存（例如收盘后清掉全市场快照） */
export function deleteCache(name: string): void {
  const db = database();
  if (db) {
    try {
      db.prepare("DELETE FROM cache WHERE name = ?").run(name);
      return;
    } catch {
      // 落文件删除
    }
  }
  fs.rmSync(ashareCachePath(name), { force: true });
}

/**
 * 按代码裁剪缓存里的数组（日线指标 / 全市场快照这类「每行一只股票」的缓存），
 * 返回删掉的行数。裁剪后标记 `complete: false` —— 全市场筛选用到它时必须重算。
 */
export function pruneCacheCodes(name: string, keepCodes: string[]): number {
  const envelope = readCache<Array<{ code?: string }>>(name, Number.POSITIVE_INFINITY);
  if (!envelope || !Array.isArray(envelope.value)) return 0;
  const keep = new Set(keepCodes);
  const kept = envelope.value.filter(
    (row) => typeof row?.code === "string" && keep.has(row.code as string),
  );
  const removed = envelope.value.length - kept.length;
  if (removed <= 0) return 0;
  writeCache(name, kept, { complete: false, updatedAt: envelope.updatedAt });
  return removed;
}

/** 缓存条目信息（不看 TTL，供 `xzh a status` 展示） */
export function statCache(name: string): { exists: boolean; updatedAt?: string; bytes?: number } {
  const db = database();
  if (db) {
    try {
      const row = db
        .prepare("SELECT updated_at, length(value) AS bytes FROM cache WHERE name = ?")
        .get(name);
      if (!row) return { exists: false };
      return {
        exists: true,
        updatedAt: String(row.updated_at ?? ""),
        bytes: Number(row.bytes) || undefined,
      };
    } catch {
      return { exists: false };
    }
  }
  const target = ashareCachePath(name);
  try {
    const stat = fs.statSync(target);
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as CacheEnvelope<unknown>;
    return { exists: true, updatedAt: parsed.updatedAt, bytes: stat.size };
  } catch {
    return { exists: false };
  }
}

/** 仅供测试：关闭并重置连接（换 home / 删库后重新打开） */
export function resetCacheConnection(): void {
  try {
    databaseState?.db?.close();
  } catch {
    // 忽略
  }
  databaseState = null;
}
