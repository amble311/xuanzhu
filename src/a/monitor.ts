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
import { evaluateMarketRegime } from "./regime";
import { intradayBuyReady, intradayWeak } from "./intraday";
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

const MAX_POSITIONS = 5;
const POSITION_PCT = 0.2;
/** 初始止损下限 5%，并按 1.5×ATR 放大 */
const MIN_STOP_PCT = 0.05;
const STOP_ATR_MULTIPLE = 1.5;
/** 浮盈超过 8% 后启动移动止盈 */
const TRAIL_TRIGGER_PCT = 0.08;
/** 浮盈 12% 时卖出一半，剩余继续移动止盈 */
const PARTIAL_TAKE_PCT = 0.12;
const BUY_SCORE = 70;
const BUY_MAX_PCT = 5;
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

function appendAction(entry: Record<string, unknown>): void {
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

/** 盘中窗口（含集合竞价/尾盘缓冲），周末不算 */
export function inTradingWindow(now = new Date()): boolean {
  const weekday = now.getDay();
  if (weekday === 0 || weekday === 6) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (
    (minutes >= 9 * 60 + 25 && minutes <= 11 * 60 + 35) ||
    (minutes >= 12 * 60 + 55 && minutes <= 15 * 60 + 5)
  );
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
export async function runMonitorCycle(now = new Date()): Promise<CycleResult> {
  const result: CycleResult = { actions: [], sold: [], bought: [], selected: [] };
  const before = loadPaperAccount(now);
  const watchBefore = loadWatchlist();
  const codes = [
    ...new Set([
      ...before.positions.map((position) => position.code),
      ...watchBefore.items.map((item) => item.code),
    ]),
  ];
  const quotes = quoteMap(
    await mapLimit(codes, async (code) => fetchQuote(code).catch(() => null), 6),
  );

  // 只有「交易日 + 盘中窗口」才允许成交；非交易时段只做选股/复盘，避免周末按收盘价下单
  let tradingDay = false;
  try {
    const calendar = await loadTradingCalendar();
    tradingDay = isTradingDay(calendar, dayKey(now));
  } catch {
    tradingDay = false;
  }
  const canTrade = tradingDay && inTradingWindow(now);

  // 1) 持仓卖点：T+1 锁定的股票照样评估，只是今天不执行，进入待卖队列
  let account = loadPaperAccount(now);
  const indicators = await loadIndicators();
  const pending = new Map(readPendingSells().map((item) => [item.code, item]));
  const heldCodes = new Set(account.positions.map((position) => position.code));
  for (const code of [...pending.keys()]) {
    if (!heldCodes.has(code)) pending.delete(code);
  }

  for (const position of account.positions) {
    const quote = quotes.get(position.code);
    if (!quote || quote.price <= 0) continue;
    let decision = shouldSell(position, quote, indicators.get(position.code));

    // 日内卖点：ATR 止损未触发时，再看 30m 是否走弱（数据失败不卖）
    if (!decision && canTrade) {
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
        // 取不到 30m 就不按日内信号卖，继续用 ATR 风控
      }
    }

    // 风险解除：撤销待卖（例如第二天反弹回 MA20 上方）
    if (!decision) {
      if (pending.delete(position.code)) {
        result.actions.push(`${position.code} 风险已解除，撤销待卖`);
        appendAction({ kind: "risk-clear", code: position.code, ok: true });
      }
      continue;
    }

    // 今天不能卖（T+1 / 非交易时段）：记录待卖，下一交易日开盘处理
    if (!decision.sellable || !canTrade) {
      const existing = pending.get(position.code);
      if (!existing) {
        pending.set(position.code, {
          code: position.code,
          name: position.name,
          reason: decision.reason,
          since: dayKey(now),
        });
        result.actions.push(
          `T+1 锁定 ${position.code} ${decision.reason}，下一交易日开盘处理`,
        );
        appendAction({
          kind: "risk-locked",
          code: position.code,
          reason: decision.reason,
          ok: true,
        });
      } else if (existing.reason !== decision.reason) {
        existing.reason = decision.reason;
      }
      continue;
    }

    const sellQty = Math.min(decision.qty ?? position.available, position.available);
    if (sellQty < 1) continue;
    const sold = await placePaperOrder(
      { code: position.code, side: "sell", qty: sellQty },
      now,
    );
    result.actions.push(
      sold.ok
        ? `卖出 ${position.code} ${decision.reason}：${sold.message}`
        : `卖出失败 ${position.code}：${sold.message}`,
    );
    if (sold.ok) {
      if (decision.partial) {
        markPartialTaken(position.code);
      } else {
        result.sold.push(position.code);
        pending.delete(position.code);
      }
    }
    appendAction({
      kind: "sell",
      code: position.code,
      reason: decision.reason,
      ok: sold.ok,
      message: sold.message,
    });
  }
  writePendingSells([...pending.values()]);

  // 2) 无持仓时全市场选股（每天一次）
  const state = readAMonitorState();
  account = loadPaperAccount(now);
  const watch = loadWatchlist();
  const today = dayKey(now);
  // 手动 `monitor once` 没有 daemon state，用 watchlist 的更新时间当作「今天已选过」
  const lastSelectDay =
    state?.lastSelectDay ??
    (Number.isNaN(Date.parse(watch.updatedAt)) ? "" : dayKey(new Date(watch.updatedAt)));
  if (watch.items.length === 0 || lastSelectDay !== today) {
    log("开始全市场选股（持仓会强制保留）…");
    try {
      const picks = await selectTopWatchlist(10, log);
      const heldForSelect = account.positions.map((position) => ({
        code: position.code,
        name: position.name,
      }));
      const merged = mergeWatchlist(picks, heldForSelect);
      saveWatchlist(merged);
      if (state) {
        state.lastSelectDay = today;
        state.watchlist = merged.items.length;
        writeState(state);
      }
      result.selected = merged.items.map((item) => item.code);
      result.actions.push(`选股 ${merged.items.length} 只：${merged.items.map((item) => `${item.code}(${item.score})`).join("、")}`);
      appendAction({ kind: "select", ok: true, codes: result.selected });
    } catch (err) {
      result.actions.push(`选股失败：${err instanceof Error ? err.message : String(err)}`);
      appendAction({ kind: "select", ok: false, message: String(err) });
    }
  }

  // 3) 自选股买点（持仓未满时；非交易时段不下单）
  account = loadPaperAccount(now);
  if (canTrade && account.positions.length < MAX_POSITIONS) {
    const held = new Set(account.positions.map((position) => position.code));
    const candidates = loadWatchlist()
      .items.filter((item) => !held.has(item.code) && item.score >= BUY_SCORE)
      .sort((a, b) => b.score - a.score);
    const equity = equityOf(account, quotes);

    // 市场门控：弱势只卖不买，避免在下跌环境里反复试错
    let allowBuy = true;
    if (candidates.length > 0) {
      const regime = await evaluateMarketRegime();
      if (!regime.riskOn) {
        result.actions.push(`市场门控：${regime.reason}，暂停开仓`);
        appendAction({ kind: "regime", ok: true, message: regime.reason });
        allowBuy = false;
      }
    }

    if (allowBuy)
      for (const item of candidates) {
      let quote: Quote;
      try {
        quote = await fetchQuote(item.code);
      } catch {
        continue;
      }
      if (quote.price <= 0 || quote.stockStatus?.includes("停")) continue;
      if (quote.limitUp && quote.price >= quote.limitUp - 0.001) continue;
      if (quote.changePct > BUY_MAX_PCT) continue;

      // 日内买点：选股只看日/周/月 MACD，但成交时仍要 30m 确认
      try {
        const bars30 = await fetchBars(item.code, {
          period: "30m",
          adjust: "backward",
          limit: 80,
        });
        if (!intradayBuyReady(bars30)) continue;
      } catch {
        continue;
      }
      let qty = Math.floor((equity * POSITION_PCT) / quote.price / 100) * 100;
      const affordable = Math.floor((account.cash - 10) / quote.price / 100) * 100;
      qty = Math.min(qty, affordable);
      if (qty < 100) continue;
      const bought = await placePaperOrder({ code: item.code, side: "buy", qty }, now);
      result.actions.push(bought.ok ? `买入 ${item.code}：${bought.message}` : `买入失败 ${item.code}：${bought.message}`);
      appendAction({ kind: "buy", code: item.code, score: item.score, ok: bought.ok, message: bought.message });
      if (bought.ok) {
        result.bought.push(item.code);
        break; // 每轮最多建一个仓，避免同一分钟把现金打满
      }
    }
  }

  // 4) 确保持仓仍在自选股中（用户手工改过也要纠正）
  account = loadPaperAccount(now);
  const held = account.positions.map((position) => ({ code: position.code, name: position.name }));
  saveWatchlist(mergeWatchlist(loadWatchlist().items, held, now));

  const latestState = readAMonitorState();
  if (latestState) {
    latestState.updatedAt = iso(now);
    latestState.lastRunAt = iso(now);
    latestState.lastAction = result.actions[0];
    latestState.watchlist = loadWatchlist().items.length;
    latestState.holdings = account.positions.length;
    writeState(latestState);
  }
  log(`巡检完成：${result.actions.length > 0 ? result.actions.join("；") : "无动作"}`);
  return result;
}

// ─────────────────────────── 常驻进程 ───────────────────────────

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
    process.stderr.write("A 股巡检已在运行（锁被占用），本次退出。\n");
    process.exit(1);
  }

  const now = new Date();
  const state: AMonitorState = {
    pid: process.pid,
    startedAt: iso(now),
    updatedAt: iso(now),
    version: VERSION,
    nextRunAt: iso(new Date(now.getTime() + CYCLE_MS)),
    watchlist: loadWatchlist().items.length,
    holdings: loadPaperAccount(now).positions.length,
  };
  writeState(state);
  log(`A 股巡检启动 pid=${process.pid}，窗口 09:25–11:35 / 12:55–15:05，每 15 分钟`);

  let nextRun = Date.now();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const at = new Date();
    state.updatedAt = iso(at);
    state.watchlist = loadWatchlist().items.length;
    state.holdings = loadPaperAccount(at).positions.length;
    writeState(state);

    // 首次启动且从未选股：即使不在窗口也先选一次，否则面板与监控是空的
    const needsFirstSelect = loadWatchlist().items.length === 0 && !state.lastSelectDay;
    if (Date.now() < nextRun) return;
    if (!inTradingWindow(at) && !needsFirstSelect) return;

    nextRun = Date.now() + CYCLE_MS;
    state.nextRunAt = iso(new Date(nextRun));
    try {
      const result = await runMonitorCycle(at);
      state.lastAction = result.actions[0] ?? "无动作";
      state.lastError = undefined;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      log(`巡检失败：${state.lastError}`);
    }
    writeState(state);
  };

  // 不能 unref：这是常驻进程，定时器是唯一让它保持活着的句柄
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

export interface AServiceStatus {
  running: boolean;
  state: AMonitorState | null;
  stale: boolean;
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
