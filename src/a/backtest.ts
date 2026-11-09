import { fetchBars, mapLimit, type Bar } from "../exchange/ashare";
import { tradingFees } from "./paper";

/**
 * A 股日线回测（小样本、事件驱动）。
 *
 * 目的不是复刻实盘每一笔，而是回答「市场门控 / ATR 止损 / 移动止盈 / 仓位数量」
 * 这些参数到底有没有用。刻意限制在**指定股票池**（默认自选股），避免全市场
 * 拉 5000×800 根日线；结论用于筛参数，不当作收益承诺。
 *
 * 规则：
 * - 收盘出信号，下一交易日开盘成交（T+1）；
 * - 买入 100 股整手，佣金/印花税/过户费与实际一致；
 * - 止损用 1.5×ATR20（下限 5%），浮盈 8% 后移动止盈，12% 分批（可选）；
 * - 市场门控用沪深300 收盘 > MA20；
 * - 不含 30 分钟触发（历史分时不完整），用日线突破近似。
 */

export interface BacktestOptions {
  codes: string[];
  /** 回测最近多少个交易日，默认 250 */
  days?: number;
  maxPositions?: number;
  positionPct?: number;
  /** 是否启用市场门控，默认 true */
  marketGate?: boolean;
  /** 是否启用移动止盈，默认 true */
  trailing?: boolean;
  /** 是否启用 +12% 分批止盈，默认 false（便于对比） */
  partialTake?: boolean;
  /** 固定止损（不启用 ATR 时），默认 7% */
  fixedStopPct?: number;
}

export interface BacktestTrade {
  code: string;
  side: "buy" | "sell";
  date: string;
  price: number;
  qty: number;
  reason: string;
  pnl?: number;
}

export interface BacktestResult {
  codes: number;
  days: number;
  start: string;
  end: string;
  initial: number;
  final: number;
  returnPct: number;
  benchmarkPct: number;
  maxDrawdownPct: number;
  trades: BacktestTrade[];
  winRatePct: number;
  avgHoldDays: number;
}

interface Position {
  code: string;
  qty: number;
  cost: number;
  peak: number;
  tookPartial: boolean;
  buyIndex: number;
  entryDate: string;
}

interface PendingBuy {
  code: string;
  reason: string;
}

interface PendingSell {
  code: string;
  qty: number;
  reason: string;
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maAt(bars: Bar[], index: number, period: number): number | undefined {
  if (index + 1 < period) return undefined;
  const closes = bars.slice(index + 1 - period, index + 1).map((bar) => bar.close);
  return average(closes);
}

function atrAt(bars: Bar[], index: number, period = 20): number | undefined {
  if (index < 1) return undefined;
  const ranges: number[] = [];
  for (let i = Math.max(1, index - period + 1); i <= index; i += 1) {
    const bar = bars[i];
    const prev = bars[i - 1].close;
    ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev)));
  }
  return ranges.length >= period ? average(ranges) : undefined;
}

/** 把日线按周/月聚合，返回「每个周期末的 MA20」查找表 */
function aggregateMa(
  bars: Bar[],
  unit: "week" | "month",
  period = 20,
): Array<{ date: string; ma?: number }> {
  const groups: Array<{ key: string; date: string; closes: number[] }> = [];
  for (const bar of bars) {
    const date = bar.time.slice(0, 10);
    const parsed = new Date(`${date}T00:00:00Z`);
    const key =
      unit === "month"
        ? date.slice(0, 7)
        : `${parsed.getUTCFullYear()}-W${Math.ceil(
            ((parsed.getTime() - Date.UTC(parsed.getUTCFullYear(), 0, 1)) / 86_400_000 +
              new Date(Date.UTC(parsed.getUTCFullYear(), 0, 1)).getUTCDay() +
              1) /
              7,
          )}`;
    const last = groups[groups.length - 1];
    if (!last || last.key !== key) groups.push({ key, date, closes: [bar.close] });
    else {
      last.closes.push(bar.close);
      last.date = date;
    }
  }
  return groups.map((group, index) => ({
    date: group.date,
    ma:
      index + 1 >= period
        ? average(groups.slice(index + 1 - period, index + 1).map((item) => item.closes[item.closes.length - 1]))
        : undefined,
  }));
}

function maForDate(table: Array<{ date: string; ma?: number }>, date: string): number | undefined {
  let value: number | undefined;
  for (const row of table) {
    if (row.date > date) break;
    value = row.ma;
  }
  return value;
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0] ?? 0;
  let worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.min(worst, (value - peak) / peak);
  }
  return worst * 100;
}

export function backtestMetrics(
  equity: number[],
  initial: number,
  benchmark: number[],
  trades: BacktestTrade[],
  holdDays: number[],
): Pick<BacktestResult, "final" | "returnPct" | "benchmarkPct" | "maxDrawdownPct" | "winRatePct" | "avgHoldDays"> {
  const final = equity[equity.length - 1] ?? initial;
  const benchmarkPct =
    benchmark.length > 1 && benchmark[0] > 0
      ? ((benchmark[benchmark.length - 1] - benchmark[0]) / benchmark[0]) * 100
      : 0;
  const closed = trades.filter((trade) => trade.side === "sell" && typeof trade.pnl === "number");
  const wins = closed.filter((trade) => (trade.pnl ?? 0) > 0).length;
  return {
    final,
    returnPct: ((final - initial) / initial) * 100,
    benchmarkPct,
    maxDrawdownPct: maxDrawdown(equity),
    winRatePct: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    avgHoldDays: holdDays.length > 0 ? holdDays.reduce((sum, value) => sum + value, 0) / holdDays.length : 0,
  };
}

export async function runBacktest(options: BacktestOptions): Promise<BacktestResult> {
  const codes = [...new Set(options.codes.map((code) => code.trim()).filter(Boolean))];
  if (codes.length === 0) throw new Error("回测需要至少一个股票代码");
  const days = Math.max(60, options.days ?? 250);
  const maxPositions = Math.max(1, options.maxPositions ?? 5);
  const positionPct = Math.min(0.5, Math.max(0.05, options.positionPct ?? 0.2));
  const marketGate = options.marketGate !== false;
  const trailing = options.trailing !== false;
  const partialTake = options.partialTake === true;
  const fixedStopPct = (options.fixedStopPct ?? 7) / 100;

  // 月线 MA20 需要 ~20 个月（约 420 个交易日），所以至少取 800 根；
  // 只对指定股票池拉取，不会变成全市场请求。
  const historyLimit = Math.max(800, days + 400);
  const [indexBars, stockBars] = await Promise.all([
    fetchBars("1B0300", { period: "day", adjust: "none", limit: historyLimit }),
    mapLimit(codes, async (code) => {
      try {
        return {
          code,
          bars: await fetchBars(code, { period: "day", adjust: "backward", limit: historyLimit }),
        };
      } catch {
        return { code, bars: [] as Bar[] };
      }
    }, 4),
  ]);

  const indexCloseByDate = new Map(indexBars.map((bar) => [bar.time.slice(0, 10), bar.close]));
  const axis = indexBars
    .map((bar) => bar.time.slice(0, 10))
    .slice(-days)
    .filter((date) => codes.some((code) => stockBars.find((entry) => entry.code === code)?.bars.some((bar) => bar.time.startsWith(date))));
  if (axis.length < 30) throw new Error("历史数据不足，无法回测");

  const prepared = stockBars.map((entry) => {
    const bars = entry.bars;
    return {
      code: entry.code,
      bars,
      byDate: new Map(bars.map((bar, index) => [bar.time.slice(0, 10), index])),
      weekly: aggregateMa(bars, "week"),
      monthly: aggregateMa(bars, "month"),
    };
  });

  let cash = 1_000_000;
  const initial = cash;
  const positions = new Map<string, Position>();
  const pendingBuys: PendingBuy[] = [];
  const pendingSells: PendingSell[] = [];
  const trades: BacktestTrade[] = [];
  const holdDays: number[] = [];
  const equityCurve: number[] = [];
  const benchmarkCurve: number[] = [];

  for (let dayIndex = 0; dayIndex < axis.length; dayIndex += 1) {
    const date = axis[dayIndex];

    // 开盘：先执行卖单，再执行买单
    for (const order of pendingSells.splice(0)) {
      const stock = prepared.find((item) => item.code === order.code);
      const position = positions.get(order.code);
      const barIndex = stock?.byDate.get(date);
      if (!stock || !position || barIndex === undefined) continue;
      const bar = stock.bars[barIndex];
      if (bar.open <= 0) continue;
      const qty = Math.min(order.qty, position.qty);
      if (qty <= 0) continue;
      const amount = bar.open * qty;
      const fees = tradingFees("sell", amount);
      cash += amount - fees.total;
      const cost = position.cost;
      position.qty -= qty;
      holdDays.push(dayIndex - position.buyIndex);
      trades.push({
        code: order.code,
        side: "sell",
        date,
        price: bar.open,
        qty,
        reason: order.reason,
        pnl: (bar.open - cost) * qty - fees.total,
      });
      if (position.qty <= 0) positions.delete(order.code);
    }

    for (const order of pendingBuys.splice(0)) {
      if (positions.size >= maxPositions || positions.has(order.code)) continue;
      const stock = prepared.find((item) => item.code === order.code);
      const barIndex = stock?.byDate.get(date);
      if (!stock || barIndex === undefined) continue;
      const bar = stock.bars[barIndex];
      if (bar.open <= 0) continue;
      const prevClose = barIndex > 0 ? stock.bars[barIndex - 1].close : bar.open;
      if (bar.open >= prevClose * 1.098) continue; // 开盘接近涨停，买不到
      const equity = cash + [...positions.entries()].reduce((sum, [code, position]) => {
        const item = prepared.find((entry) => entry.code === code);
        const idx = item?.byDate.get(date);
        const price = idx !== undefined && item ? item.bars[idx].close : position.cost;
        return sum + price * position.qty;
      }, 0);
      let qty = Math.floor((equity * positionPct) / bar.open / 100) * 100;
      qty = Math.min(qty, Math.floor((cash - 10) / bar.open / 100) * 100);
      if (qty < 100) continue;
      const amount = bar.open * qty;
      const fees = tradingFees("buy", amount);
      if (cash < amount + fees.total) continue;
      cash -= amount + fees.total;
      positions.set(order.code, {
        code: order.code,
        qty,
        cost: bar.open,
        peak: bar.open,
        tookPartial: false,
        buyIndex: dayIndex,
        entryDate: date,
      });
      trades.push({
        code: order.code,
        side: "buy",
        date,
        price: bar.open,
        qty,
        reason: order.reason,
      });
    }

    // 收盘：更新峰值、评估卖出、收集买入信号
    for (const [code, position] of positions) {
      const stock = prepared.find((item) => item.code === code);
      const barIndex = stock?.byDate.get(date);
      if (!stock || barIndex === undefined) continue;
      const bar = stock.bars[barIndex];
      position.peak = Math.max(position.peak, bar.close);
      if (dayIndex <= position.buyIndex) continue; // T+1

      const atr = atrAt(stock.bars, barIndex);
      const atrPct = atr && bar.close > 0 ? atr / bar.close : 0.035;
      const stopPct = Math.max(0.05, (atr ? 1.5 * atrPct : fixedStopPct));
      let stop = position.cost * (1 - stopPct);
      if (trailing && position.peak >= position.cost * 1.08) {
        stop = Math.max(stop, position.peak * (1 - stopPct));
      }

      if (
        partialTake &&
        !position.tookPartial &&
        position.peak >= position.cost * 1.12 &&
        bar.close >= position.cost * 1.08
      ) {
        const half = Math.floor(position.qty / 2 / 100) * 100;
        if (half >= 100) {
          pendingSells.push({ code, qty: half, reason: "分批止盈" });
          position.tookPartial = true;
        }
      } else if (bar.close <= stop) {
        pendingSells.push({
          code,
          qty: position.qty,
          reason: stop >= position.cost ? "移动止盈" : "ATR 止损",
        });
      }
    }

    // 买入信号：市场门控 + 月/周/日趋势 + 相对强度
    const indexIndex = indexBars.findIndex((bar) => bar.time.startsWith(date));
    const indexMa20 = indexIndex >= 0 ? maAt(indexBars, indexIndex, 20) : undefined;
    const indexClose = indexCloseByDate.get(date);
    const gateOn = !marketGate || (indexClose !== undefined && indexMa20 !== undefined && indexClose > indexMa20);
    if (gateOn && positions.size + pendingBuys.length < maxPositions) {
      const candidates: Array<{ code: string; rank: number; reason: string }> = [];
      for (const item of prepared) {
        if (positions.has(item.code) || pendingBuys.some((order) => order.code === item.code)) continue;
        const barIndex = item.byDate.get(date);
        if (barIndex === undefined || barIndex < 60) continue;
        const bar = item.bars[barIndex];
        const ma20 = maAt(item.bars, barIndex, 20);
        const ret20 = barIndex >= 20 ? ((bar.close - item.bars[barIndex - 20].close) / item.bars[barIndex - 20].close) * 100 : undefined;
        const weeklyMa = maForDate(item.weekly, date);
        const monthlyMa = maForDate(item.monthly, date);
        if (!ma20 || ret20 === undefined || ret20 <= 0) continue;
        if (bar.close <= ma20 || (bar.close - ma20) / ma20 > 0.08) continue;
        if (weeklyMa !== undefined && bar.close <= weeklyMa) continue;
        if (monthlyMa !== undefined && bar.close <= monthlyMa) continue;
        // 同花顺 all.js 不保证带成交额：缺失时用 收盘价×成交量 估算
        const amount =
          average(
            item.bars
              .slice(Math.max(0, barIndex - 20), barIndex)
              .map((row) => row.amount ?? row.close * row.volume),
          ) ?? 0;
        if (amount < 50_000_000) continue;
        candidates.push({
          code: item.code,
          rank: ret20 + Math.min(5, amount / 200_000_000),
          reason: `日线突破 ret20=${ret20.toFixed(1)}%`,
        });
      }
      candidates.sort((a, b) => b.rank - a.rank);
      for (const candidate of candidates.slice(0, Math.max(1, maxPositions - positions.size))) {
        pendingBuys.push({ code: candidate.code, reason: candidate.reason });
      }
    }

    // 当日收盘净值
    let equity = cash;
    for (const [code, position] of positions) {
      const item = prepared.find((entry) => entry.code === code);
      const index = item?.byDate.get(date);
      const price = index !== undefined && item ? item.bars[index].close : position.cost;
      equity += price * position.qty;
    }
    equityCurve.push(equity);
    const firstIndex = indexBars.findIndex((bar) => bar.time.startsWith(axis[0]));
    const currentIndex = indexBars.findIndex((bar) => bar.time.startsWith(date));
    benchmarkCurve.push(
      firstIndex >= 0 && currentIndex >= 0 ? indexBars[currentIndex].close : 0,
    );
  }

  const metrics = backtestMetrics(equityCurve, initial, benchmarkCurve, trades, holdDays);
  return {
    codes: prepared.filter((item) => item.bars.length > 0).length,
    days,
    start: axis[0],
    end: axis[axis.length - 1],
    initial,
    trades,
    ...metrics,
  };
}
