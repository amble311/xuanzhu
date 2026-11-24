import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  continuousSession,
  fetchBars,
  fetchQuote,
  loadTradingCalendar,
  mapLimit,
  tradingDayStatus,
  type Bar,
  type Quote,
} from "../exchange/ashare";
import {
  accountSummary,
  loadPaperAccount,
  markPaperAccount,
  markPartialTaken,
  placePaperOrder,
  type PaperAccount,
} from "./paper";
import {
  commitRuleHit,
  describeRule,
  evaluateRules,
  readRules,
  ruleNeedsBars15m,
} from "./rules";
import {
  nextScheduledEntry,
  normalizeScheduleTimes,
  readScheduleQueue,
  takeDueSchedule,
} from "./schedule";
import { isPaused, readPause } from "./pause";
import { takeMarketEvent } from "./events";
import { cancelOrder, describeOrder, listOrders, matchOrders, type PendingOrder } from "./orders";
import {
  buyBlockReason,
  checkAccountRisk,
  markRiskDelivered,
  readRiskState,
} from "./risk";
import {
  markPositionRisksDelivered,
  readPositionRisks,
  writePositionRisks,
  type PositionRiskAlert,
} from "./risk-alerts";
import { intradayWeak } from "./intraday";
import { loadIndicators } from "./indicators";
import { scoreHeldItems, selectionNeed, selectTopWatchlist } from "./score";
import {
  loadWatchlist,
  mergeWatchlist,
  monitorDir,
  saveWatchlist,
  type WatchItem,
} from "./watchlist";
import { poolSize } from "./settings";
import { inWorkWindow, WORK_WINDOW_LABEL } from "./window";
import { describeTradingDay, todayTradingStatus } from "./trading-day";
import { ensureDir, getAShareHome } from "../utils/paths";
import {
  closedSince,
  liquidationNote,
  readBaseline,
  sameCodes,
  writeBaseline,
} from "../utils/position-baseline";
import { VERSION } from "../utils/version";

/**
 * A 股独立后台服务（`xzh a start` 拉起）—— 巡检只是其中一部分。
 *
 * 一个进程同时负责：
 * - 每分钟 tick：监控规则、挂单撮合（仅连续竞价）、持仓风控检测；
 * - 到排期时跑完整巡检（`a_schedule` 决定下一轮；失败 15 分钟退避、模型漏排期由巡检结尾 30 分钟兜底）；
 * - 收盘后 16:00 固定选股（只更新自选池）。
 *
 * 与 btc 的差别：A 股只有 4 小时交易、T+1、只能做多，因此不跑 24/7，非交易时段休眠。
 * 决策是**确定性规则**：月/周/日趋势 + **15 分钟**择时打分（分析周期与巡检一致），
 * 风控告警只叫醒、不自动交易 —— 卖不卖由巡检 Agent 决定。
 */

/** 初始止损下限 5%，并按 1.5×ATR 放大 */
const MIN_STOP_PCT = 0.05;
const STOP_ATR_MULTIPLE = 1.5;
/** 浮盈超过 8% 后启动移动止盈 */
const TRAIL_TRIGGER_PCT = 0.08;
/** 浮盈 12% 时卖出一半，剩余继续移动止盈 */
const PARTIAL_TAKE_PCT = 0.12;
/**
 * tick 间隔：**与 btc moni 一致，60 秒**。
 *
 * 以前是 30 秒。A 股行情源本身就是分钟级推送，30 秒内的第二次查询通常拿到同一笔成交价，
 * 而每 tick 要拉持仓行情 + 跑规则 + 跑撮合，等于把请求量白白翻倍。
 */
const TICK_MS = 60_000;
/** 监控规则评估节流（对齐 btc 的 `TRIGGER_EVAL_INTERVAL_MS`） */
const RULE_EVAL_INTERVAL_MS = 5 * 60_000;
/** 挂单时效叫醒节流（对齐 btc 的 `ORDER_TTL_CHECK_INTERVAL_MS`） */
const ORDER_TTL_INTERVAL_MS = 5 * 60_000;
/** 行情健康探测节流（对齐 btc 的 `MARKET_HEALTH_INTERVAL_MS`） */
const MARKET_HEALTH_INTERVAL_MS = 5 * 60_000;
/** 数据同步间隔（对齐 btc 的 `DEFAULT_SYNC_INTERVAL_MIN = 15`） */
const SYNC_INTERVAL_MS = 15 * 60_000;
/** 排期队列为空时的兜底巡检间隔（对齐 btc 的 `DEFAULT_CHECK_MINUTES = 60`） */
const FALLBACK_CHECK_MS = 60 * 60_000;
/** 监控叫醒限流：10 分钟内最多 2 次（btc `monitorWakeAllowed` 同款） */
const WAKE_WINDOW_MS = 10 * 60_000;
const WAKE_LIMIT = 2;
/** 行情健康探测用的标的：上证指数（单只票停牌不该被当成「行情源挂了」） */
const MARKET_PROBE_CODE = "1A0001";
/** 连续几次探测失败才叫醒（btc 同款：连续两次） */
const MARKET_FAILURE_THRESHOLD = 2;
/** 拉持仓行情的并发（行情源限频，btc 侧也是 3–6） */
const QUOTE_CONCURRENCY = 6;

/**
 * 各阶段间隔（导出给测试用：**必须与 btc moni 保持一致**）。
 *
 * 这些值不是随便挑的 —— btc 那边有同样的常量，改一边不改另一边就会出现
 * 「A 股 30 秒、btc 60 秒」这种口径漂移（之前文档写 60 秒、代码是 30 秒，就是这么来的）。
 */
export const A_MONITOR_INTERVALS = {
  /** tick 间隔（btc `TICK_MS`） */
  tickMs: TICK_MS,
  /** 监控规则评估（btc `TRIGGER_EVAL_INTERVAL_MS`） */
  ruleMs: RULE_EVAL_INTERVAL_MS,
  /** 挂单时效叫醒（btc `ORDER_TTL_CHECK_INTERVAL_MS`） */
  orderTtlMs: ORDER_TTL_INTERVAL_MS,
  /** 行情健康探测（btc `MARKET_HEALTH_INTERVAL_MS`） */
  marketHealthMs: MARKET_HEALTH_INTERVAL_MS,
  /** 数据同步（btc `DEFAULT_SYNC_INTERVAL_MIN`） */
  syncMs: SYNC_INTERVAL_MS,
  /** 队列空兜底（btc `DEFAULT_CHECK_MINUTES`） */
  fallbackMs: FALLBACK_CHECK_MS,
  /** 监控叫醒窗口与次数上限（btc `monitorWakeAllowed`） */
  wakeWindowMs: WAKE_WINDOW_MS,
  wakeLimit: WAKE_LIMIT,
} as const;
/** 清仓检测用的持仓基线文件名（<home>/monitor/run/<name>.json） */
const POSITION_BASELINE = "positions-baseline";
const LOCK_FILE = "run/monitor.lock";
const STATE_FILE = "run/monitor.json";
const ACTIONS_FILE = "actions.jsonl";

export interface AMonitorState {
  pid: number;
  startedAt: string;
  updatedAt: string;
  version: string;
  nextRunAt: string;
  lastRunAt?: string;
  /** 最近一次全市场选股的日期 */
  lastSelectDay?: string;
  watchlist: number;
  holdings: number;
  lastAction?: string;
  lastError?: string;
  /** 暂停标记（进程仍在） */
  paused?: boolean;
  /** 排期队列长度 / 下一条 */
  queueSize?: number;
  nextCheckAt?: string;
  nextCheckReason?: string;
  /** 监控规则条数 */
  rules?: number;
  /** 最近一次巡检 */
  lastInspectAt?: string;
  lastInspectReason?: string;
  lastInspectSummary?: string;
  lastInspectTools?: number;
  /** 收盘后固定选股：最近一次尝试（防止失败后每 60 秒重试） */
  lastSelectAttemptAt?: string;
}

export interface CycleResult {
  actions: string[];
  sold: string[];
  bought: string[];
  selected: string[];
}

function statePath(): string {
  return path.join(monitorDir(), STATE_FILE);
}

/**
 * 「今天已经选过股」的标记（独立小文件）。
 *
 * 为什么不能只放 `monitor.json`：`xzh a stop` 会把它删掉，下次 `start` 写的是全新状态，
 * `lastSelectDay` 变空 —— 收盘后再重启（比如 18:41 升级完服务）就会把 16:00 的选股
 * 重跑一遍（全市场快照 + 5000+ 只日线指标重算）。这份标记必须活过停服。
 */
interface SelectState {
  /** 最近一次成功选股的日期（本地 YYYY-MM-DD） */
  day?: string;
  /** 最近一次尝试（成功或失败）的时间 */
  attemptedAt?: string;
}

function selectStatePath(): string {
  return path.join(monitorDir(), "run", "select-state.json");
}

function readSelectState(): SelectState {
  try {
    const parsed = JSON.parse(fs.readFileSync(selectStatePath(), "utf8")) as SelectState;
    return {
      day: typeof parsed?.day === "string" ? parsed.day : undefined,
      attemptedAt: typeof parsed?.attemptedAt === "string" ? parsed.attemptedAt : undefined,
    };
  } catch {
    return {};
  }
}

function writeSelectState(next: SelectState): void {
  const file = selectStatePath();
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    // 标记写不进去最多重跑一次选股，不该让巡检退出
  }
}

function lockPath(): string {
  return path.join(monitorDir(), LOCK_FILE);
}

export function monitorLogPath(): string {
  return path.join(monitorDir(), "logs", "monitor.log");
}

function actionsPath(): string {
  return path.join(monitorDir(), ACTIONS_FILE);
}

/** 巡检动作账本路径（gateway 转发微信用） */
export function aActionsPath(): string {
  return actionsPath();
}

function iso(now: Date): string {
  return now.toISOString();
}

function dayKey(now: Date): string {
  return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
}

export function readAMonitorState(): AMonitorState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8")) as AMonitorState;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(state: AMonitorState): void {
  ensureDir(path.dirname(statePath()));
  const tmp = `${statePath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, statePath());
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function appendAAction(entry: Record<string, unknown>): void {
  try {
    ensureDir(monitorDir());
    fs.appendFileSync(actionsPath(), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    // 日志写不了不影响巡检
  }
}

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  process.stdout.write(`${line}\n`);
  try {
    ensureDir(path.dirname(monitorLogPath()));
    fs.appendFileSync(monitorLogPath(), `${line}\n`, "utf8");
  } catch {
    // 忽略
  }
}

/**
 * 工作窗口：**正常交易时段**（工作日 09:30–11:30 / 13:00–15:00，定义在 `window.ts`）。
 *
 * 为什么严格限制在交易时段：集合竞价（09:15–09:30）、午休（11:30–13:00）与 15:00 之后
 * 都没有连续成交，拿到的价格是竞价参考价 / 上午收盘价 / 当日收盘价。
 * 巡检在这些时刻开跑，等于用冻结价格判断 15 分钟择时，方向必然失真。
 *
 * 这是**进程的工作时间**，只决定「要不要拉数据 / 跑巡检 / 消费排期」；
 * **不能当撮合闸门** —— 撮合与成交必须用 `continuousSession()`
 * （同两个时段，且还要当天是交易日）。
 */
export function inTradingWindow(now = new Date()): boolean {
  return inWorkWindow(now);
}

function quoteMap(quotes: Array<Quote | null>): Map<string, Quote> {
  const map = new Map<string, Quote>();
  for (const quote of quotes) if (quote) map.set(quote.code, quote);
  return map;
}

function equityOf(account: PaperAccount, quotes: Map<string, Quote>): number {
  const marketValue = account.positions.reduce((sum, position) => {
    const price = quotes.get(position.code)?.price ?? position.lastPrice;
    return sum + price * position.qty;
  }, 0);
  return account.cash + marketValue;
}

export interface SellDecision {
  reason: string;
  /** T+1 当日买入为 false：风控照样触发，但今天不能卖 */
  sellable: boolean;
  /** 分批止盈时只卖这么多；不传 = 全部可卖数量 */
  qty?: number;
  /** 是否是 +12% 的分批止盈（卖完要记标记，避免反复卖一半） */
  partial?: boolean;
}

/**
 * 风控判定：**不因 T+1 而跳过**，止损按波动率（ATR）计算。
 *
 * - 初始止损：max(5%, 1.5 × ATR20%)；
 * - 浮盈 ≥8% 后转为移动止盈：止损线跟随持仓期最高价回撤 1.5×ATR；
 * - 浮盈 ≥12% 且尚未分批：先卖一半（落袋），剩余继续移动止盈；
 * - T+1 当日买入仍返回信号，只是 `sellable=false`，由调用方挂待卖。
 */
export function shouldSell(
  position: PaperAccount["positions"][number],
  quote: Quote,
  indicators?: { atr20?: number; close?: number },
): SellDecision | null {
  if (position.avgCost <= 0 || quote.price <= 0) return null;
  const atrPct =
    indicators?.atr20 && indicators.close && indicators.close > 0
      ? (indicators.atr20 / indicators.close) * 100
      : 3.5;
  const stopPct = Math.max(MIN_STOP_PCT, (STOP_ATR_MULTIPLE * atrPct) / 100);
  const peak = Math.max(position.peakPrice ?? position.avgCost, quote.price);
  const pnlPct = ((quote.price - position.avgCost) / position.avgCost) * 100;
  const peakPct = ((peak - position.avgCost) / position.avgCost) * 100;

  // 分批止盈：只在当前仍有浮盈时执行，避免第二天回落还机械卖一半
  if (
    !position.tookPartial &&
    peakPct >= PARTIAL_TAKE_PCT * 100 &&
    pnlPct >= TRAIL_TRIGGER_PCT * 100 &&
    position.available >= 100
  ) {
    const half = Math.floor(position.qty / 2 / 100) * 100;
    if (half >= 100) {
      return {
        reason: `分批止盈（峰值 +${peakPct.toFixed(1)}%）`,
        sellable: true,
        qty: half,
        partial: true,
      };
    }
  }

  let stop = position.avgCost * (1 - stopPct);
  if (peakPct >= TRAIL_TRIGGER_PCT * 100) {
    // 移动止盈：从最高点回撤 1.5×ATR，且不低于初始止损
    stop = Math.max(stop, peak * (1 - stopPct));
  }

  if (quote.price <= stop) {
    const reason =
      stop >= position.avgCost
        ? `移动止盈（峰值 +${peakPct.toFixed(1)}%，回撤触发）`
        : `止损 ${pnlPct.toFixed(1)}%（ATR ${atrPct.toFixed(1)}%）`;
    return { reason, sellable: position.available > 0, qty: position.available };
  }
  return null;
}

// ─────────────────── T+1 锁定的待卖队列 ───────────────────

const PENDING_FILE = "run/pending-sells.json";

export interface PendingSell {
  code: string;
  name: string;
  reason: string;
  /** 首次触发的日期（用于面板提示“明日处理”） */
  since: string;
}

function pendingPath(): string {
  return path.join(monitorDir(), PENDING_FILE);
}

export function readPendingSells(): PendingSell[] {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingPath(), "utf8")) as PendingSell[];
    return Array.isArray(raw) ? raw.filter((item) => item && typeof item.code === "string") : [];
  } catch {
    return [];
  }
}

function writePendingSells(list: PendingSell[]): void {
  ensureDir(path.dirname(pendingPath()));
  const tmp = `${pendingPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, pendingPath());
}

/**
 * 一轮巡检。可被 `<MODE> serve` 调用，也可由 `xzh a monitor once` 手动触发。
 */
function cliEntry(): string {
  return process.argv[1] ?? path.join(__dirname, "cli.js");
}

function acquireLock(): boolean {
  ensureDir(path.dirname(lockPath()));
  try {
    const fd = fs.openSync(lockPath(), "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      const pid = Number(fs.readFileSync(lockPath(), "utf8").trim());
      if (pidAlive(pid)) return false;
      fs.rmSync(lockPath(), { force: true });
    } catch {
      // 锁文件损坏
    }
    try {
      const fd = fs.openSync(lockPath(), "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }
}

function releaseLock(): void {
  try {
    const pid = Number(fs.readFileSync(lockPath(), "utf8").trim());
    if (pid === process.pid) fs.rmSync(lockPath(), { force: true });
  } catch {
    // 忽略
  }
}


/**
 * 启动预热：**先拉数据，再开始监控**。
 *
 * - 交易日历：读 24h 缓存，缺失时拉一次上证指数日线（约 1 秒）；
 * - 全市场日线指标：36h 缓存，缺失时全市场重算（5000+ 只 × 140 根日线，1–2 分钟）。
 *
 * 为什么要放在第一次 tick 之前：`loadIndicators()` 会在调用处**同步**重算，
 * 放在 tick 里会把一轮巡检拖成分钟级，还可能顶到 6 分钟巡检超时。
 * 失败只记日志，不影响进程继续跑（后续 tick 会再按需拉）。
 */
async function warmupData(at: Date): Promise<void> {
  try {
    const calendar = await loadTradingCalendar();
    log(
      `交易日历就绪：${calendar.days.length} 个交易日（最近 ${calendar.days[calendar.days.length - 1]}）`,
    );
  } catch (err) {
    log(`交易日历加载失败，按工作日判断：${err instanceof Error ? err.message : String(err)}`);
  }
  // 非交易日（含节假日）不做全市场指标重算：5000+ 只 × 140 根日线要 1–2 分钟，
  // 而当天根本不会有新数据。
  const tradingDay = await todayTradingStatus(at).catch(() => null);
  if (!tradingDay?.tradingDay) {
    log(`今天不是交易日（${tradingDay ? describeTradingDay(tradingDay) : "日历不可用"}），跳过指标预热`);
    return;
  }
  const started = Date.now();
  log("预热日线指标（缓存缺失时全市场重算，约 1–2 分钟）…");
  try {
    const indicators = await loadIndicators({ allowPartial: true });
    log(
      `日线指标就绪：${indicators.size} 只（${Math.round((Date.now() - started) / 1000)}s）`,
    );
  } catch (err) {
    log(`日线指标预热失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runAServe(): Promise<void> {
  ensureDir(monitorDir());
  if (!acquireLock()) {
    process.stderr.write("A 股后台服务已在运行（锁被占用），本次退出。\n");
    process.exit(1);
  }

  const now = new Date();
  // 停服会删掉 monitor.json，但「今天已经选过股」必须活过重启：
  // 否则 16:00 之后重启（升级 / 崩溃恢复）会把收盘选股重跑一遍。
  const selectState = readSelectState();
  const state: AMonitorState = {
    pid: process.pid,
    startedAt: iso(now),
    updatedAt: iso(now),
    version: VERSION,
    nextRunAt: iso(now),
    watchlist: loadWatchlist().items.length,
    holdings: loadPaperAccount(now).positions.length,
    lastSelectDay: selectState.day,
    lastSelectAttemptAt: selectState.attemptedAt,
  };
  writeState(state);
  log(`A 股巡检启动 pid=${process.pid}，交易时段 ${WORK_WINDOW_LABEL} 巡检；收盘后 16:00 固定选股`);
  // 老版本允许午休 / 15:00 之后排期，启动时把它们顺延进交易时段，避免面板显示假时间
  const shifted = normalizeScheduleTimes(now);
  if (shifted > 0) log(`已把 ${shifted} 条越界排期顺延进交易时段`);

  // 先拉数据再监控：状态文件已写好（startAService 的 5 秒检查不受影响），
  // 这里把交易日历与日线指标准备好，避免第一轮 tick 同步重算全市场指标。
  state.lastAction = "预热数据（交易日历 / 日线指标）…";
  writeState(state);
  await warmupData(now);
  state.lastAction = undefined;
  writeState(state);

  let stopped = false;
  /** tick 级重入闸门：行情拉取 / 指标重算可能超过 30 秒的 tick 间隔 */
  let busy = false;
  let selecting = false;

  const refresh = (at: Date): void => {
    const pause = readPause();
    const queue = readScheduleQueue();
    const rules = readRules();
    const next = queue[0];
    state.updatedAt = iso(at);
    state.paused = pause.paused;
    state.queueSize = queue.length;
    state.nextCheckAt = next?.at;
    state.nextCheckReason = next?.reason;
    state.rules = rules.length;
    state.watchlist = loadWatchlist().items.length;
    state.holdings = loadPaperAccount(at).positions.length;
    state.nextRunAt = next?.at ?? iso(at);
    writeState(state);
  };

  /** 非交易日只记一次日志，避免每分钟刷屏 */
  let nonTradingLoggedFor = "";

  // ── 与 btc moni 对齐的节流状态（进程内存，重启清零无所谓）──
  let lastRuleEvalAt = 0;
  let lastOrderTtlAt = 0;
  let lastSyncAt = 0;
  let lastMarketHealthAt = 0;
  /** 行情连续失败次数 / 最近错误 / 是否已叫醒过 */
  let marketFailures = 0;
  let lastMarketError = "";
  /** 最近一次探测成功的时间（btc 的 `lastMarketOkAt`，写进 marketNote 便于排查） */
  let lastMarketOkAt: string | undefined;
  let marketAlerted = false;
  let wakeWindowAt = 0;
  let wakeCount = 0;

  /** 对齐 btc `monitorWakeAllowed()`：监控叫醒限流，10 分钟内最多 2 次 */
  const monitorWakeAllowed = (now: number): boolean => {
    if (now - wakeWindowAt > WAKE_WINDOW_MS) {
      wakeWindowAt = now;
      wakeCount = 0;
    }
    if (wakeCount >= WAKE_LIMIT) return false;
    wakeCount += 1;
    return true;
  };

  /**
   * 行情健康探测（对齐 btc 的 `checkMarketHealth`）。
   *
   * 拉不到行情时，任何「现在能不能买」的判断都建立在昨天的价格上；连续 2 次失败就立刻
   * 叫醒一轮排查，而不是等下一次排期（可能是几小时后）。探测用上证指数：
   * 单只股票停牌/退市不该被当成「行情源挂了」。
   */
  const checkMarketHealth = async (at: Date): Promise<void> => {
    const now = at.getTime();
    if (now - lastMarketHealthAt < MARKET_HEALTH_INTERVAL_MS) return;
    lastMarketHealthAt = now;
    try {
      await fetchQuote(MARKET_PROBE_CODE);
      if (marketFailures > 0) log(`行情已恢复（此前连续失败 ${marketFailures} 次）`);
      marketFailures = 0;
      lastMarketError = "";
      lastMarketOkAt = at.toISOString();
      marketAlerted = false;
    } catch (err) {
      marketFailures += 1;
      lastMarketError = err instanceof Error ? err.message : String(err);
      log(`行情探测失败（连续 ${marketFailures} 次）：${lastMarketError}`);
    }
  };

  /** 对齐 btc `shouldAlertMarket()`：连续失败到阈值、且本轮还没叫醒过 */
  const shouldAlertMarket = (): boolean =>
    marketFailures >= MARKET_FAILURE_THRESHOLD && !marketAlerted;

  /**
   * 数据同步（对齐 btc 的 `runSyncIfDue`，15 分钟一次）。
   *
   * A 股没有本地 K 线库，这里的「同步」是确保**日线指标缓存**没过期：
   * 过期时 `loadIndicators()` 会重算全市场（5000+ 只），宁可现在算完，
   * 也别在模型巡检中途卡两分钟。
   */
  const runSyncIfDue = async (at: Date): Promise<void> => {
    if (at.getTime() - lastSyncAt < SYNC_INTERVAL_MS) return;
    lastSyncAt = at.getTime();
    const started = Date.now();
    try {
      const indicators = await loadIndicators({ allowPartial: true });
      log(
        `数据同步：日线指标 ${indicators.size} 只（${Math.round((Date.now() - started) / 1000)}s）`,
      );
    } catch (err) {
      log(`数据同步失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 对齐 btc `runInspect()`：跑一轮并把结果写回状态 / 送达标记（所有叫醒路径共用） */
  const runInspectRound = async (
    reason: string,
    options: {
      triggerNote?: string;
      orderNote?: string;
      ruleHit?: Parameters<typeof commitRuleHit>[0];
      marketAlert?: boolean;
    } = {},
  ): Promise<void> => {
    // 风控告警只随巡检送一次（对齐 btc `runInspect()`：`riskAlert` 由本轮带走，成功才标记送达）。
    // tick 不再为风控单独叫醒 —— 空仓/无告警时靠规则与排期，避免「定时必须启动一轮」。
    const riskState = readRiskState();
    const riskTriggered = Boolean(riskState?.triggered);
    const positionAlerts = readPositionRisks().alerts.length;

    state.lastInspectReason = reason;
    log(`唤醒巡检：${reason}`);
    // 巡检实现（inspect）会间接拉起 Agent / 工具层；面板与状态查询只需要本模块的轻量部分，
    // 因此放到真正要巡检时才加载，避免 TUI 启动时为整套 A 股分析栈付内存。
    const { runAInspect } = await import("./inspect");
    const result = await runAInspect(reason, {
      origin: "inspect",
      triggerNote: options.triggerNote,
      orderNote: options.orderNote,
    });
    // 命中即消费的规则（`once`）只在巡检**成功**后落盘 ——
    // 失败时保留，否则「叫醒了但模型报错」会把一次性规则直接删掉（btc `if (ok) commit()` 同款）。
    if (!result.error) {
      if (options.ruleHit) commitRuleHit(options.ruleHit);
      if (riskTriggered) markRiskDelivered();
      if (positionAlerts > 0) markPositionRisksDelivered();
      if (options.marketAlert) marketAlerted = true;
    }
    state.lastInspectAt = iso(new Date());
    state.lastInspectSummary = result.summary;
    state.lastInspectTools = result.toolCalls;
    state.lastAction = result.summary;
    state.lastError = result.error;
    // 失败**不**写退避排期：与 btc 一致，队列留空由 60 分钟兜底接手；
    // 写一条 15 分钟排期反而会让「队列为空」不成立，兜底永远等不到。
  };

  // ── 阶段函数：命名与 btc moni 一一对应（`src/btc/daemon-main.ts` 里的同名函数）──
  // 原则：`cycle()` 只负责**按顺序调用**这些阶段并决定要不要叫醒，具体动作都在这里。

  /** 收盘后固定选股（A 股特有；与 btc 的同步一样「不交易也跑」），与 `handleMessage` 无关 */
  const runAfterCloseSelectionIfDue = async (at: Date): Promise<void> => {
    if (!shouldRunAfterCloseSelection(at, state.lastSelectDay, state.lastSelectAttemptAt)) return;
    if (selecting) return;
    selecting = true;
    try {
      const selected = await maybeRunAfterCloseSelection(at, state);
      if (selected) refresh(new Date());
    } finally {
      selecting = false;
    }
  };

  /**
   * 交易时段 + 交易日闸门（A 股特有；btc 7×24 没有这一层）。
   *
   * `inTradingWindow()` 只按星期 + 时间判断，节假日落在工作日时会误判成「可以巡检」，
   * 所以必须再用真实日历兜一道：非交易日不拉行情、不撮合、不叫模型。
   */
  const tradingGate = async (at: Date): Promise<boolean> => {
    if (!inTradingWindow(at)) return false;
    const tradingDay = await todayTradingStatus(at);
    if (tradingDay.tradingDay) return true;
    if (nonTradingLoggedFor !== tradingDay.today) {
      nonTradingLoggedFor = tradingDay.today;
      log(`今天不是交易日，跳过巡检与撮合：${describeTradingDay(tradingDay)}`);
    }
    return false;
  };

  /**
   * 对齐 btc `checkRisk()`：持仓行情 + 账户级 / 单票级硬风控 + 持仓风险告警。
   *
   * 只读 + 落盘，不自动交易；暂停时也照跑（用户可能手动开了仓，浮亏一样要监控）。
   */
  const checkRisk = async (
    at: Date,
  ): Promise<{
    account: PaperAccount;
    heldQuotes: Map<string, Quote>;
    accountRisk: ReturnType<typeof checkAccountRisk>;
    riskAlerts: ReturnType<typeof readPositionRisks>;
  }> => {
    const account = loadPaperAccount(at);
    const heldQuotes = quoteMap(
      await mapLimit(
        account.positions.map((position) => position.code),
        async (code) => fetchQuote(code).catch(() => null),
        QUOTE_CONCURRENCY,
      ),
    );
    const accountRisk = checkAccountRisk(account, heldQuotes, at);
    await detectPositionRisks(at, heldQuotes);
    return { account, heldQuotes, accountRisk, riskAlerts: readPositionRisks() };
  };

  /**
   * 对齐 btc 的「读账本即撮合」。
   *
   * btc moni 没有独立的撮合函数：撮合是 Python `paper.status()` 里的 `try_fill()` 副作用，
   * daemon 每 tick 读一次 `paper-status` 就等于每 tick 撮合一次。A 股账本是纯读的，
   * 所以这里显式调 `processPendingOrders()`，语义仍是「读账本 = 账本回到当前状态」。
   */
  const matchPendingOrders = async (
    at: Date,
  ): Promise<{ actions: string[]; expired: PendingOrder[] }> => {
    const session = await continuousSession(at);
    const pending = await processPendingOrders(at, session.open);
    if (pending.actions.length > 0) {
      state.lastAction = pending.actions[0];
      log(pending.actions.join("；"));
    }
    return pending;
  };

  /** 对齐 btc `checkEvents(hasExposure)`：到点的市场事件（优先级高于挂单 / 规则 / 排期） */
  const checkEvents = (at: Date, hasExposure: boolean) =>
    takeMarketEvent(at, { hasExposure });

  /**
   * 对齐 btc `checkOrderTtl()`：挂单超时未成交 → 叫醒模型决定撤单 / 改价 / 继续等。
   *
   * 过期单本身在撮合阶段已经处理掉，这里只做「要不要叫醒」的 5 分钟节流。
   */
  const checkOrderTtl = (now: number, expired: PendingOrder[]): PendingOrder[] => {
    if (expired.length === 0 || now - lastOrderTtlAt < ORDER_TTL_INTERVAL_MS) return [];
    lastOrderTtlAt = now;
    return expired;
  };

  /** 对齐 btc `checkTriggers()`：监控规则 5 分钟节流，命中就返回规则 */
  const checkTriggers = async (
    now: number,
    at: Date,
    heldQuotes: Map<string, Quote>,
  ): Promise<Awaited<ReturnType<typeof checkMonitorRules>>> => {
    if (now - lastRuleEvalAt < RULE_EVAL_INTERVAL_MS) return null;
    lastRuleEvalAt = now;
    return checkMonitorRules(at, heldQuotes);
  };

  /**
   * 清仓检测：与上一轮持仓基线对比，**消失的代码 = 已清仓**。
   *
   * 为什么对比持仓而不是解析成交：模型下单（`a_order`）、用户手动下单、挂单成交
   * 三条链路的写入位置各不相同（`paper.json` / `orders.json` / 撮合），
   * 「上一轮有、这一轮没有」才是唯一可靠的信号；基线落盘，进程重启也能接上。
   */
  const checkLiquidation = (at: Date): string[] => {
    const codes = loadPaperAccount(at)
      .positions.filter((position) => position.qty > 0)
      .map((position) => position.code);
    const previous = readBaseline(monitorDir(), POSITION_BASELINE);
    const closed = closedSince(previous, codes);
    if (!previous || !sameCodes(previous.codes, codes)) {
      writeBaseline(monitorDir(), codes, at, POSITION_BASELINE);
    }
    return closed;
  };

  /**
   * 对齐 btc 的兜底判断（`DEFAULT_CHECK_MINUTES = 60`）。
   *
   * 只有**队列里没有任何排期**、且距上次巡检已满 60 分钟才兜底 —— 模型排好期就不会多跑一轮。
   */
  const fallbackDue = (now: number): boolean => {
    if (nextScheduledEntry() !== null) return false;
    const lastInspect = state.lastInspectAt ? Date.parse(state.lastInspectAt) : 0;
    return lastInspect === 0 || now - lastInspect >= FALLBACK_CHECK_MS;
  };

  /**
   * 一轮完整判断：**只负责按顺序调用阶段函数**，结构与 btc moni 的 `tick()` 一致。
   *
   * 优先级（btc 同序）：行情故障 → 市场事件 → 挂单时效 → 监控规则 → 风控 → 排期 → 兜底；
   * 每命中一类就立刻跑一轮巡检并 return（不占排期队列）。
   */
  const cycle = async (): Promise<void> => {
    const at = new Date();
    const now = at.getTime();
    refresh(at);

    // 0) 收盘后固定选股（A 股特有；先于时段判断，因为 16:00 已收盘）
    await runAfterCloseSelectionIfDue(at);

    // 1) 交易时段 + 交易日闸门（A 股特有）
    if (!(await tradingGate(at))) return;

    // 2) 风控：与 btc `checkRisk()` 一样，暂停也检查（只落盘 + 告警，不单独叫醒）
    const { account, heldQuotes } = await checkRisk(at);

    // 3) 暂停：btc 在 `/stop` 下也只跑风控
    if (isPaused()) return;

    try {
      // 4) 数据同步（btc `runSyncIfDue()`，15 分钟）
      await runSyncIfDue(at);

      // 5) 撮合（btc 是 `paper-status` 里的 `try_fill()` 副作用，A 股显式调用）
      const pending = await matchPendingOrders(at);
      // 账本已变（成交 / 撤销），先把状态落盘再判断要不要叫醒（btc 每个阶段后都 refreshQueueState）
      refresh(new Date());

      // 5b) 清仓复盘：持仓归零 → 立刻叫醒一轮（复盘 + 写策略 + 记录），优先于其他触发
      const liquidated = checkLiquidation(at);
      if (liquidated.length > 0) {
        await runInspectRound(`清仓复盘：${liquidated.join("、")}`, {
          triggerNote: liquidationNote(liquidated, "a_policy"),
        });
        return;
      }

      // 6) 行情故障（btc `checkMarketHealth()` 只记状态 → `shouldAlertMarket()` 判定）
      await checkMarketHealth(at);
      if (shouldAlertMarket()) {
        if (!monitorWakeAllowed(now)) {
          log("行情故障叫醒已达 10 分钟上限，本轮跳过（下一轮再试）");
          return;
        }
        await runInspectRound(`行情获取连续失败 ${marketFailures} 次`, {
          triggerNote:
            `行情故障：连续 ${marketFailures} 次拉不到上证指数` +
            `（最近错误：${lastMarketError || "未知"}；` +
            `最后一次成功：${lastMarketOkAt ?? "启动以来没有成功过"}）`,
          marketAlert: true,
        });
        return;
      }

      // 7) 市场事件（btc `checkEvents(hasExposure)`，优先于挂单 / 规则 / 排期）
      // 空仓不靠定时事件叫醒：模型在巡检里用 `a_trigger` 设好条件，命中自然会唤醒。
      const hasExposure =
        account.positions.length > 0 || listOrders().some((order) => order.status === "open");
      const event = checkEvents(at, hasExposure);
      if (event) {
        await runInspectRound(event.reason, { triggerNote: `市场事件：${event.reason}` });
        return;
      }

      // 8) 挂单时效（btc `checkOrderTtl()`，5 分钟节流）
      const expired = checkOrderTtl(now, pending.expired);
      if (expired.length > 0) {
        if (!monitorWakeAllowed(now)) {
          log("挂单时效叫醒已达 10 分钟上限，本轮跳过（过期单仍在）");
          return;
        }
        const orderNote = expired
          .map(
            (order) =>
              `${describeOrder(order)} 已于 ${order.expiresAt} 过期（原因：${order.reason}）`,
          )
          .join("\n");
        await runInspectRound(`挂单过期：${expired.map((order) => order.code).join("、")}`, {
          orderNote,
        });
        return;
      }

      // 9) 监控规则（btc `checkTriggers()`，5 分钟节流）
      const hit = await checkTriggers(now, at, heldQuotes);
      if (hit) {
        if (!monitorWakeAllowed(now)) {
          log("规则叫醒已达 10 分钟上限，本轮跳过（条件保留，下一轮再试）");
          return;
        }
        await runInspectRound(hit.reason, {
          triggerNote: `${describeRule(hit.rule)}（${hit.reason}）`,
          ruleHit: hit.rule,
        });
        return;
      }

      // 10) 排期到期（tick 60 秒 = 排期精度 60 秒）
      const due = takeDueSchedule(at);
      if (due) {
        await runInspectRound(due.reason);
        return;
      }

      // 11) 队列空兜底（btc `DEFAULT_CHECK_MINUTES = 60`）
      if (fallbackDue(now)) await runInspectRound("排期队列为空，兜底巡检");
    } catch (err) {
      // 与 btc 一样只记日志：排期由模型决定，漏排期由第 11 步兜底接手
      state.lastError = err instanceof Error ? err.message : String(err);
      log(`巡检失败：${state.lastError}`);
    } finally {
      refresh(new Date());
    }
  };

  /**
   * tick：只负责重入闸门与错误兜底，真正的一轮在 `cycle()`。
   *
   * `busy` 必须在**任何 I/O 之前**置位：一轮里可能拉持仓行情、拉 15m K 线、
   * 冷启动时还要全市场重算指标，耗时远超 30 秒的 tick 间隔；旧实现把 `running`
   * 放在这些 I/O 之后才置位，慢的时候会并发跑两轮。
   */
  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      await cycle();
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      log(`本轮异常：${state.lastError}`);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      stopped = true;
      clearInterval(timer);
      releaseLock();
      try {
        fs.rmSync(statePath(), { force: true });
      } catch {
        // 忽略
      }
      resolve();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.on("SIGHUP", () => log("收到 SIGHUP，继续运行"));
  });
}

/** 手动巡检：不发指令、不自动买；走同一套 Agent 巡检与排期 */
export async function runManualInspection(): Promise<CycleResult> {
  const at = new Date();
  const actions: string[] = [];
  const account = loadPaperAccount(at);
  const quotes = quoteMap(
    await mapLimit(
      account.positions.map((position) => position.code),
      async (code) => fetchQuote(code).catch(() => null),
      6,
    ),
  );
  const alerts = await detectPositionRisks(at, quotes);
  actions.push(...alerts.map((item) => `${item.code} ${item.reason}`));
  const { runAInspect } = await import("./inspect");
  const result = await runAInspect("手动巡检", { origin: "manual" });
  actions.push(`巡检：${result.summary}`);
  if (result.error) actions.push(`巡检失败：${result.error}`);
  return { actions, sold: [], bought: [], selected: [] };
}

/**
 * 挂单撮合：价格穿越则成交，收盘前未成交则过期。
 *
 * `sessionOpen=false`（集合竞价 / 午休 / 盘前盘后 / 节假日）时只处理**到期**：
 * 不拉行情、不做价格穿越撮合，挂单留在 open 等下一个连续竞价时段。
 * 硬风控撤单不受时段限制（锁出现后随时撤掉未成交买单）。
 */
async function processPendingOrders(
  now: Date,
  sessionOpen: boolean,
): Promise<{ actions: string[]; expired: PendingOrder[] }> {
  const actions: string[] = [];
  const expiredOrders: PendingOrder[] = [];
  // 硬风控也要管住挂单：触发后才成交的买单同样不许开仓（卖出挂单不受影响）
  const open = listOrders().filter((order) => {
    if (order.status !== "open") return false;
    if (order.side !== "buy") return true;
    const block = buyBlockReason(order.code);
    if (!block) return true;
    cancelOrder(order.id);
    actions.push(`挂单撤销 ${describeOrder(order)}：${block}`);
    appendAAction({
      kind: "cancel",
      code: order.code,
      ok: true,
      status: "cancelled",
      message: `硬风控撤单：${block}`,
      origin: order.origin,
    });
    return false;
  });
  if (open.length === 0) return { actions, expired: expiredOrders };
  // 非连续竞价不拉行情：用空表仅走过期逻辑
  const quotes = sessionOpen
    ? quoteMap(
        await mapLimit(
          [...new Set(open.map((order) => order.code))],
          async (code) => fetchQuote(code).catch(() => null),
          6,
        ),
      )
    : new Map<string, Quote>();
  const { fills, expired } = matchOrders(quotes, now, { sessionOpen });
  for (const order of fills) {
    const result = await placePaperOrder(
      { code: order.code, side: order.side, qty: order.qty, price: order.limitPrice },
      now,
    );
    actions.push(
      result.ok ? `挂单成交 ${describeOrder(order)}` : `挂单成交失败 ${order.id}：${result.message}`,
    );
    appendAAction({
      kind: order.side,
      code: order.code,
      ok: result.ok,
      status: result.ok ? "filled" : "rejected",
      message: result.message,
      origin: order.origin,
    });
  }
  for (const order of expired) {
    actions.push(`挂单过期 ${describeOrder(order)}`);
    expiredOrders.push(order);
    appendAAction({
      kind: "expire",
      code: order.code,
      ok: true,
      status: "expired",
      message: `挂单过期 ${order.id}`,
      origin: order.origin,
    });
  }
  return { actions, expired: expiredOrders };
}

/**
 * 持仓级硬风控：只检测、落盘、告警；**不自动卖出**。
 * 与 btc 的 checkRisk 对齐 —— 交易由巡检 Agent 决定。
 */
async function detectPositionRisks(
  now: Date,
  quotes: Map<string, Quote>,
): Promise<PositionRiskAlert[]> {
  const account = loadPaperAccount(now);
  if (account.positions.length === 0) {
    writePositionRisks([]);
    return [];
  }
  const indicators = await loadIndicators({ allowPartial: true });
  const pending = new Map(readPendingSells().map((item) => [item.code, item]));
  const held = new Set(account.positions.map((position) => position.code));
  for (const code of [...pending.keys()]) if (!held.has(code)) pending.delete(code);

  const alerts: PositionRiskAlert[] = [];
  for (const position of account.positions) {
    const quote = quotes.get(position.code);
    if (!quote || quote.price <= 0) continue;
    let decision = shouldSell(position, quote, indicators.get(position.code));
    if (!decision) {
      try {
        // 分析周期统一为 15 分钟（与巡检的择时周期一致），不再用 30m
        const bars15 = await fetchBars(position.code, {
          period: "15m",
          adjust: "backward",
          limit: 80,
        });
        if (intradayWeak(bars15)) {
          decision = {
            reason: "15m 跌破 MA20 与前 10 根低点",
            sellable: position.available > 0,
            qty: position.available,
          };
        }
      } catch {
        // 取不到 15m 继续用 ATR
      }
    }
    if (!decision) {
      pending.delete(position.code);
      continue;
    }
    if (!decision.sellable) {
      pending.set(position.code, {
        code: position.code,
        name: position.name,
        reason: decision.reason,
        since: dayKey(now),
      });
    }
    alerts.push({
      code: position.code,
      name: position.name,
      reason: decision.reason,
      sellable: decision.sellable,
      qty: Math.min(decision.qty ?? position.available, position.available),
      at: iso(now),
    });
  }

  writePendingSells([...pending.values()]);
  const previous = readPositionRisks();
  const previousSignature = previous.alerts
    .map((item) => `${item.code}:${item.reason}:${item.sellable}`)
    .join("|");
  const signature = alerts
    .map((item) => `${item.code}:${item.reason}:${item.sellable}`)
    .join("|");
  writePositionRisks(alerts);
  if (alerts.length > 0 && signature !== previousSignature) {
    appendAAction({
      kind: "risk-alert",
      ok: true,
      message: alerts.map((item) => `${item.code} ${item.reason}`).join("；"),
    });
  }
  return alerts;
}

/**
 * 收盘后固定选股（工作日 16:00 后，每天一次）：
 * - 强制刷新快照与日线指标，确保用的是当天收盘数据；
 * - 完整三周期 MACD 漏斗 + 日线评分；
 * - 只替换非持仓自选股，持仓强制保留（并用同一口径重算分数，不留「0 分」）；
 * - 不触发巡检，不交易。
 */
export function shouldRunAfterCloseSelection(
  now: Date,
  lastSelectDay?: string,
  lastSelectAttemptAt?: string,
): boolean {
  if (now.getDay() === 0 || now.getDay() === 6) return false;
  if (now.getHours() < 16) return false;
  const today = dayKey(now);
  if (lastSelectDay === today) return false;
  if (lastSelectAttemptAt) {
    const elapsed = now.getTime() - Date.parse(lastSelectAttemptAt);
    if (Number.isFinite(elapsed) && elapsed < 30 * 60_000) return false;
  }
  return true;
}

/**
 * 选股结果 → 微信推送正文。
 *
 * 以前只推「选股 5 只：601857、601939、…」——用户只看到一串代码，不知道为什么进、
 * 为什么换，还得自己翻面板。现在带上名称、综合分、一句理由，以及本次的换入换出。
 */
export function describeSelection(items: WatchItem[], before: WatchItem[]): string {
  const lines = [`收盘选股 ${items.length} 只（持仓保留）`];
  items.forEach((item, index) => {
    // 括号里是分项打分明细，微信里太长 —— 只留结论部分，再按长度截断
    const raw = item.reason.trim().replace(/\s+/g, " ");
    const reason = (raw.includes("（") ? raw.slice(0, raw.indexOf("（")) : raw).slice(0, 36);
    // 持仓是「强制保留」带进来的，score 恒为 0：写「0 分」会让人以为它不及格
    const score = item.score > 0 ? ` · ${item.score} 分` : "";
    const heldNote = item.source === "held" && !reason.includes("持仓保留") ? " · 持仓保留" : "";
    lines.push(
      `${index + 1}. ${item.name} ${item.code}${score}${reason ? ` · ${reason}` : ""}${heldNote}`,
    );
  });
  const codes = new Set(items.map((item) => item.code));
  const added = items.filter((item) => !before.some((old) => old.code === item.code));
  if (added.length > 0) {
    lines.push(`新进：${added.map((item) => `${item.name} ${item.code}`).join("、")}`);
  }
  const removed = before.filter((item) => !codes.has(item.code));
  if (removed.length > 0) {
    lines.push(`移出：${removed.map((item) => `${item.name} ${item.code}`).join("、")}`);
  }
  return lines.join("\n");
}

async function maybeRunAfterCloseSelection(now: Date, state: AMonitorState): Promise<boolean> {
  if (!shouldRunAfterCloseSelection(now, state.lastSelectDay, state.lastSelectAttemptAt)) {
    return false;
  }
  const today = dayKey(now);

  try {
    // 日历只到上一个已收盘交易日：16:00 时今天可能还没入库，
    // 直接查 isTradingDay 会让「收盘选股」在每个交易日被跳过（曾经的 bug）。
    if (!(await tradingDayStatus(now))) return false;
  } catch {
    // 日历 / 行情都不可用时按工作日处理，避免错过选股
  }

  state.lastSelectAttemptAt = iso(now);
  writeSelectState({ ...readSelectState(), attemptedAt: state.lastSelectAttemptAt });
  log("收盘后固定选股开始（强制刷新当日指标）…");
  try {
    const size = poolSize();
    const before = loadWatchlist().items;
    const account = loadPaperAccount(now);
    const held = account.positions
      .filter((position) => position.qty > 0)
      .map((position) => ({ code: position.code, name: position.name }));
    const heldNow = held.length;
    // 选股口径：池子含持仓 → 只补「容量 − 持仓数」；满仓不跑全市场，但**持仓仍要重新打分**
    const need = selectionNeed(size, heldNow);
    if (need === 0) {
      const scored = await scoreHeldItems(held, log);
      const merged = mergeWatchlist(scored, held, now, size);
      saveWatchlist(merged);
      state.lastSelectDay = today;
      state.lastAction = `持仓 ${heldNow}/${size} 已满，重算持仓评分 ${scored.length} 只`;
      writeSelectState({ day: today, attemptedAt: state.lastSelectAttemptAt });
      appendAAction({
        kind: "select",
        ok: true,
        codes: merged.items.map((item) => item.code),
        message: describeSelection(merged.items, before),
      });
      log(`收盘后选股跳过（持仓 ${heldNow}/${size} 已满），已重算 ${scored.length} 只持仓评分`);
      return true;
    }
    log(`收盘后选股：池子 ${size} 只、持仓 ${heldNow} 只 → 需要新选 ${need} 只`);
    const picks = await selectTopWatchlist(need, log, { refresh: true });
    // 持仓不在「全市场前 20」里，选股流程根本不会给它们打分；这里单独补一遍，
    // 否则面板与推送只会写「0 分 · 已持仓，强制保留」，看不出持仓还行不行。
    const heldScored = await scoreHeldItems(held, log);
    const merged = mergeWatchlist([...picks, ...heldScored], held, now, size);
    saveWatchlist(merged);
    // **不清理全市场数据**：日线仓库会保留历史（每天只补一根），指标缓存也保留全市场。
    // 以前选股后把指标裁到池内并删掉快照 —— 结果当天再选一次就得重取 5000+ 只，
    // 而这正是「每天都在拉全市场」的来源。过期由各自 TTL 负责，不需要手动清。
    log(
      `选股完成：池内 ${merged.items.length}/${size} 只` +
        `（全市场日线与快照保留在缓存中，供当天再次选股/巡检复用）`,
    );
    state.lastSelectDay = today;
    writeSelectState({ day: today, attemptedAt: state.lastSelectAttemptAt });
    state.lastAction = `收盘后选股 ${picks.length} 只`;
    appendAAction({
      kind: "select",
      ok: true,
      codes: merged.items.map((item) => item.code),
      message: describeSelection(merged.items, before),
    });
    log(`收盘后选股完成：${picks.length} 只，自选 ${merged.items.length}/${poolSize()}`);
    return true;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    appendAAction({ kind: "select", ok: false, message: state.lastError });
    log(`收盘后选股失败：${state.lastError}`);
    return false;
  }
}

/**
 * 监控规则评估：持仓优先，再自选。
 *
 * `known` 是本轮已经拉过的行情（持仓），规则里同代码不再重复请求。
 */
async function checkMonitorRules(
  now: Date,
  known: Map<string, Quote> = new Map(),
): Promise<{ rule: import("./rules").MonitorRule; reason: string } | null> {
  const rules = readRules();
  if (rules.length === 0) return null;
  const held = heldCodes();
  const sorted = [...rules].sort(
    (a, b) => Number(held.has(b.code)) - Number(held.has(a.code)),
  );
  const codes = [...new Set(sorted.map((rule) => rule.code))];
  const missing = codes.filter((code) => !known.has(code));
  if (missing.length > 0) {
    const fetched = quoteMap(
      await mapLimit(missing, async (code) => fetchQuote(code).catch(() => null), 6),
    );
    for (const [code, quote] of fetched) known.set(code, quote);
  }
  const quotes = new Map(
    codes
      .filter((code) => known.has(code))
      .map((code) => [code, known.get(code)!] as const),
  );
  const indicators = await loadIndicators({ allowPartial: true });

  // 15m 结构类规则（ma20_break_15m / low10_break_15m …）才去取 15m K 线：
  // 只对「真的有这类规则」的代码各拉一次（池子很小，5 分钟一次可以接受），
  // 取不到的代码不进 map —— 规则按「数据不足 = 不命中」处理，不做危险兜底。
  const need15m = [...new Set(sorted.filter(ruleNeedsBars15m).map((rule) => rule.code))];
  const bars15m = new Map<string, Bar[]>();
  if (need15m.length > 0) {
    const fetched = await mapLimit(
      need15m,
      async (code) => {
        const bars = await fetchBars(code, {
          period: "15m",
          adjust: "backward",
          limit: 80,
        }).catch(() => null);
        return [code, bars] as const;
      },
      4,
    );
    for (const [code, bars] of fetched) if (bars) bars15m.set(code, bars);
  }
  return evaluateRules(sorted, quotes, indicators, now, bars15m);
}

export interface AServiceStatus {
  running: boolean;
  state: AMonitorState | null;
  stale: boolean;
}

export interface StartAServiceResult {
  ok: boolean;
  started: boolean;
  state?: AMonitorState;
  error?: string;
}

export function aServiceStatus(): AServiceStatus {
  const state = readAMonitorState();
  const alive = state !== null && pidAlive(state.pid);
  return { running: alive, state: alive ? state : null, stale: state !== null && !alive };
}

export async function startAService(): Promise<StartAServiceResult> {
  const current = aServiceStatus();
  if (current.running) return { ok: true, started: false, state: current.state! };

  ensureDir(monitorDir());
  const logFile = monitorLogPath();
  ensureDir(path.dirname(logFile));
  const fd = fs.openSync(logFile, "a");
  try {
    // `--foreground` 是内部标记：用户命令 `xzh a start` 只负责拉起后台并返回
    const child = spawn(process.execPath, [cliEntry(), "a", "start", "--foreground"], {
      detached: true,
      // stdout 不能也指向日志文件：`log()` 自己会 appendFileSync 一份，
      // 再把 stdout 重定向到同一个文件就会**每行写两遍**。
      // stderr 仍落到文件里，用来抓崩溃栈。
      stdio: ["ignore", "ignore", fd],
      cwd: getAShareHome(),
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { ok: false, started: false, error: `拉起 A 股后台服务失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 已继承
    }
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = readAMonitorState();
    if (state && pidAlive(state.pid)) return { ok: true, started: true, state };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ok: false, started: true, error: "A 股后台服务启动后 5 秒内没有写出状态" };
}

export async function stopAService(): Promise<{ ok: boolean; stopped: boolean; error?: string }> {
  const state = readAMonitorState();
  if (!state) return { ok: true, stopped: false };
  if (!pidAlive(state.pid)) {
    try {
      fs.rmSync(statePath(), { force: true });
    } catch {
      // 忽略
    }
    return { ok: true, stopped: false };
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // 继续等
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) {
      try {
        fs.rmSync(statePath(), { force: true });
      } catch {
        // 忽略
      }
      return { ok: true, stopped: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    // 忽略
  }
  try {
    fs.rmSync(statePath(), { force: true });
  } catch {
    // 忽略
  }
  return { ok: true, stopped: true };
}

/** 手工维护自选股时，把当前持仓带进来做“不可删除”校验 */

export function heldCodes(): Set<string> {
  return new Set(loadPaperAccount().positions.map((position) => position.code));
}

export type { WatchItem };
