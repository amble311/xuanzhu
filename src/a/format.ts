import { ansi, padEnd } from "../utils/ansi";
import type { Bar, Quote } from "../exchange/ashare";
import type { Indicators } from "./indicators";
import type { ScreenResult } from "./screen";
import type { MarketSnapshot, SnapshotSummary } from "./snapshot";

/**
 * A 股输出的统一格式化。
 *
 * 同一份文本既给终端（`color: true`）也给模型（`color: false`）：
 * 工具返回里混入 ANSI 会污染上下文，因此颜色只是可选装饰。
 */

export interface FormatOptions {
  color?: boolean;
}

function paint(color: boolean | undefined, sequence: string, text: string): string {
  return color ? `${sequence}${text}${ansi.reset}` : text;
}

/** A 股习惯：红涨绿跌 */
function signedPct(value: number | undefined, color?: boolean): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const text = `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  if (value > 0) return paint(color, ansi.red, text);
  if (value < 0) return paint(color, ansi.green, text);
  return paint(color, ansi.gray, text);
}

export function money(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value === 0) return "-";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return value.toFixed(0);
}

function plainPct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function formatSnapshot(
  snapshot: MarketSnapshot,
  summary: SnapshotSummary,
  options: FormatOptions = {},
): string {
  const { color } = options;
  const lines: string[] = [];
  lines.push(
    `${paint(color, ansi.bold, "市场快照")} ${paint(color, ansi.gray, `${snapshot.asOf.replace("T", " ").slice(0, 19)} · ${snapshot.session}`)}`,
  );
  const breadth =
    `上涨 ${summary.up} · 下跌 ${summary.down} · 平盘 ${summary.flat}` +
    ` · 涨停 ${summary.limitUp} · 跌停 ${summary.limitDown}` +
    (summary.suspended > 0 ? ` · 停牌/无价 ${summary.suspended}` : "") +
    ` · 成交额 ${money(summary.amount)}`;
  lines.push(breadth);

  if (snapshot.indices.length > 0) {
    lines.push(
      snapshot.indices
        .map((index) => `${index.name} ${index.price.toFixed(2)}（${signedPct(index.pct, color)}）`)
        .join(" · "),
    );
  }

  const buckets = summary.buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => `${bucket.label}:${bucket.count}`)
    .join("  ");
  if (buckets) lines.push(`分布 ${buckets}`);

  const boards = Object.entries(summary.byBoard)
    .sort((a, b) => b[1] - a[1])
    .map(([board, count]) => `${board}:${count}`)
    .join(" · ");
  if (boards) lines.push(`板块构成 ${boards}`);

  lines.push(
    paint(
      color,
      ansi.gray,
      `股票池 ${snapshot.universeSize} 只 · 有效行情 ${snapshot.rows.length} 只` +
        ` · 失败 ${snapshot.failed}` +
        (snapshot.quotesAt ? ` · 行情时间 ${snapshot.quotesAt}` : ""),
    ),
  );
  return lines.join("\n");
}

export function formatScreen(result: ScreenResult, options: FormatOptions = {}): string {
  const { color } = options;
  const condition = result.condition;
  const parts: string[] = [];
  if (condition.boards?.length) parts.push(condition.boards.join("/"));
  if (condition.pctMin !== undefined || condition.pctMax !== undefined) {
    parts.push(`涨幅 ${condition.pctMin ?? "-"}~${condition.pctMax ?? "-"}%`);
  }
  if (condition.amountMin !== undefined) parts.push(`成交额≥${money(condition.amountMin)}`);
  if (condition.turnoverMin !== undefined) parts.push(`换手≥${condition.turnoverMin}%`);
  if (condition.aboveMa20) parts.push("站上MA20");
  if (condition.nearHigh20Pct !== undefined) parts.push(`距20日高≤${condition.nearHigh20Pct}%`);
  if (condition.excludeSt !== false) parts.push("非ST");

  const lines: string[] = [];
  lines.push(
    `${paint(color, ansi.bold, "横截面筛选")} ${paint(color, ansi.gray, parts.join(" · ") || "无附加条件")}`,
  );
  lines.push(
    `匹配 ${result.matched} 只 / 行情 ${result.total} 只` +
      (result.skippedNoIndicators > 0
        ? `（另有 ${result.skippedNoIndicators} 只因缺指标跳过）`
        : "") +
      ` · 排序 ${condition.rankBy ?? "pct"} ${condition.order ?? "desc"}`,
  );

  const header = [
    padEnd("代码", 8),
    padEnd("名称", 12),
    padEnd("最新", 9),
    padEnd("涨幅", 9),
    padEnd("成交额", 10),
    padEnd("换手", 8),
    padEnd("MA20距", 9),
    "20日高距",
  ].join("");
  lines.push(paint(color, ansi.bold, header));
  for (const row of result.rows) {
    lines.push(
      [
        padEnd(row.code, 8),
        padEnd(row.name, 12),
        padEnd(row.price.toFixed(2), 9),
        padEnd(signedPct(row.pct, color), 9),
        padEnd(money(row.amount), 10),
        padEnd(row.turnoverPct === undefined ? "-" : `${row.turnoverPct.toFixed(2)}%`, 8),
        padEnd(plainPct(row.ma20Distance), 9),
        plainPct(row.high20Distance),
      ].join(""),
    );
  }
  if (result.rows.length === 0) lines.push(paint(color, ansi.gray, "（没有符合条件的股票）"));
  if (result.remaining > 0) {
    lines.push(paint(color, ansi.gray, `还有 ${result.remaining} 只未显示，用 offset 翻页。`));
  }
  return lines.join("\n");
}

export function formatQuoteTable(quotes: Quote[], options: FormatOptions = {}): string {
  const { color } = options;
  const lines: string[] = [];
  const header = [
    padEnd("代码", 8),
    padEnd("名称", 12),
    padEnd("最新", 10),
    padEnd("涨跌", 9),
    padEnd("涨跌幅", 9),
    padEnd("成交额", 10),
    "状态",
  ].join("");
  lines.push(paint(color, ansi.bold, header));
  for (const quote of quotes) {
    const change = `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}`;
    lines.push(
      [
        padEnd(quote.code, 8),
        padEnd(quote.name || "-", 12),
        padEnd(quote.price ? quote.price.toFixed(2) : "-", 10),
        padEnd(quote.change > 0 ? paint(color, ansi.red, change) : quote.change < 0 ? paint(color, ansi.green, change) : change, 9),
        padEnd(signedPct(quote.changePct, color), 9),
        padEnd(money(quote.amount), 10),
        quote.stockStatus ?? "-",
      ].join(""),
    );
  }
  return lines.join("\n");
}

export function formatBars(bars: Bar[], options: FormatOptions & { limit?: number } = {}): string {
  const { color } = options;
  const limit = Math.min(Math.max(1, options.limit ?? 120), 200);
  const rows = bars.slice(-limit);
  const lines: string[] = [];
  const header = [
    padEnd("时间", 18),
    padEnd("开", 10),
    padEnd("高", 10),
    padEnd("低", 10),
    padEnd("收", 10),
    padEnd("涨跌幅", 9),
    "成交量",
  ].join("");
  lines.push(paint(color, ansi.bold, header));
  rows.forEach((bar, index) => {
    const previous = index > 0 ? rows[index - 1].close : bar.open;
    const pct = previous > 0 ? ((bar.close - previous) / previous) * 100 : 0;
    lines.push(
      [
        padEnd(bar.time, 18),
        padEnd(bar.open.toFixed(2), 10),
        padEnd(bar.high.toFixed(2), 10),
        padEnd(bar.low.toFixed(2), 10),
        padEnd(bar.close.toFixed(2), 10),
        padEnd(signedPct(pct, color), 9),
        bar.volume ? `${(bar.volume / 10_000).toFixed(2)}万股` : "-",
      ].join(""),
    );
  });
  return lines.join("\n");
}

/** 指标摘要（个股深挖时给模型看的紧凑信息） */
export function formatIndicators(indicators: Indicators | undefined): string {
  if (!indicators) return "指标：未预计算（先运行 xzh a sync --indicators）";
  const parts = [
    `MA5 ${indicators.ma5?.toFixed(2) ?? "-"}`,
    `MA20 ${indicators.ma20?.toFixed(2) ?? "-"}`,
    `MA60 ${indicators.ma60?.toFixed(2) ?? "-"}`,
    `20日高 ${indicators.high20?.toFixed(2) ?? "-"}`,
    `20日涨幅 ${plainPct(indicators.ret20)}`,
  ];
  return `指标（${indicators.asOf}，后复权）：${parts.join(" · ")}`;
}
