import { fetchQuote, sessionKind, sessionLabel, type Quote } from "../exchange/ashare";
import { accountSummary, loadPaperAccount, markPaperAccount, type PaperAccount } from "./paper";
import { loadWatchlist } from "./watchlist";
import { aActionsPath, aServiceStatus, readPendingSells } from "./monitor";
import * as fs from "fs";
import { formatLocalTime } from "../utils/time";

/**
 * A 股右侧面板 / `/info` 的**数据采集与纯文本输出**。
 *
 * 与 btc 的 `panel-data.ts` 同理：TUI 8 秒刷新、`/info`、微信 `/info`
 * 必须看到同一套数据。刻意**不拉全市场快照**（5000+ 请求）——
 * 面板只要 6 个指数、持仓现价与自选股现价（≤20 个请求）。
 */

export interface AIndexRow {
  name: string;
  price: number;
  pct: number;
}

export interface AWatchRow {
  code: string;
  name: string;
  score: number;
  price: number;
  pct: number;
  held: boolean;
}

export interface APanelData {
  updatedAt: number;
  indices: AIndexRow[];
  account?: PaperAccount;
  watch: AWatchRow[];
  /** 最近几条巡检动作（选股 / 买卖 / 失败），最新在前 */
  lastActions: string[];
  /** T+1 锁定、已触发但今天不能卖的持仓 */
  riskLocks: Array<{ code: string; name: string; reason: string }>;
  error?: string;
}

/** 读巡检动作账本末尾几条，给「巡检」区块展示（与微信推送同源） */
function readRecentActions(limit = 4): string[] {
  try {
    const file = aActionsPath();
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 64 * 1024);
    const text = fs.readFileSync(file).toString("utf8", start);
    const lines = text.split("\n").filter(Boolean).slice(-limit).reverse();
    const actions: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          kind?: string;
          ok?: boolean;
          message?: string;
          codes?: string[];
        };
        if (entry.kind === "select") {
          const codes = entry.codes ?? [];
          if (codes.length > 0) actions.push(`选股 ${codes.length} 只：${codes.join("、")}`);
        } else if (entry.kind === "buy" || entry.kind === "sell") {
          const verb = entry.kind === "buy" ? "买入" : "卖出";
          if (entry.ok === false) actions.push(`${verb}失败：${entry.message ?? ""}`);
          else if (entry.message) actions.push(entry.message);
        }
      } catch {
        // 坏行跳过
      }
    }
    return actions;
  } catch {
    return [];
  }
}

const INDEX_LIST: Array<{ code: string; label: string }> = [
  { code: "1A0001", label: "上证" },
  { code: "399001", label: "深证" },
  { code: "399006", label: "创业板" },
  { code: "1B0300", label: "沪深300" },
  { code: "1B0905", label: "中证500" },
  { code: "1B0016", label: "上证50" },
];

/** 采集一轮面板数据（网络 + 本地文件，TUI 刷新与 /info 共用） */
export async function collectASharePanelData(): Promise<APanelData> {
  const indices = await Promise.all(
    INDEX_LIST.map(async (item) => {
      try {
        const quote = await fetchQuote(item.code);
        return { name: item.label, price: quote.price, pct: quote.changePct };
      } catch {
        return null;
      }
    }),
  );
  const indexRows: AIndexRow[] = [];
  for (const item of indices) if (item) indexRows.push(item);

  const account = loadPaperAccount();
  const heldCodes = new Set(account.positions.map((position) => position.code));

  const positionCodes = account.positions.slice(0, 10).map((position) => position.code);
  const positionQuotes = await Promise.all(
    positionCodes.map((code) => fetchQuote(code).catch(() => null)),
  );
  const map = new Map<string, Quote>();
  for (const quote of positionQuotes) if (quote) map.set(quote.code, quote);

  const watch = loadWatchlist();
  const watchQuotes = await Promise.all(
    watch.items.slice(0, 10).map((item) => fetchQuote(item.code).catch(() => null)),
  );
  const watchRows: AWatchRow[] = watch.items.slice(0, 10).map((item, index) => {
    const quote = watchQuotes[index];
    return {
      code: item.code,
      name: item.name,
      score: item.score,
      price: quote?.price ?? 0,
      pct: quote?.changePct ?? 0,
      held: heldCodes.has(item.code),
    };
  });

  return {
    updatedAt: Date.now(),
    indices: indexRows,
    account: markPaperAccount(account, map),
    watch: watchRows,
    lastActions: readRecentActions(),
    riskLocks: readPendingSells()
      .filter((item) => heldCodes.has(item.code))
      .map((item) => ({
        code: item.code,
        name: item.name,
        reason: item.reason,
      })),
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

/** `/info` 的纯文本输出（无 ANSI），TUI 对话框与微信共用 */
export function aInfoLines(data: APanelData): string[] {
  const lines: string[] = [];
  const divider = "─".repeat(28);
  lines.push(`A 股分析 · ${sessionLabel(sessionKind())}`);

  if (data.indices.length > 0) {
    lines.push(
      data.indices.map((item) => `${item.name} ${fmt(item.price)}（${signed(item.pct)}%）`).join(" · "),
    );
  }

  // 账户（与 btc 面板的「账户 / 模拟盘」对应）
  lines.push(divider);
  lines.push("账户（模拟盘）");
  const summary = data.account ? accountSummary(data.account) : undefined;
  if (!data.account || !summary) {
    lines.push("未开始（初始 1,000,000 · T+1 · 100 股整手）");
  } else {
    lines.push(
      `总资产 ${fmt(summary.equity)}（${signed(summary.totalPnlPct)}%）· 可用 ${fmt(summary.cash)}` +
        ` · 市值 ${fmt(summary.marketValue)} · 总盈亏 ${signed(summary.totalPnl)}`,
    );
    const positions = data.account.positions;
    if (positions.length === 0) {
      lines.push("持仓 无");
    } else {
      for (const position of positions) {
        lines.push(
          `  ${position.code} ${position.name} ${position.qty} 股（可卖 ${position.available}）` +
            ` 成本 ${fmt(position.avgCost)} 现价 ${fmt(position.lastPrice)}` +
            ` 盈亏 ${signed(position.pnl)}（${signed(position.pnlPct)}%）`,
        );
      }
    }
    const trades = data.account.trades.slice(-5).reverse();
    if (trades.length > 0) {
      lines.push("最近成交：");
      for (const trade of trades) {
        lines.push(
          `  ${trade.time.slice(0, 16).replace("T", " ")} ${trade.side === "buy" ? "买" : "卖"}` +
            ` ${trade.code} ${trade.qty} @ ${fmt(trade.price)}（费用 ${fmt(trade.fees)}）`,
        );
      }
    }
  }

  // 风控（对应 btc 的「风控」区块；A 股是固定规则）
  lines.push(divider);
  lines.push("风控");
  lines.push(
    "ATR 止损（1.5×ATR，下限 5%）· 浮盈 +8% 移动止盈 · +12% 分批止盈 · 最多 5 仓 × 20% · T+1",
  );
  if (data.riskLocks.length > 0) {
    lines.push(
      `  T+1 锁定 ${data.riskLocks.length} 只（今日不可卖，下一交易日处理）：` +
        data.riskLocks.map((item) => `${item.code} ${item.reason}`).join("、"),
    );
  }

  // 巡检（独立进程）
  lines.push(divider);
  lines.push("巡检");
  const service = aServiceStatus();
  lines.push(
    service.running
      ? `运行中（pid ${service.state?.pid} · 上一轮 ${formatLocalTime(service.state?.lastRunAt, "time")} · 下一轮 ${formatLocalTime(service.state?.nextCheckAt, "time") !== "—" ? formatLocalTime(service.state?.nextCheckAt, "time") : "未排期"}）`
      : "未运行（/start 或 xzh a serve）",
  );
  if (service.state?.paused) lines.push("  已暂停（进程仍在，/pause resume 恢复）");
  if (service.state?.nextCheckAt) {
    lines.push(`  下一轮排期：${formatLocalTime(service.state.nextCheckAt, "monthday")}${service.state.nextCheckReason ? `（${service.state.nextCheckReason}）` : ""}`);
  }
  lines.push(`  监控规则 ${service.state?.rules ?? 0} 条 · 排期 ${service.state?.queueSize ?? 0} 条`);
  lines.push(
    `  收盘选股：每个交易日 16:00${service.state?.lastSelectDay ? ` · 上次 ${service.state.lastSelectDay}` : ""}`,
  );
  if (service.state?.lastAction) lines.push(`  最近一轮：${service.state.lastAction}`);
  if (service.state?.lastError) lines.push(`  最近错误：${service.state.lastError}`);
  for (const action of data.lastActions.slice(0, 5)) {
    lines.push(`  ${action}`);
  }

  // 监控（自选股池，每 15 分钟）
  lines.push(divider);
  const watch = loadWatchlist();
  lines.push(`监控（自选 ${watch.items.length}/10 · 每 15 分钟 · ★=持仓）`);
  if (watch.items.length === 0) {
    lines.push("  监控池为空（xzh a serve 会自动选股）");
  }
  for (const row of data.watch) {
    const star = row.held ? "★ " : "  ";
    const price = row.price > 0 ? `${fmt(row.price)}（${signed(row.pct)}%）` : "—";
    lines.push(`  ${star}${row.code} ${row.name} ${row.score}分 ${price}`);
  }

  // 与 a_order / a_account 的口径一致，防止模型把模拟盘说成实盘
  lines.push(divider);
  lines.push("以上为模拟盘数据，不涉及真钱。");
  return lines;
}
