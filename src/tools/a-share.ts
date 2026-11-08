import {
  INDICATORS_CACHE,
  formatBars,
  formatIndicators,
  formatQuoteTable,
  formatScreen,
  formatSnapshot,
  loadIndicators,
  loadSnapshot,
  screenConditionFromInput,
  screenNeedsIndicators,
  screenStocks,
  summarizeSnapshot,
  type Indicators,
} from "../a";
import {
  fetchBars,
  fetchQuote,
  readCache,
  toThsSymbol,
  type Adjust,
  type BarPeriod,
} from "../exchange/ashare";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

/**
 * A 股模式的只读工具。
 *
 * 设计原则：**全市场只返回聚合与短名单**。5000+ 行的快照永远不进上下文；
 * 模型先用 `a_snapshot` 看温度、`a_screen` 拿 20 只以内的短名单，再对
 * 3–5 只做 `a_quote` / `a_bars` 深挖。
 *
 * 全部标 `modes: ["a"]`：普通会话看不到这些 schema。
 */

const A_MODES = ["a"];
const MAX_QUOTE_CODES = 10;

const PERIODS: BarPeriod[] = ["1m", "5m", "30m", "60m", "day", "week", "month", "quarter", "year"];
const ADJUSTS: Adjust[] = ["none", "forward", "backward"];

function emitProgress(
  ctx: ToolContext,
  label: string,
): (done: number, total: number) => void {
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (done !== total && now - last < 2_000) return;
    last = now;
    ctx.emit?.(`${label} ${done}/${total}`);
  };
}

function plainCode(input: string): string {
  const symbol = toThsSymbol(input);
  return symbol.symbol.replace(/^(hs_|bk_)/, "");
}

// ─────────────────────────── a_snapshot ───────────────────────────

const snapshotTool: ToolDefinition = {
  name: "a_snapshot",
  modes: A_MODES,
  description:
    "A 股全市场快照：涨跌家数、涨跌停家数、成交额、涨跌幅分布、主要指数。" +
    "第一次调用（或缓存超过 2 分钟）会抓 5000+ 只，约 30-60 秒；之后读缓存。" +
    "**任何选股判断之前先调它**，确认市场温度与数据时间。" +
    "只做个股分析，不做板块/行业分析。",
  parameters: {
    type: "object",
    properties: {
      refresh: {
        type: "boolean",
        description: "强制重新抓取（默认按 2 分钟 TTL 复用缓存）",
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const loaded = await loadSnapshot({
        refresh: args.refresh === true,
        onProgress: emitProgress(ctx, "已抓取"),
      });
      const summary = summarizeSnapshot(loaded.snapshot.rows);
      const content = [
        formatSnapshot(loaded.snapshot, summary),
        loaded.ageMs > 5 * 60 * 1000
          ? `（缓存于 ${Math.round(loaded.ageMs / 60_000)} 分钟前；需要最新数据用 refresh=true）`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        ok: true,
        content,
        summary: `上涨 ${summary.up} · 下跌 ${summary.down} · 涨停 ${summary.limitUp}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 获取全市场快照失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ─────────────────────────── a_screen ───────────────────────────

const screenTool: ToolDefinition = {
  name: "a_screen",
  modes: A_MODES,
  description:
    "横截面筛选：在全市场按条件过滤并排序，返回 20 只以内短名单（limit 上限 50）。" +
    "只接受白名单字段（涨跌幅、成交额、换手、市值、板块、ST、均线、区间涨幅、距 20 日高），" +
    "不接受 SQL / 表达式。需要均线等条件时若指标未缓存，会自动全市场预计算（约 1-2 分钟）。" +
    "选股流程：先 a_snapshot 看温度，再 a_screen 拿短名单，最后对 3-5 只用 a_quote/a_bars 深挖。",
  parameters: {
    type: "object",
    properties: {
      boards: {
        type: "array",
        items: { type: "string", enum: ["sh-main", "sz-main", "gem", "star", "bse"] },
        description: "板块过滤（主板/创业板/科创板/北交所）",
      },
      exclude_st: { type: "boolean", description: "排除 ST（默认 true）" },
      pct_min: { type: "number", description: "涨跌幅下限（%）" },
      pct_max: { type: "number", description: "涨跌幅上限（%）" },
      price_min: { type: "number", description: "价格下限（元）" },
      price_max: { type: "number", description: "价格上限（元）" },
      amount_min: { type: "number", description: "成交额下限（元）" },
      turnover_min: { type: "number", description: "换手率下限（%）" },
      market_cap_min: { type: "number", description: "总市值下限（元）" },
      market_cap_max: { type: "number", description: "总市值上限（元）" },
      above_ma5: { type: "boolean", description: "现价高于 5 日均线" },
      above_ma10: { type: "boolean", description: "现价高于 10 日均线" },
      above_ma20: { type: "boolean", description: "现价高于 20 日均线" },
      above_ma60: { type: "boolean", description: "现价高于 60 日均线" },
      ret5_min: { type: "number", description: "近 5 日涨幅下限（%）" },
      ret20_min: { type: "number", description: "近 20 日涨幅下限（%）" },
      ret20_max: { type: "number", description: "近 20 日涨幅上限（%）" },
      near_high20_pct: { type: "number", description: "距 20 日最高价不超过 N（%）" },
      rank_by: {
        type: "string",
        enum: ["pct", "amount", "turnover", "marketCap", "ret5", "ret20", "ma20Distance", "high20Distance"],
        description: "排序字段（默认 pct）",
      },
      order: { type: "string", enum: ["asc", "desc"], description: "排序方向（默认 desc）" },
      limit: { type: "number", description: "返回条数（默认 20，上限 50）" },
      offset: { type: "number", description: "翻页偏移" },
      refresh: { type: "boolean", description: "强制刷新全市场快照" },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const condition = screenConditionFromInput(args as Record<string, unknown>);
      const loaded = await loadSnapshot({
        refresh: args.refresh === true,
        onProgress: emitProgress(ctx, "已抓取"),
      });

      const needsIndicators = screenNeedsIndicators(condition);
      const indicators = needsIndicators
        ? await loadIndicators({ onProgress: emitProgress(ctx, "已计算指标") })
        : new Map<string, Indicators>();

      const result = screenStocks(loaded.snapshot, indicators, condition);
      const content = [
        formatScreen(result),
        `快照时间 ${loaded.snapshot.asOf.replace("T", " ").slice(0, 19)} · ${loaded.snapshot.session}`,
        needsIndicators && result.skippedNoIndicators > 0
          ? `提示：${result.skippedNoIndicators} 只因缺少指标被跳过；如持续偏多，运行 xzh a sync 重建指标缓存。`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        ok: true,
        content,
        summary: `匹配 ${result.matched} 只 · 返回 ${result.rows.length} 只`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 横截面筛选失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ─────────────────────────── a_quote ───────────────────────────

const quoteTool: ToolDefinition = {
  name: "a_quote",
  modes: A_MODES,
  description:
    "查 1-10 只 A 股的实时快照（最新价、涨跌幅、成交额、换手、涨停价/跌停价、停牌状态）。" +
    "短名单里挑出的个股用它核对现价；需要走势再看 a_bars。",
  parameters: {
    type: "object",
    properties: {
      codes: {
        type: "array",
        items: { type: "string" },
        description: "股票代码（6 位；指数写 1A0001）",
      },
    },
    required: ["codes"],
  },
  async execute(args): Promise<ToolResult> {
    const codes = Array.isArray(args.codes)
      ? args.codes.map((item) => String(item)).filter(Boolean)
      : [];
    if (codes.length === 0) return { ok: false, content: "✗ 需要至少一个代码" };
    if (codes.length > MAX_QUOTE_CODES) {
      return { ok: false, content: `✗ 一次最多查 ${MAX_QUOTE_CODES} 只` };
    }
    try {
      const quotes = await Promise.all(codes.map((code) => fetchQuote(code)));
      return {
        ok: true,
        content: formatQuoteTable(quotes),
        summary: `${quotes.length} 只快照`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 获取快照失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ─────────────────────────── a_bars ───────────────────────────

const barsTool: ToolDefinition = {
  name: "a_bars",
  modes: A_MODES,
  description:
    "查单只 A 股的 K 线（周期 1m/5m/30m/60m/day/week/month/quarter/year，可复权）。" +
    "默认日线 / 后复权 / 最近 120 根。指标用后复权（前复权在高分红股上早年为负）；" +
    "看真实价格用 adjust=none。返回里会附上该股的预计算指标摘要（若有缓存）。",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "股票代码" },
      period: { type: "string", enum: PERIODS, description: "周期（默认 day）" },
      adjust: { type: "string", enum: ADJUSTS, description: "复权方式（默认 backward）" },
      limit: { type: "number", description: "返回根数（默认 120，上限 200）" },
      from: { type: "string", description: "起始日期 YYYY-MM-DD" },
    },
    required: ["code"],
  },
  async execute(args): Promise<ToolResult> {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code) return { ok: false, content: "✗ 需要股票代码" };
    const period = PERIODS.includes(args.period as BarPeriod)
      ? (args.period as BarPeriod)
      : "day";
    const adjust = ADJUSTS.includes(args.adjust as Adjust)
      ? (args.adjust as Adjust)
      : "backward";
    const limit = Math.min(Math.max(1, Number(args.limit) || 120), 200);
    try {
      const bars = await fetchBars(code, {
        period,
        adjust,
        limit,
        from: typeof args.from === "string" ? args.from : undefined,
      });
      if (bars.length === 0) return { ok: false, content: "✗ 没有取到 K 线" };
      const plain = plainCode(code);
      const cached = readCache<Indicators[]>(INDICATORS_CACHE, Number.POSITIVE_INFINITY);
      const indicators = cached?.value.find((item) => item.code === plain);
      const header = `${plain} · ${period} · ${adjust} · ${bars.length} 根（${bars[0].time} ~ ${bars[bars.length - 1].time}）`;
      return {
        ok: true,
        content: [header, formatBars(bars, { limit }), formatIndicators(indicators)].join("\n"),
        summary: `${plain} ${period} ${bars.length} 根`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 获取 K 线失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const aShareTools: ToolDefinition[] = [snapshotTool, screenTool, quoteTool, barsTool];
