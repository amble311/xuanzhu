import * as fs from "fs";
import * as path from "path";
import { continuousSession, fetchQuote, type Quote } from "../exchange/ashare";
import { ensureDir, getAShareHome } from "../utils/paths";
import { DEFAULT_MAX_POSITIONS, maxPositions } from "./settings";

/**
 * A 股模拟盘账本（最小可用版）。
 *
 * 规则刻意与真实 A 股一致，否则「模拟赚钱、实盘亏钱」：
 * - T+1：当日买入的股份次日才能卖（按本地日期切换 `available`）；
 * - 100 股整手：买入必须是 100 的整数倍；卖出允许一次性清掉零股；
 * - 涨跌停 / 停牌不成交（直接拒单，不做「排队」假设）；
 * - 费用：佣金 0.025%（最低 5 元）、印花税卖出 0.05%、过户费 0.001% 双边。
 *
 * 只做**立即成交**，不维护挂单队列：限价单不穿越现价时直接拒绝。
 * 账本落在 `~/.xzh_a/paper/account.json`，与行情缓存分开。
 */

const INITIAL_CASH = 1_000_000;
const COMMISSION_RATE = 0.00025;
const MIN_COMMISSION = 5;
const STAMP_RATE = 0.0005;
const TRANSFER_RATE = 0.00001;
const MAX_TRADES = 100;

/**
 * 同时持有的股票**只数**上限（不含同一只股票加仓），默认 3、用户可改
 * （`~/.xzh_a/settings.json` 的 `maxPositions`，见 `settings.ts`）。
 *
 * 为什么要有：A 股是 T+1，持仓一多就管不过来，风控（ATR 止损 / 移动止盈）
 * 也会因为分母变多而失效。这条由代码强制，提示词里的数字只是同一规则的说明。
 */
export interface PaperOrderLimits {
  /** 不传 = 默认值（纯函数保持可测试，运行期由 `placePaperOrder` 注入用户配置） */
  maxPositions?: number;
}

export interface PaperPosition {
  code: string;
  name: string;
  qty: number;
  /** T+1 可卖数量 */
  available: number;
  /** 持仓均价（不含费用） */
  avgCost: number;
  lastPrice: number;
  marketValue: number;
  pnl: number;
  pnlPct: number;
  /** 持仓期间最高价（移动止盈用） */
  peakPrice?: number;
  /** 是否已经执行过 +12% 的分批止盈 */
  tookPartial?: boolean;
}

export interface PaperTrade {
  id: string;
  code: string;
  name: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  amount: number;
  fees: number;
  time: string;
  /** 卖出时的已实现盈亏（买为 undefined） */
  pnl?: number;
}

export interface PaperAccount {
  version: 1;
  initial: number;
  cash: number;
  /** 已实现盈亏（扣除卖出费用） */
  realizedPnl: number;
  positions: PaperPosition[];
  trades: PaperTrade[];
  lastTradingDay: string;
  updatedAt: string;
}

export interface PaperSummary {
  cash: number;
  marketValue: number;
  equity: number;
  totalPnl: number;
  totalPnlPct: number;
  realizedPnl: number;
  positionCount: number;
}

export interface OrderRequest {
  code: string;
  side: "buy" | "sell";
  qty: number;
  /** 限价；不传 = 市价（按当前价成交） */
  price?: number;
}

export interface OrderResult {
  ok: boolean;
  message: string;
  account: PaperAccount;
  trade?: PaperTrade;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dateKey(now: Date): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function paperDir(): string {
  return path.join(getAShareHome(), "paper");
}

export function paperFile(): string {
  return path.join(paperDir(), "account.json");
}

export function emptyPaperAccount(now = new Date()): PaperAccount {
  return {
    version: 1,
    initial: INITIAL_CASH,
    cash: INITIAL_CASH,
    realizedPnl: 0,
    positions: [],
    trades: [],
    lastTradingDay: dateKey(now),
    updatedAt: now.toISOString(),
  };
}

function normalizeAccount(raw: Partial<PaperAccount>, now: Date): PaperAccount {
  const base = emptyPaperAccount(now);
  const positions = Array.isArray(raw.positions)
    ? raw.positions
        .filter((item): item is PaperPosition => Boolean(item && typeof item.code === "string"))
        .map((item) => ({
          ...item,
          qty: Number(item.qty) || 0,
          available: Math.min(Number(item.available) || 0, Number(item.qty) || 0),
          avgCost: Number(item.avgCost) || 0,
          lastPrice: Number(item.lastPrice) || 0,
          marketValue: Number(item.marketValue) || 0,
          pnl: Number(item.pnl) || 0,
          pnlPct: Number(item.pnlPct) || 0,
          peakPrice: Number(item.peakPrice) || Number(item.avgCost) || 0,
          tookPartial: item.tookPartial === true,
        }))
    : [];
  const account: PaperAccount = {
    ...base,
    initial: Number(raw.initial) || INITIAL_CASH,
    cash: Number(raw.cash) || 0,
    realizedPnl: Number(raw.realizedPnl) || 0,
    positions,
    trades: Array.isArray(raw.trades) ? raw.trades.slice(-MAX_TRADES) : [],
    lastTradingDay: typeof raw.lastTradingDay === "string" ? raw.lastTradingDay : base.lastTradingDay,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
  };

  // 跨日：昨日买入的股份今天可卖
  const today = dateKey(now);
  if (account.lastTradingDay !== today) {
    for (const position of account.positions) position.available = position.qty;
    account.lastTradingDay = today;
    account.updatedAt = now.toISOString();
  }
  return account;
}

export function loadPaperAccount(now = new Date()): PaperAccount {
  try {
    const raw = JSON.parse(fs.readFileSync(paperFile(), "utf8")) as Partial<PaperAccount>;
    return normalizeAccount(raw, now);
  } catch {
    return emptyPaperAccount(now);
  }
}

export function savePaperAccount(account: PaperAccount): void {
  ensureDir(paperDir());
  const tmp = `${paperFile()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(account, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, paperFile());
}

/** 买卖费用（元） */
export function tradingFees(
  side: "buy" | "sell",
  amount: number,
): { commission: number; stamp: number; transfer: number; total: number } {
  const commission = Math.max(MIN_COMMISSION, round2(amount * COMMISSION_RATE));
  const stamp = side === "sell" ? round2(amount * STAMP_RATE) : 0;
  const transfer = round2(amount * TRANSFER_RATE);
  return {
    commission,
    stamp,
    transfer,
    total: round2(commission + stamp + transfer),
  };
}

export function accountSummary(account: PaperAccount): PaperSummary {
  const marketValue = round2(account.positions.reduce((sum, item) => sum + item.marketValue, 0));
  const equity = round2(account.cash + marketValue);
  const totalPnl = round2(equity - account.initial);
  return {
    cash: round2(account.cash),
    marketValue,
    equity,
    totalPnl,
    totalPnlPct: account.initial > 0 ? round2((totalPnl / account.initial) * 100) : 0,
    realizedPnl: round2(account.realizedPnl),
    positionCount: account.positions.length,
  };
}

/** 用最新价重估持仓（不写盘；由调用方决定是否保存） */
export function markPaperAccount(
  account: PaperAccount,
  quotes: Map<string, Quote>,
): PaperAccount {
  const positions = account.positions.map((position) => {
    const price = quotes.get(position.code)?.price;
    const lastPrice = price && price > 0 ? price : position.lastPrice;
    const marketValue = round2(lastPrice * position.qty);
    const pnl = round2((lastPrice - position.avgCost) * position.qty);
    return {
      ...position,
      lastPrice,
      marketValue,
      pnl,
      // 移动止盈需要跟踪持仓期最高价；只升不降
      peakPrice: Math.max(position.peakPrice ?? position.avgCost, lastPrice),
      pnlPct:
        position.avgCost > 0 ? round2(((lastPrice - position.avgCost) / position.avgCost) * 100) : 0,
    };
  });
  return { ...account, positions, updatedAt: new Date().toISOString() };
}

/**
 * 执行一笔委托（纯函数，便于测试）。
 *
 * 只处理立即成交；限价不穿越现价时直接拒绝，不生成挂单。
 * **时段闸门不在这里**：调用方负责（`placePaperOrder` 已按 `continuousSession()`
 * 拦掉集合竞价/午休/非交易日，回测等离线场景可直接调本函数）。
 */
export function applyPaperOrder(
  account: PaperAccount,
  quote: Quote,
  request: OrderRequest,
  now = new Date(),
  limits: PaperOrderLimits = {},
): OrderResult {
  const side = request.side;
  const qty = Math.floor(request.qty);
  const fail = (message: string): OrderResult => ({ ok: false, message, account });

  if (!Number.isFinite(qty) || qty <= 0) return fail("委托数量必须是正整数");
  if (quote.price <= 0) return fail(`${quote.name || quote.code} 没有有效行情（停牌？）`);
  if (quote.stockStatus?.includes("停")) return fail(`${quote.name || quote.code} 已停牌`);

  if (side === "buy") {
    if (qty % 100 !== 0) return fail("买入必须是 100 股的整数倍");
    // 持仓只数上限：同一只加仓不受限，开新仓要求当前持仓只数 < 上限
    const cap = limits.maxPositions ?? DEFAULT_MAX_POSITIONS;
    const heldCodes = account.positions.filter((item) => item.qty > 0).map((item) => item.code);
    if (!heldCodes.includes(quote.code) && heldCodes.length >= cap) {
      return fail(
        `持仓已达上限 ${cap} 只（当前 ${heldCodes.join("、")}），` +
          `要买新股票请先减仓或清掉一只（上限可在 xzh a settings 调整）`,
      );
    }
    if (quote.limitUp && quote.price >= quote.limitUp - 0.001) {
      return fail(`${quote.name} 已涨停，模拟盘不排队买入`);
    }
  } else {
    if (quote.limitDown && quote.price <= quote.limitDown + 0.001) {
      return fail(`${quote.name} 已跌停，模拟盘不排队卖出`);
    }
    const position = account.positions.find((item) => item.code === quote.code);
    if (!position || position.qty <= 0) return fail(`没有 ${quote.name} 的持仓`);
    if (qty > position.available) {
      return fail(`可卖不足：T+1 可卖 ${position.available} 股（持仓 ${position.qty} 股）`);
    }
    // 零股只能一次性清仓
    if (qty % 100 !== 0 && qty !== position.qty) {
      return fail("零股只能一次性全部卖出");
    }
  }

  let fillPrice = quote.price;
  if (request.price !== undefined) {
    if (!Number.isFinite(request.price) || request.price <= 0) {
      return fail("限价必须是正数");
    }
    if (side === "buy" && request.price < quote.price) {
      return fail(`限价 ${request.price} 低于现价 ${quote.price}，未成交`);
    }
    if (side === "sell" && request.price > quote.price) {
      return fail(`限价 ${request.price} 高于现价 ${quote.price}，未成交`);
    }
    fillPrice = side === "buy" ? Math.min(request.price, quote.price) : Math.max(request.price, quote.price);
  }
  fillPrice = round2(fillPrice);

  const amount = round2(fillPrice * qty);
  const fees = tradingFees(side, amount);
  const next: PaperAccount = {
    ...account,
    positions: account.positions.map((item) => ({ ...item })),
    trades: [...account.trades],
    lastTradingDay: dateKey(now),
    updatedAt: now.toISOString(),
  };

  if (side === "buy") {
    const cost = round2(amount + fees.total);
    if (next.cash < cost) {
      return fail(`可用资金不足：需要 ${cost.toFixed(2)}，可用 ${next.cash.toFixed(2)}`);
    }
    next.cash = round2(next.cash - cost);
    const existing = next.positions.find((item) => item.code === quote.code);
    if (existing) {
      existing.avgCost = round2(
        (existing.avgCost * existing.qty + amount) / (existing.qty + qty),
      );
      existing.qty += qty;
      existing.lastPrice = fillPrice;
      existing.marketValue = round2(fillPrice * existing.qty);
      existing.peakPrice = Math.max(existing.peakPrice ?? fillPrice, fillPrice);
      existing.tookPartial = false;
    } else {
      next.positions.push({
        code: quote.code,
        name: quote.name,
        qty,
        available: 0,
        avgCost: fillPrice,
        lastPrice: fillPrice,
        marketValue: amount,
        pnl: 0,
        pnlPct: 0,
        peakPrice: fillPrice,
        tookPartial: false,
      });
    }
  } else {
    const position = next.positions.find((item) => item.code === quote.code)!;
    next.cash = round2(next.cash + amount - fees.total);
    next.realizedPnl = round2(next.realizedPnl + (fillPrice - position.avgCost) * qty - fees.total);
    position.qty -= qty;
    position.available -= qty;
    position.lastPrice = fillPrice;
    if (position.qty <= 0) {
      next.positions = next.positions.filter((item) => item.code !== quote.code);
    } else {
      position.marketValue = round2(fillPrice * position.qty);
      position.pnl = round2((fillPrice - position.avgCost) * position.qty);
      position.pnlPct =
        position.avgCost > 0
          ? round2(((fillPrice - position.avgCost) / position.avgCost) * 100)
          : 0;
    }
  }

  const trade: PaperTrade = {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    code: quote.code,
    name: quote.name,
    side,
    qty,
    price: fillPrice,
    amount,
    fees: fees.total,
    time: now.toISOString(),
    ...(side === "sell"
      ? {
          pnl: round2(
            (fillPrice - (account.positions.find((item) => item.code === quote.code)?.avgCost ?? fillPrice)) *
              qty -
              fees.total,
          ),
        }
      : {}),
  };
  next.trades = [...next.trades, trade].slice(-MAX_TRADES);
  return {
    ok: true,
    message:
      `${side === "buy" ? "买入" : "卖出"} ${quote.name} ${qty} 股 @ ${fillPrice}` +
      `（费用 ${fees.total.toFixed(2)}，成交额 ${amount.toFixed(2)}）`,
    account: next,
    trade,
  };
}

/** 记录「已执行过分批止盈」，避免同一波上涨反复卖一半 */
export function markPartialTaken(code: string): void {
  const account = loadPaperAccount();
  const position = account.positions.find((item) => item.code === code);
  if (!position) return;
  position.tookPartial = true;
  account.updatedAt = new Date().toISOString();
  savePaperAccount(account);
}

/**
 * 拉取最新价并落盘（工具与面板共用）。
 *
 * 只在**连续竞价时段 + 交易日**成交：集合竞价（09:15–09:25 / 09:25–09:30）、午休、
 * 盘前盘后、节假日一律拒单 —— 否则会用「昨日收盘价 / 上午收盘价」成交，
 * 模拟盘收益全是假的。想非交易时段下单请用挂单（`a_order pending: true`）。
 */
export async function placePaperOrder(
  request: OrderRequest,
  now = new Date(),
): Promise<OrderResult> {
  const gate = await continuousSession(now);
  if (!gate.open) {
    return {
      ok: false,
      message: `${gate.reason ?? "当前不可交易"}，模拟盘只在连续竞价时段成交（可挂单等开盘）`,
      account: loadPaperAccount(now),
    };
  }
  const quote = await fetchQuote(request.code);
  const account = loadPaperAccount(now);
  // 持仓只数上限取用户配置（默认 3），传给了纯函数而不是让它自己读文件 ——
  // 这样 `applyPaperOrder` 在测试里行为稳定
  const result = applyPaperOrder(account, quote, request, now, {
    maxPositions: maxPositions(),
  });
  if (result.ok) savePaperAccount(result.account);
  return result;
}
