import * as fs from "fs";
import * as path from "path";
import { getBtcHome } from "../utils/paths";

/**
 * 硬性风控（用户设定，代码执行）。
 *
 * 和「agent 级风控」的分工：
 * - **硬性**（这里）：用户用 `xzh btc fk` 设的阈值，由代码检查，触发就**必须**停手；
 * - **agent 级**：由 `btc_policy` 里用户给的策略 + 模型自己的判断决定，属于软约束。
 *
 * 触发之后不只是「停下来」：还要**告知后台**（`risk-state.json` 的 `delivered` 标记），
 * 让下一轮巡检带着「风控已触发、重新评估策略」的上下文跑，而不是继续按老节奏开仓。
 */

export interface HardRiskSettings {
  version: 1;
  /** 单个持仓亏损达到该百分比 → 触发（相对保证金收益率） */
  maxPositionLossPct: number;
  /** 当日权益亏损达到该百分比 → 触发 */
  maxDailyLossPct: number;
  /** 连续亏损达到该次数 → 触发 */
  maxConsecutiveLosses: number;
  /** 触发后挂起交易：巡检照常跑（要它重估策略），但不允许开新仓 */
  haltTradingOnTrigger: boolean;
}

/** 用户要求：默认「持仓亏损 50%」触发 */
export const DEFAULT_HARD_RISK: HardRiskSettings = {
  version: 1,
  maxPositionLossPct: 50,
  maxDailyLossPct: 10,
  maxConsecutiveLosses: 3,
  haltTradingOnTrigger: true,
};

export interface HardRiskState {
  triggered: boolean;
  /** 触发时间（ISO） */
  at?: string;
  /** 触发原因（人可读） */
  reason?: string;
  /** 触发时的关键数据（如「BTCUSDT 亏损 -52%」） */
  detail?: string;
  /** 后台是否已经知道（false = 下一轮巡检要带着它跑） */
  delivered?: boolean;
}

export function riskSettingsPath(home = getBtcHome()): string {
  return path.join(home, "risk.json");
}

export function riskStatePath(home = getBtcHome()): string {
  return path.join(home, "run", "risk-state.json");
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readRiskSettings(home = getBtcHome()): HardRiskSettings {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(riskSettingsPath(home), "utf8"),
    ) as Partial<HardRiskSettings>;
    // 逐项兜底：手改坏了不该让风控整体失效（缺失项回到默认，而不是「不设限」）
    return {
      version: 1,
      maxPositionLossPct: clampPct(
        parsed.maxPositionLossPct,
        DEFAULT_HARD_RISK.maxPositionLossPct,
      ),
      maxDailyLossPct: clampPct(
        parsed.maxDailyLossPct,
        DEFAULT_HARD_RISK.maxDailyLossPct,
      ),
      maxConsecutiveLosses: clampCount(
        parsed.maxConsecutiveLosses,
        DEFAULT_HARD_RISK.maxConsecutiveLosses,
      ),
      haltTradingOnTrigger:
        parsed.haltTradingOnTrigger ?? DEFAULT_HARD_RISK.haltTradingOnTrigger,
    };
  } catch {
    return { ...DEFAULT_HARD_RISK };
  }
}

export function writeRiskSettings(
  home: string,
  settings: HardRiskSettings,
): void {
  writeJson(riskSettingsPath(home), settings);
}

/** 百分比限制在 1–100：0 等于「不设限」，负数没有意义 */
function clampPct(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(100, Math.round(parsed * 100) / 100);
}

function clampCount(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(100, Math.round(parsed));
}

export function readRiskState(home = getBtcHome()): HardRiskState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(riskStatePath(home), "utf8"),
    ) as HardRiskState;
    // 先展开再强制布尔：文件里被手改成 "yes" 之类的值也按「已触发」处理才安全
    return { ...parsed, triggered: parsed.triggered === true };
  } catch {
    return { triggered: false };
  }
}

/** 触发硬性风控（幂等：已触发时只更新原因，不刷新「未告知」标记） */
export function triggerHardRisk(
  home: string,
  reason: string,
  detail?: string,
): HardRiskState {
  const current = readRiskState(home);
  const next: HardRiskState = {
    triggered: true,
    at: current.triggered ? current.at : new Date().toISOString(),
    reason,
    detail,
    delivered: current.triggered ? current.delivered : false,
  };
  writeJson(riskStatePath(home), next);
  return next;
}

/** 用户手动解除（`xzh btc fk` 里的「解除触发」） */
export function clearHardRisk(home = getBtcHome()): HardRiskState {
  const next: HardRiskState = { triggered: false };
  writeJson(riskStatePath(home), next);
  return next;
}

/** 后台已经带着这个告警跑过一轮巡检 */
export function markRiskDelivered(home = getBtcHome()): void {
  const current = readRiskState(home);
  if (!current.triggered) return;
  writeJson(riskStatePath(home), { ...current, delivered: true });
}

/** 一行摘要，供面板 / status 展示 */
export function riskSummary(
  settings: HardRiskSettings,
  state: HardRiskState,
): string {
  const base =
    `持仓亏损 ${settings.maxPositionLossPct}% · 当日亏损 ${settings.maxDailyLossPct}% · ` +
    `连亏 ${settings.maxConsecutiveLosses} 次`;
  return state.triggered ? `已触发（${state.reason ?? "原因未知"}）` : `正常（${base}）`;
}

/**
 * 检查账户快照是否触碰硬性风控。
 *
 * 只做**持仓浮亏**这一项：当日亏损与连亏需要权益曲线/成交历史，属于下一步
 * （有下单工具、有成交记录之后才算得准），现在硬编一个假数字反而更危险。
 */
export interface HardRiskInput {
  /** 最严重的单持仓亏损（无持仓为 null） */
  positionLoss: { symbol: string; lossPct: number } | null;
  /** 当前连续亏损次数（从平仓账本统计） */
  consecutiveLosses?: number;
  /** 当日权益亏损百分比（正数 = 亏了多少） */
  dailyLossPct?: number;
}

/**
 * 检查是否触碰硬性风控。
 *
 * 三个条件**都**要判：只有持仓亏损判过的版本里，
 * 「当日亏 15%、连亏 5 次」这种慢性放血完全不会触发 —— 而那才是最常见的爆仓方式。
 * 判定顺序按「影响面」：当日 > 单持仓 > 连亏（同时命中时取最严重的那个作为理由）。
 */
export function checkHardRisk(
  settings: HardRiskSettings,
  input: HardRiskInput,
): { triggered: boolean; reason?: string; detail?: string } {
  if (
    input.dailyLossPct !== undefined &&
    input.dailyLossPct >= settings.maxDailyLossPct
  ) {
    return {
      triggered: true,
      reason: `当日亏损超过 ${settings.maxDailyLossPct}%`,
      detail: `当日权益回撤 ${input.dailyLossPct.toFixed(2)}%`,
    };
  }

  const positionLoss = input.positionLoss;
  if (positionLoss && positionLoss.lossPct >= settings.maxPositionLossPct) {
    return {
      triggered: true,
      reason: `持仓亏损超过 ${settings.maxPositionLossPct}%`,
      detail: `${positionLoss.symbol} 亏损 ${positionLoss.lossPct.toFixed(1)}%`,
    };
  }

  if (
    input.consecutiveLosses !== undefined &&
    input.consecutiveLosses >= settings.maxConsecutiveLosses
  ) {
    return {
      triggered: true,
      reason: `连续亏损 ${input.consecutiveLosses} 次（阈值 ${settings.maxConsecutiveLosses}）`,
      detail: "先停手复盘，不要急着把亏损扳回来",
    };
  }

  return { triggered: false };
}
