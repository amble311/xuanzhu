import * as fs from "fs";
import * as path from "path";
import type { Quote } from "../exchange/ashare";
import type { PaperAccount } from "./paper";
import { monitorDir } from "./watchlist";

/**
 * A 股硬性风控（对齐 btc risk）：代码每轮检查，独立于 Agent。
 *
 * 分两层，**作用域必须分开**：
 * - **账户级**（当日亏损 / 连亏）：`triggered` → 禁止所有买入，只能减仓；
 * - **单票级**（某只票亏到上限）：`locks` → **只锁那一只**，其他股票照常开仓。
 *
 * 2026-11-13 修正：过去只有账户级一个 `triggered` 布尔，一只票 -8% 会让整个账户
 * 停手；现在单票只锁自己，账户级才全禁。卖出永远不受锁影响（风控不能拦止损）。
 */

export interface RiskSettings {
  maxPositionLossPct: number;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
}

/** 单票锁：只禁止该股票（及代码完全相同的）买入 */
export interface RiskLock {
  code: string;
  name: string;
  /** 人类可读的触发原因，如「单票亏损 -8.05% ≤ -8%」 */
  reason: string;
  /** 触发时的浮动盈亏（%，负数）；老状态可能没有 */
  pct?: number;
  at: string;
}

export interface RiskState {
  date: string;
  dayStartEquity?: number;
  /** 账户级：当日亏损 / 连亏，禁止**所有**买入 */
  triggered: boolean;
  /** 账户级原因（不含单票锁） */
  reasons: string[];
  /** 单票锁：只禁止这些股票买入 */
  locks: RiskLock[];
  delivered: boolean;
  updatedAt: string;
}

const SETTINGS_FILE = "risk.json";
const STATE_FILE = "run/risk-state.json";

export const DEFAULT_RISK: RiskSettings = {
  maxPositionLossPct: 8,
  maxDailyLossPct: 3,
  maxConsecutiveLosses: 3,
};

function settingsPath(): string {
  return path.join(monitorDir(), SETTINGS_FILE);
}

function statePath(): string {
  return path.join(monitorDir(), STATE_FILE);
}

export function readRiskSettings(): RiskSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Partial<RiskSettings>;
    return {
      maxPositionLossPct: Number(parsed.maxPositionLossPct) || DEFAULT_RISK.maxPositionLossPct,
      maxDailyLossPct: Number(parsed.maxDailyLossPct) || DEFAULT_RISK.maxDailyLossPct,
      maxConsecutiveLosses:
        Number(parsed.maxConsecutiveLosses) || DEFAULT_RISK.maxConsecutiveLosses,
    };
  } catch {
    return { ...DEFAULT_RISK };
  }
}

export function writeRiskSettings(settings: RiskSettings): void {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * 读状态并做一次归一化。
 *
 * 老格式只有 `triggered`，把「单票亏损」也记成了账户级。这里迁移：只有单票原因时
 * 先视为未触发（锁定代码未知，不能猜），下一轮 tick 会按实时持仓重新算出 `locks`。
 */
export function readRiskState(): RiskState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Partial<RiskState> & {
      reasons?: unknown;
      locks?: unknown;
    };
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((item): item is string => typeof item === "string")
      : [];
    const locks: RiskLock[] = Array.isArray(parsed.locks)
      ? parsed.locks.flatMap((item) => {
          const value = item as Partial<RiskLock>;
          if (typeof value?.code !== "string" || !/^\d{6}$/.test(value.code)) return [];
          return [
            {
              code: value.code,
              name: typeof value.name === "string" ? value.name : value.code,
              reason: typeof value.reason === "string" ? value.reason : "单票硬风控",
              pct: typeof value.pct === "number" ? value.pct : undefined,
              at: typeof value.at === "string" ? value.at : new Date(0).toISOString(),
            },
          ];
        })
      : [];
    const legacyPositionOnly =
      parsed.triggered === true &&
      locks.length === 0 &&
      reasons.length > 0 &&
      reasons.every((reason) => reason.startsWith("单票亏损"));
    return {
      date: typeof parsed.date === "string" ? parsed.date : "",
      dayStartEquity:
        typeof parsed.dayStartEquity === "number" ? parsed.dayStartEquity : undefined,
      triggered: parsed.triggered === true && !legacyPositionOnly,
      reasons: legacyPositionOnly ? [] : reasons,
      locks,
      delivered: parsed.delivered === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function writeRiskState(state: RiskState): void {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function dayKey(now: Date): string {
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
}

export interface RiskEvaluation {
  /** 账户级：当日亏损 / 连亏 → 禁止所有买入 */
  triggered: boolean;
  /** 账户级原因（不含单票锁） */
  reasons: string[];
  /** 本次评估发现的单票锁（只锁这些股票） */
  locks: RiskLock[];
  dailyLossPct: number;
  worstPositionPct: number;
  consecutiveLosses: number;
}

/** 账户级评估：当日回撤 / 单票亏损 / 连亏。纯计算，状态由调用方落盘 */
export function evaluateAccountRisk(
  account: PaperAccount,
  quotes: Map<string, Quote>,
  now = new Date(),
  settings = readRiskSettings(),
): RiskEvaluation {
  let marketValue = 0;
  let worstPositionPct = 0;
  const locks: RiskLock[] = [];
  for (const position of account.positions) {
    const price = quotes.get(position.code)?.price ?? position.lastPrice;
    marketValue += price * position.qty;
    if (position.avgCost > 0) {
      const pct = ((price - position.avgCost) / position.avgCost) * 100;
      worstPositionPct = Math.min(worstPositionPct, pct);
      if (pct <= -settings.maxPositionLossPct) {
        locks.push({
          code: position.code,
          name: position.name || position.code,
          reason: `单票亏损 ${pct.toFixed(2)}% ≤ -${settings.maxPositionLossPct}%`,
          pct,
          at: now.toISOString(),
        });
      }
    }
  }
  const equity = account.cash + marketValue;
  const previous = readRiskState();
  const date = dayKey(now);
  const dayStartEquity =
    previous && previous.date === date && previous.dayStartEquity
      ? previous.dayStartEquity
      : equity;
  const dailyLossPct = dayStartEquity > 0 ? ((equity - dayStartEquity) / dayStartEquity) * 100 : 0;

  const sells = account.trades.filter((trade) => trade.side === "sell" && typeof trade.pnl === "number");
  let consecutiveLosses = 0;
  for (let index = sells.length - 1; index >= 0; index -= 1) {
    if ((sells[index].pnl ?? 0) < 0) consecutiveLosses += 1;
    else break;
  }

  const reasons: string[] = [];
  if (dailyLossPct <= -settings.maxDailyLossPct) {
    reasons.push(`当日亏损 ${dailyLossPct.toFixed(2)}% ≤ -${settings.maxDailyLossPct}%`);
  }
  if (consecutiveLosses >= settings.maxConsecutiveLosses) {
    reasons.push(`连续亏损 ${consecutiveLosses} 笔 ≥ ${settings.maxConsecutiveLosses}`);
  }
  return {
    triggered: reasons.length > 0,
    reasons,
    locks,
    dailyLossPct,
    worstPositionPct,
    consecutiveLosses,
  };
}

/** 同日合并锁：已有锁保留首次触发时间，新锁补进来（退出后不再重复告警） */
function mergeLocks(previous: RiskLock[], current: RiskLock[]): RiskLock[] {
  const merged = new Map<string, RiskLock>();
  for (const lock of previous) merged.set(lock.code, lock);
  for (const lock of current) {
    const existing = merged.get(lock.code);
    merged.set(
      lock.code,
      existing
        ? { ...lock, at: existing.at, reason: existing.reason, pct: lock.pct ?? existing.pct }
        : lock,
    );
  }
  return [...merged.values()];
}

function lockText(lock: RiskLock): string {
  return `${lock.code} ${lock.name} ${lock.reason}`;
}

/** tick 每轮调用：日期切换重置；账户级已触发则保持，单票锁按代码累积 */
export function checkAccountRisk(
  account: PaperAccount,
  quotes: Map<string, Quote>,
  now = new Date(),
): RiskEvaluation {
  const evaluation = evaluateAccountRisk(account, quotes, now, readRiskSettings());
  const previous = readRiskState();
  const date = dayKey(now);
  const sameDay = previous?.date === date;
  const previousLocks = sameDay ? previous.locks : [];
  const locks = mergeLocks(previousLocks, evaluation.locks);
  const newLock = locks.some(
    (lock) => !previousLocks.some((item) => item.code === lock.code),
  );
  const equity =
    account.cash +
    account.positions.reduce(
      (sum, position) =>
        sum + (quotes.get(position.code)?.price ?? position.lastPrice) * position.qty,
      0,
    );
  const accountTriggered = (sameDay && previous?.triggered === true) || evaluation.triggered;
  const reasons = accountTriggered
    ? sameDay && previous?.triggered
      ? previous.reasons
      : evaluation.reasons
    : [];

  const state: RiskState = {
    date,
    dayStartEquity: sameDay && previous?.dayStartEquity ? previous.dayStartEquity : equity,
    triggered: accountTriggered,
    reasons,
    locks,
    // 出现新的单票锁时重新告警一次，否则沿用当日已送达标记
    delivered: newLock ? false : sameDay ? previous.delivered : false,
    updatedAt: now.toISOString(),
  };
  writeRiskState(state);
  return {
    ...evaluation,
    triggered: state.triggered,
    reasons: state.reasons,
    locks: state.locks,
  };
}

/** 巡检成功处理后标记已送达，避免每轮重复注入 */
export function markRiskDelivered(): void {
  const state = readRiskState();
  if (!state) return;
  writeRiskState({ ...state, delivered: true, updatedAt: new Date().toISOString() });
}

/**
 * 解除硬风控。
 *
 * - `clearRiskTrigger(code)`：只解除该股票的单票锁，其他股票 / 账户级不受影响；
 * - 不传 code：账户级 + 全部单票锁一起解除（等价旧版 `fk reset`）。
 *
 * @returns 实际解除的锁数量（账户级解除按 1 计）
 */
export function clearRiskTrigger(code?: string): number {
  const state = readRiskState();
  if (!state) return 0;
  if (code) {
    const locks = state.locks.filter((lock) => lock.code !== code);
    if (locks.length === state.locks.length) return 0;
    writeRiskState({
      ...state,
      locks,
      delivered: true,
      updatedAt: new Date().toISOString(),
    });
    return state.locks.length - locks.length;
  }
  const had = (state.triggered ? 1 : 0) + state.locks.length;
  writeRiskState({
    ...state,
    triggered: false,
    reasons: [],
    locks: [],
    delivered: true,
    updatedAt: new Date().toISOString(),
  });
  return had;
}

/**
 * 买入前的硬性闸门（`a_order` 与挂单撮合共用）。
 *
 * @returns 不允许买入的原因；`null` 表示可以买
 */
export function buyBlockReason(
  code: string,
  state: RiskState | null = readRiskState(),
): string | null {
  if (!state) return null;
  if (state.triggered) {
    return `账户级硬风控已触发，禁止所有买入：${state.reasons.join("；")}`;
  }
  const lock = state.locks.find((item) => item.code === code);
  if (lock) {
    return `单票硬风控：${lock.code} ${lock.name} ${lock.reason}。只锁这一只，其他股票可以正常操作`;
  }
  return null;
}

/** 一行摘要（面板 / status 用）：账户级 + 单票锁 */
export function riskSummaryLines(state = readRiskState()): string[] {
  if (!state) return ["正常"];
  const lines: string[] = [];
  if (state.triggered) lines.push(`账户级禁止买入（${state.reasons.join("；")}）`);
  for (const lock of state.locks) lines.push(`单票锁定 ${lockText(lock)}`);
  return lines.length > 0 ? lines : ["正常"];
}
