import * as fs from "fs";
import * as path from "path";
import { getAShareHome } from "../../utils/paths";

/**
 * A 股模块的磁盘缓存（`<XZH_A_HOME>/cache/*.json`）。
 *
 * 同花顺没有批量接口，股票池与板块清单只能扫描 + 缓存；交易日历也缓存。
 * 统一信封 `{ updatedAt, value }`，调用方只关心 TTL 与内容。
 */

export interface CacheEnvelope<T> {
  updatedAt: string;
  value: T;
}

export function ashareCachePath(name: string): string {
  return path.join(getAShareHome(), "cache", name);
}

export function readCache<T>(name: string, ttlMs: number): CacheEnvelope<T> | null {
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

export function writeCache<T>(name: string, value: T): CacheEnvelope<T> {
  const envelope: CacheEnvelope<T> = {
    updatedAt: new Date().toISOString(),
    value,
  };
  const target = ashareCachePath(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(envelope)}\n`, "utf8");
  return envelope;
}

/** 缓存文件的原始信息（不看 TTL，供 `xzh a status` 展示） */
export function statCache(name: string): { exists: boolean; updatedAt?: string; bytes?: number } {
  const target = ashareCachePath(name);
  try {
    const stat = fs.statSync(target);
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as CacheEnvelope<unknown>;
    return { exists: true, updatedAt: parsed.updatedAt, bytes: stat.size };
  } catch {
    return { exists: false };
  }
}
