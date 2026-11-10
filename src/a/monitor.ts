import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
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
import { commitRuleHit, evaluateRules, readRules } from "./rules";
import { pushSchedule, readScheduleQueue, takeDueSchedule } from "./schedule";
import { isPaused, readPause } from "./pause";
import { takeMarketEvent } from "./events";
import { describeOrder, listOrders, matchOrders } from "./orders";
import { checkAccountRisk, markRiskDelivered } from "./risk";
import { intradayWeak } from "./intraday";
import { loadIndicators } from "./indicators";
import { selectTopWatchlist } from "./score";
import { loadWatchlist, mergeWatchlist, monitorDir, saveWatchlist, type WatchItem } from "./watchlist";
import { ensureDir, getAShareHome } from "../utils/paths";
import { VERSION } from "../utils/version";

/**
 * A 股独立巡检进程（`xzh a serve`）。
 *
 * 与 btc 的差别：A 股只有 4 小时交易、T+1、只能做多，因此不跑 24/7：
 * - 盘中每 15 分钟一轮：先看持仓卖点，再给自选股找买点；
 * - 无持仓时每天重选一次全市场前 10（收盘后/盘前数据即可）；
 * - 非交易时段休眠，不做全市场轮询。
 *
 * 决策是**确定性规则**：月/周/日趋势 + 1h 择时打分，不每轮调用模型。
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

/** 工作窗口：工作日 09:00–15:30（监控与巡检都只在这段时间工作） */
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


export async function runAServe(): Promise<void> {
  ensureDir(monitorDir());
  if (!acquireLock()) {
    process.stderr.write("A 股巡检与监控已在运行（锁被占用），本次退出。\n");
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
  log(`A 股巡检启动 pid=${process.pid}，工作日 09:00–15:30 工作`);

  let stopped = false;
  let running = false;

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

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    const at = new Date();
    refresh(at);

    if (isPaused()) return;
    if (!inTradingWindow(at)) return;

    running = true;
    try {
      const account = loadPaperAccount(at);
      const codes = account.positions.map((position) => position.code);
      const heldQuotes = quoteMap(
        await mapLimit(codes, async (code) => fetchQuote(code).catch(() => null), 6),
      );
      const orderActions = await processPendingOrders(at);
      const actions = [...orderActions, ...(await enforceStops(at, heldQuotes))];
      const risk = checkAccountRisk(account, heldQuotes, at);

      await ensureDailySelection(at, state);

      const hit = await checkMonitorRules(at);
      const due = takeDueSchedule(at);
      const event = takeMarketEvent(at);
      const lastInspect = state.lastInspectAt ? Date.parse(state.lastInspectAt) : 0;
      const fallback = Date.now() - lastInspect >= 60 * 60_000;

      if (!hit && !due && !event && !risk.triggered && !fallback) {
        if (actions.length > 0) {
          state.lastAction = actions[0];
          log(actions.join("；"));
        }
        return;
      }

      const reason =
        (risk.triggered ? `硬风控：${risk.reasons.join("；")}` : undefined) ??
        hit?.reason ??
        due?.reason ??
        event?.reason ??
        "兜底巡检";
      state.lastInspectReason = reason;
      log(`唤醒巡检：${reason}`);
      const result = await runAInspect(reason, { origin: "inspect" });
      if (hit) commitRuleHit(hit.rule);
      if (risk.triggered && !result.error) markRiskDelivered();
      state.lastInspectAt = iso(new Date());
      state.lastInspectSummary = result.summary;
      state.lastInspectTools = result.toolCalls;
      state.lastAction = result.summary || actions[0];
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
      running = false;
      refresh(new Date());
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
  actions.push(...(await enforceStops(at, quotes)));
  const state = readAMonitorState();
  if (state) await ensureDailySelection(at, state);
  const result = await runAInspect("手动巡检", { origin: "manual" });
  actions.push(`巡检：${result.summary}`);
  if (result.error) actions.push(`巡检失败：${result.error}`);
  return { actions, sold: [], bought: [], selected: [] };
}

/** 挂单撮合：价格穿越则成交，收盘前未成交则过期 */
async function processPendingOrders(now: Date): Promise<string[]> {
  const open = listOrders().filter((order) => order.status === "open");
  if (open.length === 0) return [];
  const quotes = quoteMap(
    await mapLimit(
      [...new Set(open.map((order) => order.code))],
      async (code) => fetchQuote(code).catch(() => null),
      6,
    ),
  );
  const { fills, expired } = matchOrders(quotes, now);
  const actions: string[] = [];
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
    appendAAction({
      kind: "expire",
      code: order.code,
      ok: true,
      status: "expired",
      message: `挂单过期 ${order.id}`,
      origin: order.origin,
    });
  }
  return actions;
}

/** 硬风控（代码强制执行，不依赖 Agent）：ATR 止损 / 移动止盈 / 分批 + T+1 待卖 */
async function enforceStops(now: Date, quotes: Map<string, Quote>): Promise<string[]> {
  const actions: string[] = [];
  const account = loadPaperAccount(now);
  if (account.positions.length === 0) return actions;
  const indicators = await loadIndicators();
  const pending = new Map(readPendingSells().map((item) => [item.code, item]));
  const held = new Set(account.positions.map((position) => position.code));
  for (const code of [...pending.keys()]) if (!held.has(code)) pending.delete(code);

  for (const position of account.positions) {
    const quote = quotes.get(position.code);
    if (!quote || quote.price <= 0) continue;
    let decision = shouldSell(position, quote, indicators.get(position.code));
    if (!decision) {
      try {
        const bars30 = await fetchBars(position.code, {
          period: "30m",
          adjust: "backward",
          limit: 80,
        });
        if (intradayWeak(bars30)) {
          decision = {
            reason: "30m 跌破 MA20 与前 10 根低点",
            sellable: position.available > 0,
            qty: position.available,
          };
        }
      } catch {
        // 取不到 30m 继续用 ATR
      }
    }
    if (!decision) {
      if (pending.delete(position.code)) {
        actions.push(`${position.code} 风险已解除，撤销待卖`);
        appendAAction({ kind: "risk-clear", code: position.code, ok: true });
      }
      continue;
    }
    if (!decision.sellable) {
      if (!pending.has(position.code)) {
        pending.set(position.code, {
          code: position.code,
          name: position.name,
          reason: decision.reason,
          since: dayKey(now),
        });
        actions.push(`T+1 锁定 ${position.code} ${decision.reason}，下一交易日处理`);
        appendAAction({ kind: "risk-locked", code: position.code, reason: decision.reason, ok: true });
      }
      continue;
    }
    const qty = Math.min(decision.qty ?? position.available, position.available);
    if (qty < 1) continue;
    const sold = await placePaperOrder({ code: position.code, side: "sell", qty }, now);
    actions.push(
      sold.ok
        ? `卖出 ${position.code} ${decision.reason}：${sold.message}`
        : `卖出失败 ${position.code}：${sold.message}`,
    );
    if (sold.ok) {
      if (decision.partial) markPartialTaken(position.code);
      else pending.delete(position.code);
    }
    appendAAction({
      kind: "sell",
      code: position.code,
      reason: decision.reason,
      ok: sold.ok,
      message: sold.message,
    });
  }
  writePendingSells([...pending.values()]);
  return actions;
}

/** 无持仓时每天重选一次（选股属于巡检的“综合选股”层，不是交易） */
async function ensureDailySelection(now: Date, state: AMonitorState): Promise<void> {
  const account = loadPaperAccount(now);
  const watch = loadWatchlist();
  const today = dayKey(now);
  const lastSelectDay =
    state.lastSelectDay ??
    (Number.isNaN(Date.parse(watch.updatedAt)) ? "" : dayKey(new Date(watch.updatedAt)));
  if (watch.items.length > 0 && lastSelectDay === today) return;
  log("开始全市场选股（持仓强制保留）…");
  try {
    const picks = await selectTopWatchlist(10, log);
    const merged = mergeWatchlist(
      picks,
      account.positions.map((position) => ({ code: position.code, name: position.name })),
    );
    saveWatchlist(merged);
    state.lastSelectDay = today;
    appendAAction({ kind: "select", ok: true, codes: merged.items.map((item) => item.code) });
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    appendAAction({ kind: "select", ok: false, message: state.lastError });
  }
}

/** 监控规则评估：持仓优先，再自选 */
async function checkMonitorRules(
  now: Date,
): Promise<{ rule: import("./rules").MonitorRule; reason: string } | null> {
  const rules = readRules();
  if (rules.length === 0) return null;
  const held = heldCodes();
  const sorted = [...rules].sort(
    (a, b) => Number(held.has(b.code)) - Number(held.has(a.code)),
  );
  const codes = [...new Set(sorted.map((rule) => rule.code))];
  const quotes = quoteMap(
    await mapLimit(codes, async (code) => fetchQuote(code).catch(() => null), 6),
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
    const child = spawn(process.execPath, [cliEntry(), "a", "serve", "run"], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: getAShareHome(),
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { ok: false, started: false, error: `拉起 A 股巡检失败：${err instanceof Error ? err.message : String(err)}` };
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
  return { ok: false, started: true, error: "巡检进程启动后 5 秒内没有写出状态" };
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
