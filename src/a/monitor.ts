import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  continuousSession,
  fetchBars,
  fetchQuote,
  isTradingDay,
  loadTradingCalendar,
  mapLimit,
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
import { runAInspect } from "./inspect";
import { commitRuleHit, describeRule, evaluateRules, readRules } from "./rules";
import { pushSchedule, readScheduleQueue, takeDueSchedule } from "./schedule";
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
import { selectTopWatchlist } from "./score";
import {
  loadWatchlist,
  mergeWatchlist,
  monitorDir,
  saveWatchlist,
  type WatchItem,
} from "./watchlist";
import { poolSize } from "./settings";
import { ensureDir, getAShareHome } from "../utils/paths";
import { VERSION } from "../utils/version";

/**
 * A 股独立后台服务（`xzh a start` 拉起）—— 巡检只是其中一部分。
 *
 * 一个进程同时负责：
 * - 每分钟 tick：监控规则、挂单撮合（仅连续竞价）、持仓风控检测；
 * - 到排期时跑完整巡检（`a_schedule` 决定下一轮；失败 15 分钟退避、队列空 60 分钟兜底）；
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
const CYCLE_MS = 15 * 60_000;
const TICK_MS = 30_000;
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
 * 工作窗口：工作日 09:00–15:30。
 *
 * 这是**进程的工作时间**（含集合竞价、午休、收盘后的收尾），只决定「要不要拉数据 /
 * 跑巡检」；**不能当撮合闸门** —— 撮合与成交必须用 `continuousSession()`
 * （09:30–11:30 / 13:00–15:00 且当天是交易日）。
 */
export function inTradingWindow(now = new Date()): boolean {
  const weekday = now.getDay();
  if (weekday === 0 || weekday === 6) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
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
  if (at.getDay() === 0 || at.getDay() === 6) return;
  const started = Date.now();
  log("预热日线指标（缓存缺失时全市场重算，约 1–2 分钟）…");
  try {
    const indicators = await loadIndicators();
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
  const state: AMonitorState = {
    pid: process.pid,
    startedAt: iso(now),
    updatedAt: iso(now),
    version: VERSION,
    nextRunAt: iso(now),
    watchlist: loadWatchlist().items.length,
    holdings: loadPaperAccount(now).positions.length,
  };
  writeState(state);
  log(`A 股巡检启动 pid=${process.pid}，工作日 09:00–15:30 巡检；收盘后 16:00 固定选股`);

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

  const cycle = async (): Promise<void> => {
    const at = new Date();
    refresh(at);

    // 固定任务：收盘后 1 小时重新选股（只更新自选股，持仓强制保留）。
    // 它不交易，因此暂停巡检时也照常执行；放在交易窗口判断之前，因为 16:00 已收盘。
    if (shouldRunAfterCloseSelection(at, state.lastSelectDay, state.lastSelectAttemptAt)) {
      if (selecting) return;
      selecting = true;
      try {
        const selected = await maybeRunAfterCloseSelection(at, state);
        if (selected) refresh(new Date());
      } finally {
        selecting = false;
      }
    }

    // 非工作时段（夜间 / 周末 / 15:30 之后）完全不拉行情：收盘之后价格是冻结的，
    // 逐 tick 重拉持仓行情与 15m K 线只是白烧请求。
    if (!inTradingWindow(at)) return;

    // 硬风控与 btc 对齐：只落盘 + 告警，不自动交易；工作时段内即使暂停也检查
    const account = loadPaperAccount(at);
    const codes = account.positions.map((position) => position.code);
    const heldQuotes = quoteMap(
      await mapLimit(codes, async (code) => fetchQuote(code).catch(() => null), 6),
    );
    const accountRisk = checkAccountRisk(account, heldQuotes, at);
    await detectPositionRisks(at, heldQuotes);
    const riskAlerts = readPositionRisks();

    if (isPaused()) return;

    try {
      // 撮合闸门是**连续竞价**（09:30–11:30 / 13:00–15:00 且当天是交易日），
      // 不是 09:00–15:30 的工作窗口：集合竞价、午休、节假日不按冻结价成交。
      const session = await continuousSession(at);
      const pending = await processPendingOrders(at, session.open);
      const orderActions = pending.actions;
      if (orderActions.length > 0) {
        state.lastAction = orderActions[0];
        log(orderActions.join("；"));
      }
      const riskState = readRiskState();
      // 账户级与单票级都算「有风控」，但只有账户级会禁止全账户买入
      const riskTriggered = accountRisk.triggered || accountRisk.locks.length > 0;
      const riskPending = riskTriggered && !(riskState?.delivered ?? false);
      const positionRiskPending = riskAlerts.alerts.length > 0 && !riskAlerts.delivered;

      const hit = await checkMonitorRules(at, heldQuotes);
      const due = takeDueSchedule(at);
      const event = takeMarketEvent(at);
      const lastInspect = state.lastInspectAt ? Date.parse(state.lastInspectAt) : 0;
      const fallback = Date.now() - lastInspect >= 60 * 60_000;

      if (!hit && !due && !event && !riskPending && !positionRiskPending && !fallback) {
        return;
      }

      const positionReason =
        positionRiskPending
          ? `持仓风控：${riskAlerts.alerts
              .map((item) => `${item.code} ${item.reason}${item.sellable ? "" : "（T+1 不可卖）"}`)
              .join("；")}`
          : undefined;
      const riskReason = accountRisk.triggered
        ? `账户级硬风控：${accountRisk.reasons.join("；")}`
        : accountRisk.locks.length > 0
          ? `单票硬风控：${accountRisk.locks
              .map((lock) => `${lock.code} ${lock.name} ${lock.reason}`)
              .join("；")}`
          : undefined;
      const reason =
        (positionReason ??
          (riskPending ? riskReason : undefined)) ??
        hit?.reason ??
        due?.reason ??
        event?.reason ??
        "兜底巡检";
      state.lastInspectReason = reason;
      log(`唤醒巡检：${reason}`);
      // 叫醒来源要带进提示词：只说「巡检」会让模型当成常规轮次，回一句「无变化」
      const triggerNote = hit
        ? `${describeRule(hit.rule)}（${hit.reason}）`
        : event
          ? `市场事件：${event.reason}`
          : undefined;
      const orderNote =
        pending.expired.length > 0
          ? pending.expired
              .map(
                (order) =>
                  `${describeOrder(order)} 已于 ${order.expiresAt} 过期（原因：${order.reason}）`,
              )
              .join("\n")
          : undefined;
      const result = await runAInspect(reason, { origin: "inspect", triggerNote, orderNote });
      if (hit) commitRuleHit(hit.rule);
      if (!result.error) {
        if (riskTriggered) markRiskDelivered();
        if (riskAlerts.alerts.length > 0) markPositionRisksDelivered();
      }
      state.lastInspectAt = iso(new Date());
      state.lastInspectSummary = result.summary;
      state.lastInspectTools = result.toolCalls;
      state.lastAction = result.summary;
      state.lastError = result.error;

      if (result.error) {
        const entry = pushSchedule({
          minutes: 15,
          reason: `巡检失败退避：${result.error}`,
          slot: "next",
          origin: "inspect",
        });
        state.nextCheckAt = entry.at;
      }
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      log(`巡检失败：${state.lastError}`);
      pushSchedule({ minutes: 15, reason: "巡检异常退避", slot: "next", origin: "inspect" });
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
  const indicators = await loadIndicators();
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
 * - 只替换非持仓自选股，持仓强制保留；
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

async function maybeRunAfterCloseSelection(now: Date, state: AMonitorState): Promise<boolean> {
  if (!shouldRunAfterCloseSelection(now, state.lastSelectDay, state.lastSelectAttemptAt)) {
    return false;
  }
  const today = dayKey(now);

  try {
    const calendar = await loadTradingCalendar();
    if (!isTradingDay(calendar, today)) return false;
  } catch {
    // 日历不可用时按工作日处理，避免错过选股
  }

  state.lastSelectAttemptAt = iso(now);
  log("收盘后固定选股开始（强制刷新当日指标）…");
  try {
    const size = poolSize();
    const picks = await selectTopWatchlist(size, log, { refresh: true });
    const account = loadPaperAccount(now);
    const merged = mergeWatchlist(
      picks,
      account.positions.map((position) => ({ code: position.code, name: position.name })),
      now,
      size,
    );
    saveWatchlist(merged);
    state.lastSelectDay = today;
    state.lastAction = `收盘后选股 ${picks.length} 只`;
    appendAAction({
      kind: "select",
      ok: true,
      codes: merged.items.map((item) => item.code),
      message: `收盘后选股 ${picks.length} 只（持仓保留）`,
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
  const indicators = await loadIndicators();
  return evaluateRules(sorted, quotes, indicators, now);
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

export interface StartAServiceResult {
  ok: boolean;
  started: boolean;
  state?: AMonitorState;
  error?: string;
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
      stdio: ["ignore", fd, fd],
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
