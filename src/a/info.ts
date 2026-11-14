import { fetchQuote, sessionKind, sessionLabel, type Quote } from "../exchange/ashare";
import { accountSummary, loadPaperAccount, markPaperAccount, type PaperAccount } from "./paper";
import { loadWatchlist } from "./watchlist";
import { maxPositions, poolSize } from "./settings";
import { describeRule, readRules } from "./rules";
import { readScheduleQueue } from "./schedule";
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

/** 面板 / `/info` 只展示今天的成交；历史用 `/tr` 查 */
function isToday(iso: string, now = new Date()): boolean {
  const date = new Date(iso);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
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
    // 只展示今天的成交：旧成交会让「账户」看起来像流水账，历史请用 /tr
    const trades = data.account.trades.filter((trade) => isToday(trade.time)).slice(-5).reverse();
    lines.push("今日成交（完整记录用 /tr）：");
    if (trades.length === 0) {
      lines.push("  今日无");
    }
    for (const trade of trades) {
      lines.push(
        `  ${formatLocalTime(trade.time, "datetime")} ${trade.side === "buy" ? "买" : "卖"}` +
          ` ${trade.code} ${trade.qty} @ ${fmt(trade.price)}（费用 ${fmt(trade.fees)}）` +
          (trade.pnl !== undefined ? ` 盈亏 ${signed(trade.pnl)}` : ""),
      );
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

  // 巡检（独立进程）：与 btc 面板同款 —— 先写下一轮时间、倒计时与原因
  lines.push(divider);
  lines.push("巡检");
  const service = aServiceStatus();
  const queue = readScheduleQueue();
  if (!service.running) {
    lines.push("  未运行（/start 或 xzh a start）");
  } else {
    if (service.state?.paused) {
      // 暂停时排期不会执行：只报数量，不显示倒计时
      lines.push("  已暂停（/pause resume 恢复）");
      lines.push(`  排期 ${queue.length} 条（恢复后继续）`);
    } else {
      if (queue.length === 0) {
        lines.push("  无排期（每 30 秒检查规则/风控，兜底每小时一轮）");
      }
      for (const entry of queue.slice(0, 2)) {
        const wait = Math.max(
          0,
          Math.round((Date.parse(entry.at) - Date.now()) / 60_000),
        );
        lines.push(
          `  ${formatLocalTime(entry.at, "monthday")} · ${wait} 分钟后` +
            `${entry.slot === "extra" ? "（额外）" : ""}` +
            `${entry.reason ? `（${entry.reason}）` : ""}`,
        );
      }
    }
    lines.push(
      `  进程运行中（pid ${service.state?.pid ?? "?"}）` +
        ` · 规则 ${service.state?.rules ?? 0} 条 · 排期 ${queue.length} 条`,
    );
    const last = service.state?.lastInspectAt ?? service.state?.lastRunAt;
    if (last) {
      lines.push(
        `  上一轮：${formatLocalTime(last, "monthday")}` +
          `${service.state?.lastInspectReason ? `（${service.state.lastInspectReason}）` : ""}`,
      );
    }
  }
  lines.push(
    `  收盘选股：每个交易日 16:00${service.state?.lastSelectDay ? ` · 上次 ${service.state.lastSelectDay}` : ""}`,
  );
  if (service.state?.lastAction) lines.push(`  最近一轮：${service.state.lastAction}`);
  if (service.state?.lastError) lines.push(`  最近错误：${service.state.lastError}`);
  for (const action of data.lastActions.slice(0, 5)) {
    lines.push(`  ${action}`);
  }

  // 监控：规则才是唤醒源；自选股单独展示，避免把“股票名称”误当成监控内容
  lines.push(divider);
  const rules = readRules();
  lines.push(`监控规则 ${rules.length} 条（命中只唤醒巡检，不直接下单）`);
  if (rules.length === 0) {
    lines.push("  暂无规则；巡检会按排期 / 风控 / 市场事件唤醒，可用 a_trigger 添加条件");
  }
  for (const rule of rules) {
    lines.push(`  ${describeRule(rule)}${rule.note ? ` — ${rule.note}` : ""}`);
  }

  lines.push(divider);
  const watch = loadWatchlist();
  lines.push(
    `自选池 ${watch.items.length}/${poolSize()} · 持仓上限 ${maxPositions()} 只 · ★=持仓`,
  );
  if (watch.items.length === 0) {
    lines.push("  为空；收盘后 16:00 自动选股");
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

/**
 * `/tr` 的纯文本输出：最近 N 笔模拟盘成交（最新在前）。
 *
 * 只读本地账本（`paper.json`），不拉行情 —— 交易记录要能离线、秒开。
 */
export function aTradeLines(limit = 20): string[] {
  const shown = Math.min(100, Math.max(1, Math.floor(limit) || 20));
  const account = loadPaperAccount();
  const lines = ["A 股交易记录（模拟盘 · 最新在前）"];
  if (account.trades.length === 0) {
    lines.push("暂无成交记录。");
    return lines;
  }
  for (const trade of account.trades.slice(-shown).reverse()) {
    lines.push(
      `${formatLocalTime(trade.time, "datetime")}  ${trade.side === "buy" ? "买入" : "卖出"}` +
        ` ${trade.code} ${trade.name} ${trade.qty} 股 @ ${fmt(trade.price)}` +
        `  金额 ${fmt(trade.amount)}（费用 ${fmt(trade.fees)}）` +
        (trade.pnl !== undefined ? `  盈亏 ${signed(trade.pnl)}` : ""),
    );
  }
  const summary = accountSummary(account);
  lines.push(
    `共 ${account.trades.length} 笔 · 已实现盈亏 ${signed(summary.realizedPnl)}` +
      ` · 总资产 ${fmt(summary.equity)}（${signed(summary.totalPnlPct)}%）`,
  );
  return lines;
}
