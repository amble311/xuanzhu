import * as fs from "fs";
import * as path from "path";
import type { Quote } from "../exchange/ashare";
import type { PaperAccount } from "./paper";
import { monitorDir } from "./watchlist";

/**
 * A 股硬性风控（对齐 btc risk）：代码每轮检查，独立于 Agent。
 *
 * 触发后只做两件事：
 * 1. 写 `run/risk-state.json`，下一次巡检必须看到且禁止开新仓；
 * 2. `a_order` 拒绝买入，直到状态被重置/解除。
 *
 * 与 ATR 止损的区别：ATR 是单票价格规则；这里看账户级当日亏损、单票亏损、连亏。
 */

export interface RiskSettings {
  maxPositionLossPct: number;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
}

export interface RiskState {
  date: string;
  dayStartEquity?: number;
  triggered: boolean;
  reasons: string[];
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

export function readRiskState(): RiskState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as RiskState;
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
  triggered: boolean;
  reasons: string[];
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
  for (const position of account.positions) {
    const price = quotes.get(position.code)?.price ?? position.lastPrice;
    marketValue += price * position.qty;
    if (position.avgCost > 0) {
      const pct = ((price - position.avgCost) / position.avgCost) * 100;
      worstPositionPct = Math.min(worstPositionPct, pct);
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
  if (worstPositionPct <= -settings.maxPositionLossPct) {
    reasons.push(`单票亏损 ${worstPositionPct.toFixed(2)}% ≤ -${settings.maxPositionLossPct}%`);
  }
  if (consecutiveLosses >= settings.maxConsecutiveLosses) {
    reasons.push(`连续亏损 ${consecutiveLosses} 笔 ≥ ${settings.maxConsecutiveLosses}`);
  }
  return { triggered: reasons.length > 0, reasons, dailyLossPct, worstPositionPct, consecutiveLosses };
}

/** tick 每轮调用：日期切换重置；已触发则保持，不重复告警 */
export function checkAccountRisk(
  account: PaperAccount,
  quotes: Map<string, Quote>,
  now = new Date(),
): RiskEvaluation {
  const settings = readRiskSettings();
  const evaluation = evaluateAccountRisk(account, quotes, now, settings);
  const previous = readRiskState();
  const date = dayKey(now);
  const dayStartEquity =
    previous && previous.date === date && previous.dayStartEquity
      ? previous.dayStartEquity
      : account.cash +
        account.positions.reduce(
          (sum, position) => sum + (quotes.get(position.code)?.price ?? position.lastPrice) * position.qty,
          0,
        );

  const wasTriggered = previous?.date === date && previous.triggered;
  const state: RiskState = {
    date,
    dayStartEquity,
    triggered: wasTriggered || evaluation.triggered,
    reasons: wasTriggered && previous ? previous.reasons : evaluation.reasons,
    delivered: previous?.date === date ? previous.delivered : false,
    updatedAt: now.toISOString(),
  };
  writeRiskState(state);
  return {
    ...evaluation,
    triggered: state.triggered,
    reasons: state.reasons,
  };
}

/** 巡检成功处理后标记已送达，避免每轮重复注入 */
export function markRiskDelivered(): void {
  const state = readRiskState();
  if (!state) return;
  writeRiskState({ ...state, delivered: true, updatedAt: new Date().toISOString() });
}

/** 同日手动解除（巡检确认已减仓/风险消失时） */
export function clearRiskTrigger(): void {
  const state = readRiskState();
  if (!state) return;
  writeRiskState({
    ...state,
    triggered: false,
    reasons: [],
    delivered: true,
    updatedAt: new Date().toISOString(),
  });
}
