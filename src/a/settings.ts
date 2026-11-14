import * as fs from "fs";
import * as path from "path";
import { ensureDir, getAShareHome } from "../utils/paths";

/**
 * A 股的两个「数量」参数（`~/.xzh_a/settings.json`）：
 *
 * - `maxPositions`：**同时持仓的股票只数上限**（同一只加仓不算新开仓）；
 * - `poolSize`：**自选池容量**（巡检轮询与选股的对象数，含持仓）。
 *
 * 为什么要可配置：不同资金量、不同盯盘精力的人对「分散几只」的答案不一样；
 * 制度性约束（T+1、涨跌停、连续竞价）不可配，**数量**可以配。
 *
 * 两者的关系是硬约束：池子必须装得下持仓上限（`poolSize >= maxPositions`），
 * 否则会出现「允许持 5 只、但池子只有 3 只」这种自相矛盾的配置 —— 读取时自动收敛。
 */

export const DEFAULT_MAX_POSITIONS = 3;
export const DEFAULT_POOL_SIZE = 5;
/** 参数上限：再多就不是「盯得住」而是撒网了，且工具上下文会被撑爆 */
export const MAX_POSITIONS_LIMIT = 10;
export const POOL_SIZE_LIMIT = 20;

export interface ASettings {
  maxPositions: number;
  poolSize: number;
}

export function settingsPath(home = getAShareHome()): string {
  return path.join(home, "settings.json");
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 读配置（缺文件 / 坏 JSON / 越界值都退回默认；`poolSize >= maxPositions` 强制成立） */
export function readSettings(home = getAShareHome()): ASettings {
  let raw: Partial<ASettings> = {};
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(home), "utf8")) as Partial<ASettings>;
  } catch {
    // 没配置过 = 全默认
  }
  const poolSize = clampInt(raw.poolSize, 1, POOL_SIZE_LIMIT, DEFAULT_POOL_SIZE);
  const maxPositions = Math.min(
    clampInt(raw.maxPositions, 1, MAX_POSITIONS_LIMIT, DEFAULT_MAX_POSITIONS),
    poolSize,
  );
  return { maxPositions, poolSize };
}

export function writeSettings(patch: Partial<ASettings>, home = getAShareHome()): ASettings {
  const current = readSettings(home);
  const poolSize = clampInt(patch.poolSize ?? current.poolSize, 1, POOL_SIZE_LIMIT, current.poolSize);
  const maxPositions = Math.min(
    clampInt(patch.maxPositions ?? current.maxPositions, 1, MAX_POSITIONS_LIMIT, current.maxPositions),
    poolSize,
  );
  const next: ASettings = { maxPositions, poolSize };
  const file = settingsPath(home);
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return next;
}

/** 当前持仓只数上限（下单闸门 / 提示词 / 面板共用） */
export function maxPositions(): number {
  return readSettings().maxPositions;
}

/** 当前自选池容量（选股 / 轮询 / 面板共用） */
export function poolSize(): number {
  return readSettings().poolSize;
}
