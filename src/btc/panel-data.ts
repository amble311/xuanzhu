import { activeExchange } from "../exchange";
import { fetchAccountSnapshot, type AccountSnapshot } from "./account";
import { runRunner } from "./python";
import { readActions, type BtcAction } from "./actions";
import { liveBackend } from "./daemon";
import { describeTrigger, readTriggers, type Trigger } from "./triggers";
import { readPause } from "./pause";
import { readScheduleQueue, type ScheduleEntry } from "./schedule";
import { readRiskSettings, readRiskState, type HardRiskSettings, type HardRiskState } from "./risk";
import { buildPreflight, liquidationGapPct } from "./preflight";
import { formatLocalTime } from "../utils/time";

/**
 * btc 右侧面板 / `/info` 的**数据采集**（渲染在 TUI 与纯文本两个渠道各自做）。
 *
 * 抽成独立模块的原因：TUI 的 8 秒刷新、`/info` 命令、微信 `/info` 必须看到
 * 同一套数据 —— 账户接口有频率权重，采集逻辑只能有一份。
 */

/** 模拟盘面板数据（来自 Python 的 paper-status） */
export interface PaperPanelData {
  price: number;
  initial_capital: number;
  cash: number;
  available?: number;
  margin_used?: number;
  equity: number;
  return_pct: number;
  position: {
    side: string;
    qty: number;
    entry_price: number;
    /** 合约倍率（旧脚本可能没有） */
    leverage?: number;
    unrealized: number;
    unrealized_pct: number;
    stop_price: number | null;
  } | null;
  /** 未成交的限价挂单 */
  open_orders?: Array<{
    id: number;
    side: string;
    qty: number;
    limit_price: number;
  }>;
  trades: number;
  win_rate: number;
  realized_pnl: number;
  /** 价格来源：mark = 实时标记价，close = 库内收盘价（可能滞后） */
  price_source?: "mark" | "close";
  /** 最近已平仓交易（面板 /info 展示） */
  recent_trades?: Array<{
    side: string;
    qty: number;
    entry_price: number;
    exit_price: number;
    pnl: number;
    exit_ts: string;
  }>;
}

export interface BtcPanelData {
  updatedAt: number;
  /** 观察（真实账户）还是模拟盘 —— 决定右栏展示哪套数据 */
  role: "live" | "paper";
  ticker: { price: number; changePct: number } | null;
  /** 取价失败的原因（面板直接显示，别让它只显示「不可用」） */
  tickerError?: string;
  /** 后端是否被 `/stop` 暂停 */
  paused: boolean;
  account: AccountSnapshot | null;
  /** 持仓没有任何止损/止盈单 */
  unprotected?: boolean;
  /** 持仓距强平的最小百分比（无持仓为 undefined） */
  liqGapPct?: number;
  paper: PaperPanelData | null;
  paperError?: string;
  queue: ScheduleEntry[];
  riskState: HardRiskState;
  riskSettings: HardRiskSettings;
  /** 当前启用的叫醒条件（面板展示前几条） */
  triggers: Trigger[];
  /** 后端算出的下次触发器评估时间（ISO） */
  nextTriggerEvalAt?: string;
  /** 后端进程是否在跑（旧版后端不会上报 nextTriggerEvalAt，需要区分「没跑」与「没上报」） */
  backendRunning: boolean;
  /** 行情连续失败次数（后端 health check 上报） */
  marketFailures?: number;
  lastMarketError?: string;
  /** 最近几条真实交易动作（实盘用；模拟盘看 paper.recent_trades） */
  actions: BtcAction[];
  /** 采集时的 btc home（= TUI cwd / 后端工作目录） */
  home: string;
}

/** 采集一轮面板数据（网络 + 本地文件，TUI 刷新与 /info 共用） */
export async function collectBtcPanelData(
  home: string,
  role: "live" | "paper",
): Promise<BtcPanelData> {
  const symbol = process.env.BTC_SYMBOL?.trim() || "BTC/USDT";
  let ticker: { price: number; changePct: number } | null = null;
  let tickerError: string | undefined;
  try {
    const raw = await activeExchange().exchange.fetchTicker(symbol);
    ticker = { price: raw.price, changePct: raw.changePct ?? 0 };
  } catch (err) {
    tickerError = err instanceof Error ? err.message : String(err);
  }

  const backend = liveBackend(home, role);
  const base = {
    updatedAt: Date.now(),
    paused: readPause(home).paused,
    role,
    ticker,
    tickerError,
    queue: readScheduleQueue(home, role),
    riskState: readRiskState(home),
    riskSettings: readRiskSettings(home),
    triggers: readTriggers(home, role),
    // 后端把「下次评估时间」写进 state；旧版后端没有这个字段，面板要能区分「没跑」与「没上报」
    nextTriggerEvalAt: backend?.nextTriggerEvalAt,
    backendRunning: backend !== null,
    marketFailures: backend?.marketFailures ?? 0,
    lastMarketError: backend?.lastMarketError,
    actions: readActions(home).slice(-4).reverse(),
    home,
  };

  if (role === "paper") {
    // 模拟盘不能读真实账户：那是两套账，混在一起会让人误判。
    // 传入实时标记价：否则顶部是实时价、浮盈按库内旧收盘价算，看起来就是「价格跌了却在亏」。
    const paper = await runRunner<PaperPanelData>("paper-status", {
      mark_price: ticker?.price,
    });
    return {
      ...base,
      account: null,
      paper: paper.ok ? paper.data : null,
      paperError: paper.ok ? undefined : paper.error,
    };
  }

  const account = await fetchAccountSnapshot();
  // 与巡检用同一套核对逻辑：面板和后台看到的风险必须一致
  const preflight = buildPreflight({
    snapshot: account,
    actions: readActions(home),
  });
  const gaps = account.positions
    .map((position) => liquidationGapPct(position))
    .filter((gap): gap is number => gap !== null);
  return {
    ...base,
    account,
    unprotected: preflight.unprotected,
    liqGapPct: gaps.length > 0 ? Math.min(...gaps) : undefined,
    paper: null,
  };
}

function fmt(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : ""}${fmt(value, digits)}`;
}

/**
 * `/info` 的纯文本输出（无 ANSI）：内容与右侧面板一致。
 * TUI 对话框与微信回复共用；微信侧发送前无需再处理。
 */
export function btcInfoLines(data: BtcPanelData): string[] {
  const lines: string[] = [];
  const divider = "─".repeat(28);
  const roleLabel = data.role === "paper" ? "BTC 模拟盘" : "BTC 量化交易（实盘）";
  lines.push(
    `${roleLabel}${data.paused ? " · 已暂停" : ""} · 后端${data.backendRunning ? "运行中" : "未运行"}` +
      ` · 排期 ${data.queue.length} 条`,
  );

  if (data.ticker) {
    lines.push(`价格 ${fmt(data.ticker.price)}（${signed(data.ticker.changePct)}%）`);
  } else {
    lines.push(`价格 —（行情接口不可用${data.tickerError ? `：${data.tickerError}` : ""}）`);
  }

  lines.push(divider);
  lines.push(data.role === "paper" ? "模拟盘" : "账户");

  if (data.role === "paper") {
    const paper = data.paper;
    if (!paper) {
      lines.push(`未就绪：${data.paperError ?? "未知原因"}`);
    } else {
      lines.push(
        `权益 ${fmt(paper.equity)}（${signed(paper.return_pct)}%）· 可用 ${fmt(paper.available ?? paper.cash)}` +
          ` · 占用 ${fmt(paper.margin_used ?? 0)}`,
      );
      if (paper.position) {
        const p = paper.position;
        lines.push(
          `持仓 ${p.side === "long" ? "多" : "空"} ${p.qty} @ ${fmt(p.entry_price)}` +
            `${p.leverage ? ` ${p.leverage}x` : ""} · 浮盈 ${signed(p.unrealized)}（${signed(p.unrealized_pct)}%）` +
            `${p.stop_price ? ` · 止损 ${fmt(p.stop_price)}` : ""}`,
        );
      } else {
        lines.push("持仓 无");
      }
      const pending = paper.open_orders ?? [];
      if (pending.length === 0) {
        lines.push("挂单 无");
      } else {
        lines.push(
          `挂单 ${pending.length} 条：` +
            pending
              .slice(0, 3)
              .map((order) => `${order.side === "long" ? "买" : "卖"} ${fmt(order.limit_price)} × ${order.qty}`)
              .join("；"),
        );
      }
      lines.push(
        `已平仓 ${paper.trades} 笔 · 胜率 ${paper.win_rate}% · 盈亏 ${signed(paper.realized_pnl)}`,
      );
    }
  } else if (!data.account || !data.account.ok) {
    lines.push(`未连接：${data.account?.error ?? "未知原因"}`);
  } else {
    const account = data.account;
    if (account.wallet) {
      lines.push(
        `权益 ${fmt(account.wallet.total)} · 可用 ${fmt(account.wallet.available)} · 浮盈 ${signed(account.wallet.unrealized)}`,
      );
      if (account.positions.length === 0) lines.push("持仓 无");
      for (const position of account.positions) {
        lines.push(
          `持仓 ${position.side === "long" ? "多" : "空"} ${position.qty} @ ${fmt(position.entryPrice)} ` +
            `${position.leverage}x · 浮盈 ${signed(position.unrealized)}（${signed(position.roePct)}%）` +
            ` · 强平 ${fmt(position.liquidationPrice)}`,
        );
      }
      if (account.orders.length === 0) lines.push("挂单 无");
      for (const order of account.orders.slice(0, 5)) {
        lines.push(
          `挂单 ${order.side === "buy" ? "买" : "卖"} ${fmt(order.price)} × ${order.qty}` +
            `${order.reduceOnly ? "（只减仓）" : ""}`,
        );
      }
    }
    if (data.unprotected) lines.push("⚠ 有持仓未挂止损/止盈单");
    if (data.liqGapPct !== undefined) lines.push(`距强平最小 ${fmt(data.liqGapPct)}%`);
  }

  lines.push(divider);
  lines.push("风控");
  lines.push(
    `${data.riskState.triggered ? "已触发" : "正常"}` +
      ` · 单仓亏损 ${data.riskSettings.maxPositionLossPct}% · 当日 ${data.riskSettings.maxDailyLossPct}%`,
  );

  lines.push(divider);
  lines.push(`监控（叫醒条件 ${data.triggers.length} 条）`);
  for (const trigger of data.triggers.slice(0, 5)) {
    lines.push(`- ${describeTrigger(trigger)}`);
  }
  if (data.marketFailures) {
    lines.push(`行情连续失败 ${data.marketFailures} 次${data.lastMarketError ? `：${data.lastMarketError}` : ""}`);
  }

  lines.push(divider);
  lines.push(`巡检（排期 ${data.queue.length} 条）`);
  if (data.nextTriggerEvalAt) {
    lines.push(`下次叫醒评估 ${formatLocalTime(data.nextTriggerEvalAt, "monthday")}`);
  }
  for (const entry of data.queue.slice(0, 3)) {
    lines.push(`- ${formatLocalTime(entry.at, "monthday")} ${entry.reason}`);
  }

  if (data.role === "live" && data.actions.length > 0) {
    lines.push(divider);
    lines.push("最近动作");
    for (const action of data.actions) {
      lines.push(
        `- ${formatLocalTime(action.ts, "monthday")} ${action.kind} ${action.symbol} ${action.status}（${action.reason}）`,
      );
    }
  }

  return lines;
}
