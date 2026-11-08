import { fetchQuote, sessionKind, sessionLabel, type Quote } from "../exchange/ashare";
import { accountSummary, loadPaperAccount, markPaperAccount, type PaperAccount } from "./paper";
import { loadWatchlist } from "./watchlist";
import { aServiceStatus } from "./monitor";

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
  error?: string;
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
  lines.push(`A 股分析 · ${sessionLabel(sessionKind())}`);

  if (data.indices.length > 0) {
    lines.push(
      data.indices.map((item) => `${item.name} ${fmt(item.price)}（${signed(item.pct)}%）`).join(" · "),
    );
  }

  const summary = data.account ? accountSummary(data.account) : undefined;
  if (!data.account || !summary) {
    lines.push("模拟盘 未开始（初始 1,000,000 · T+1 · 100 股整手）");
  } else {
    lines.push(
      `总资产 ${fmt(summary.equity)}（${signed(summary.totalPnlPct)}%）· 可用 ${fmt(summary.cash)}` +
        ` · 市值 ${fmt(summary.marketValue)} · 总盈亏 ${signed(summary.totalPnl)}`,
    );
    const positions = data.account.positions;
    if (positions.length === 0) {
      lines.push("持仓 无");
    } else {
      lines.push("持仓：");
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

  const service = aServiceStatus();
  lines.push(
    `巡检 ${service.running ? "运行中" : "未运行"}` +
      (service.running && service.state
        ? `（pid ${service.state.pid} · 自选 ${service.state.watchlist}/10 · 下一轮 ${service.state.nextRunAt}）`
        : "（xzh a serve）"),
  );
  const watch = loadWatchlist();
  if (watch.items.length > 0) {
    lines.push(
      "监控池：" +
        watch.items
          .slice(0, 10)
          .map((item) => `${item.code}(${item.score})`)
          .join("、"),
    );
  }

  // 与 a_order / a_account 的口径一致，防止模型把模拟盘说成实盘
  lines.push("以上为模拟盘数据，不涉及真钱。");
  return lines;
}
