import {
  INDICATORS_CACHE,
  accountSummary,
  formatBars,
  formatIndicators,
  formatQuoteTable,
  formatScreen,
  formatSnapshot,
  loadIndicators,
  loadPaperAccount,
  loadSnapshot,
  markPaperAccount,
  placePaperOrder,
  screenConditionFromInput,
  screenNeedsIndicators,
  screenStocks,
  summarizeSnapshot,
  addRule,
  appendAAction,
  appendRuleAudit,
  cancelOrder,
  clearRiskTrigger,
  createOrder,
  describeOrder,
  listOrders,
  readRiskState,
  readRules,
  describeRule,
  pushSchedule,
  removeRules,
  removeSchedules,
  type Indicators,
  type PaperAccount,
  type RuleKind,
} from "../a";
import { selectTopWatchlist } from "../a/score";
import { loadWatchlist, mergeWatchlist, saveWatchlist } from "../a/watchlist";
import { adjustByNews } from "../a/news";
import {
  fetchBars,
  fetchQuote,
  readCache,
  toThsSymbol,
  type Adjust,
  type BarPeriod,
  type Quote,
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

const PERIODS: BarPeriod[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "60m",
  "day",
  "week",
  "month",
  "quarter",
  "year",
];
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
    if (process.env.XZH_A_INSPECT === "1") {
      return {
        ok: false,
        content: "✗ 巡检只分析持仓与自选股，不做选股；选股由收盘后 16:00 固定任务负责。",
      };
    }
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
    "查单只 A 股的 K 线（周期 1m/5m/15m/30m/60m/day/week/month/quarter/year，可复权）。" +
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

// ─────────────────────────── 模拟盘 ───────────────────────────

function formatPaperAccount(account: PaperAccount, withTrades = true): string {
  const summary = accountSummary(account);
  const lines = [
    `模拟盘（初始 ${account.initial.toLocaleString("en-US")} · T+1 · 100 股整手）`,
    `总资产 ${summary.equity.toLocaleString("en-US")} · 可用 ${summary.cash.toLocaleString("en-US")}` +
      ` · 持仓市值 ${summary.marketValue.toLocaleString("en-US")}` +
      ` · 总盈亏 ${summary.totalPnl >= 0 ? "+" : ""}${summary.totalPnl.toLocaleString("en-US")}` +
      `（${summary.totalPnlPct >= 0 ? "+" : ""}${summary.totalPnlPct}%）`,
  ];
  if (account.positions.length === 0) {
    lines.push("持仓：无");
  } else {
    lines.push("持仓：");
    for (const position of account.positions) {
      lines.push(
        `  ${position.code} ${position.name} ${position.qty} 股（可卖 ${position.available}）` +
          ` 成本 ${position.avgCost.toFixed(2)} 现价 ${position.lastPrice.toFixed(2)}` +
          ` 盈亏 ${position.pnl >= 0 ? "+" : ""}${position.pnl.toFixed(2)}（${position.pnlPct}%）`,
      );
    }
  }
  if (withTrades) {
    const recent = account.trades.slice(-5).reverse();
    if (recent.length > 0) {
      lines.push("最近成交：");
      for (const trade of recent) {
        lines.push(
          `  ${trade.time.slice(0, 16).replace("T", " ")} ${trade.side === "buy" ? "买" : "卖"}` +
            ` ${trade.code} ${trade.name} ${trade.qty} @ ${trade.price}（费用 ${trade.fees}）`,
        );
      }
    }
  }
  return lines.join("\n");
}

const accountTool: ToolDefinition = {
  name: "a_account",
  modes: A_MODES,
  description:
    "查看 A 股模拟盘账本：总资产、可用资金、持仓（含 T+1 可卖数量）、最近成交。" +
    "模拟盘不涉及真钱，但规则与实盘一致：T+1、100 股整手、涨跌停不成交、佣金/印花税/过户费。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    try {
      const account = loadPaperAccount();
      if (account.positions.length === 0) {
        return {
          ok: true,
          content: formatPaperAccount(account),
          summary: `模拟盘总资产 ${accountSummary(account).equity}`,
        };
      }
      const codes = account.positions.slice(0, 20).map((position) => position.code);
      const quotes = await Promise.all(
        codes.map((code) => fetchQuote(code).catch(() => null)),
      );
      const map = new Map<string, Quote>();
      for (const quote of quotes) {
        if (quote) map.set(quote.code, quote);
      }
      const marked = markPaperAccount(account, map);
      return {
        ok: true,
        content: formatPaperAccount(marked),
        summary: `模拟盘总资产 ${accountSummary(marked).equity}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 读取模拟盘失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const orderTool: ToolDefinition = {
  name: "a_order",
  modes: A_MODES,
  description:
    "A 股**模拟盘**下单（立即成交，不涉及真钱）。买入必须 100 股整数倍；卖出受 T+1 可卖数量限制；" +
    "涨停不买、跌停不卖、停牌拒单；限价不穿越现价时直接拒绝（不挂单排队）。" +
    "费用：佣金 0.025%（最低 5 元）、印花税卖出 0.05%、过户费 0.001% 双边。" +
    "下单前先看 a_account 的可用资金与可卖数量。",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "股票代码" },
      side: { type: "string", enum: ["buy", "sell"], description: "买入 / 卖出" },
      qty: { type: "number", description: "股数（买入需 100 的整数倍）" },
      price: { type: "number", description: "限价；不传 = 按现价成交" },
      pending: { type: "boolean", description: "true = 挂单等待价格穿越（需要 price），默认立即成交" },
      reason: { type: "string", description: "挂单原因（可选）" },
      ttlMinutes: { type: "number", description: "挂单有效期分钟，默认 120 且不超过当日 15:00" },
    },
    required: ["code", "side", "qty"],
  },
  async execute(args): Promise<ToolResult> {
    const code = typeof args.code === "string" ? args.code : "";
    const side = args.side === "buy" || args.side === "sell" ? args.side : null;
    const qty = Number(args.qty);
    const price = args.price === undefined ? undefined : Number(args.price);
    if (!code) return { ok: false, content: "✗ 需要股票代码" };
    if (!side) return { ok: false, content: "✗ side 只能是 buy 或 sell" };
    if (!Number.isFinite(qty)) return { ok: false, content: "✗ qty 必须是数字" };
    if (price !== undefined && !Number.isFinite(price)) {
      return { ok: false, content: "✗ price 必须是数字" };
    }
    if (args.pending === true) {
      if (price === undefined || price <= 0) {
        return { ok: false, content: "✗ 挂单需要 price（限价）" };
      }
      try {
        const quote = await fetchQuote(code);
        const created = createOrder({
          code: quote.code,
          name: quote.name,
          side,
          qty,
          limitPrice: price,
          reason: typeof args.reason === "string" ? args.reason : undefined,
          ttlMinutes: args.ttlMinutes === undefined ? undefined : Number(args.ttlMinutes),
        });
        if (!created.ok) return { ok: false, content: `✗ ${created.error}` };
        appendAAction({
          kind: side,
          code,
          ok: true,
          status: "open",
          message: `挂单 ${describeOrder(created.order)}`,
          origin: process.env.XZH_A_INSPECT === "1" ? "inspect" : "manual",
        });
        return {
          ok: true,
          content: `✓ 已挂单：${describeOrder(created.order)}（${created.order.expiresAt} 前有效）`,
          summary: `挂单 ${code}`,
        };
      } catch (err) {
        return { ok: false, content: `✗ 挂单失败：${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (
      process.env.XZH_A_INSPECT === "1" &&
      side === "buy" &&
      !loadWatchlist().items.some((item) => item.code === code)
    ) {
      return {
        ok: false,
        content: `✗ 巡检只能买入自选股；${code} 不在当前自选池。选股请交给收盘后 16:00 的固定任务。`,
      };
    }
    if (side === "buy" && readRiskState()?.triggered) {
      return {
        ok: false,
        content: `✗ 硬风控已触发，禁止开新仓：${readRiskState()?.reasons.join("；") ?? ""}`,
      };
    }
    try {
      const result = await placePaperOrder({ code, side, qty, price });
      appendAAction({
        kind: side,
        code,
        ok: result.ok,
        status: result.ok ? "filled" : "rejected",
        message: result.message,
        origin: process.env.XZH_A_INSPECT === "1" ? "inspect" : "manual",
      });
      if (!result.ok) return { ok: false, content: `✗ ${result.message}` };
      return {
        ok: true,
        content: `${result.message}\n${formatPaperAccount(result.account, false)}`,
        summary: result.message,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 下单失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const newsTool: ToolDefinition = {
  name: "a_news",
  modes: A_MODES,
  description:
    "查单只 A 股近 180 天公告并给出消息面判断：硬风险否决、近 5 日利空/利好按价格反应 ±10、老利空 +2、无公告 +2。巡检分析持仓/自选股时必须先看这个消息。",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "6 位股票代码" } },
    required: ["code"],
  },
  async execute(args): Promise<ToolResult> {
    const code = typeof args.code === "string" ? args.code : "";
    if (!/^\d{6}$/.test(code)) return { ok: false, content: "✗ 需要 6 位股票代码" };
    try {
      const result = await adjustByNews(code);
      const delta = result.delta > 0 ? `+${result.delta}` : `${result.delta}`;
      return {
        ok: true,
        content:
          `${code} 消息面：${result.reason}` +
          (result.veto ? "（硬风险，禁止买入）" : `（调整 ${delta}）`),
        summary: `消息 ${code} ${result.veto ? "硬风险" : delta}`,
      };
    } catch (err) {
      return { ok: false, content: `✗ 公告查询失败：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

const selectTool: ToolDefinition = {
  name: "a_select",
  modes: A_MODES,
  description:
    "重新跑一次完整 A 股选股：全市场日线 MACD 回升 → 周线 MACD 回升 → 月线 MACD 回升 → 日线详细评分取前 10，" +
    "并把结果写入自选股（持仓强制保留）。**用户说“重新选股”时直接调这个**，不要用 a_screen + a_bars 手动模拟；" +
    "全流程约 1–2 分钟，可用 emit 看进度。",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "保留只数，默认 10（上限 10）" },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (process.env.XZH_A_INSPECT === "1") {
      return {
        ok: false,
        content: "✗ 巡检只分析持仓与自选股，不做选股；选股由收盘后 16:00 固定任务负责。",
      };
    }
    const limit = Math.max(1, Math.min(10, Number(args.limit) || 10));
    const picks = await selectTopWatchlist(limit, (message) => ctx.emit?.(message));
    const account = loadPaperAccount();
    const merged = mergeWatchlist(
      picks,
      account.positions.map((position) => ({ code: position.code, name: position.name })),
    );
    saveWatchlist(merged);
    const lines = merged.items.map(
      (item, index) => `${index + 1}. ${item.code} ${item.name} ${item.score} 分`,
    );
    return {
      ok: true,
      content:
        `✓ 选股完成：${picks.length}/10 只（不足不补），已写入自选股\n` +
        (lines.length > 0 ? lines.join("\n") : "（本次没有符合条件的股票）"),
      summary: `重新选股 ${picks.length} 只`,
    };
  },
};

// ─────────────────────────── 巡检闭环工具 ───────────────────────────

const scheduleTool: ToolDefinition = {
  name: "a_schedule",
  modes: A_MODES,
  description:
    "安排下一次 A 股巡检时间（巡检结束前必须调用）。分钟数 5–720，或直接给 at（ISO/本地时间）。" +
    "非工作时间会被自动夹到下一个工作日 09:00–15:30。slot=next 会顶掉旧的 next；extra 是额外检查点。",
  parameters: {
    type: "object",
    properties: {
      minutes: { type: "number", description: "多少分钟后巡检" },
      at: { type: "string", description: "指定时间（ISO 或 YYYY-MM-DD HH:mm）" },
      reason: { type: "string", description: "为什么这个时间再来看" },
      slot: { type: "string", enum: ["next", "extra"], description: "默认 next" },
    },
    required: ["reason"],
  },
  async execute(args): Promise<ToolResult> {
    const minutes = args.minutes === undefined ? undefined : Number(args.minutes);
    const at = typeof args.at === "string" ? args.at : undefined;
    const reason = typeof args.reason === "string" ? args.reason : "";
    if (!reason) return { ok: false, content: "✗ 需要 reason" };
    if (minutes !== undefined && !Number.isFinite(minutes)) {
      return { ok: false, content: "✗ minutes 必须是数字" };
    }
    const slot = args.slot === "extra" ? "extra" : "next";
    const entry = pushSchedule({ minutes, at, reason, slot });
    return {
      ok: true,
      content: `✓ 已排期 ${entry.at}（${entry.slot}）：${entry.reason}${entry.clamped ? "（当前非工作时段，已顺延到下一个工作日 09:00–15:30）" : ""}`,
      summary: `巡检排期 ${entry.at}`,
    };
  },
};

const triggerTool: ToolDefinition = {
  name: "a_trigger",
  modes: A_MODES,
  description:
    "给持仓/自选股设置监控规则（只叫醒，不下单）。kind: price_above / price_below / pct_above / pct_below / ma20_break / ma20_above / ret20_above / chain / formula / script。" +
    "命中后监控会唤醒巡检并说明原因；最多 20 条，默认 72 小时过期、30 分钟冷却。",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "6 位股票代码" },
      kind: {
        type: "string",
        enum: [
          "price_above",
          "price_below",
          "pct_above",
          "pct_below",
          "ma20_break",
          "ma20_above",
          "ret20_above",
          "chain",
          "formula",
          "script",
        ],
      },
      value: { type: "number", description: "price/pct 的目标值；ma20_break 不需要" },
      note: { type: "string", description: "命中时给巡检看的原因" },
      once: { type: "boolean", description: "命中一次后删除" },
      cooldownMin: { type: "number", description: "冷却分钟，默认 30" },
      ttlHours: { type: "number", description: "有效期小时，默认 72" },
      startHour: { type: "number", description: "只在几点后评估（UTC+8，0–23）" },
      endHour: { type: "number", description: "只在几点前评估（UTC+8，0–23）" },
      steps: {
        type: "array",
        description: "chain 专用：步骤数组，如 [{kind:'pct_above',value:3},{kind:'ma20_break'}]；只有最后一步满足才唤醒",
        items: { type: "object" },
      },
      chainExpireMin: { type: "number", description: "链式中间步骤有效期分钟，默认 240" },
      expression: {
        type: "string",
        description: "formula / script 专用，如 price > ma20 && pct > 2；变量 price/pct/ma5/ma20/ma60/ret5/ret20/ret60/atr_pct/amount",
      },
    },
    required: ["code", "kind", "note"],
  },
  async execute(args): Promise<ToolResult> {
    const code = typeof args.code === "string" ? args.code : "";
    const kind = args.kind as RuleKind;
    const value = args.value === undefined ? undefined : Number(args.value);
    const note = typeof args.note === "string" ? args.note : "";
    if (!note) return { ok: false, content: "✗ 需要 note（命中原因）" };
    const actor = process.env.XZH_A_INSPECT === "1" ? "inspect" : "manual";
    // 监控规则只允许覆盖持仓/自选；公式/脚本在写入时做白名单与长度审计
    const inScope =
      loadWatchlist().items.some((item) => item.code === code) ||
      loadPaperAccount().positions.some((position) => position.code === code);
    if (!inScope) {
      appendRuleAudit({
        actor,
        action: "reject",
        ok: false,
        code,
        kind,
        error: "不在持仓/自选股范围",
      });
      return { ok: false, content: `✗ ${code} 不在当前持仓/自选股，不能写监控规则` };
    }
    if ((kind === "formula" || kind === "script") && (args.expression ?? "").toString().length > 200) {
      appendRuleAudit({
        actor,
        action: "reject",
        ok: false,
        code,
        kind,
        error: "表达式超过 200 字符",
      });
      return { ok: false, content: "✗ 公式/脚本最长 200 字符" };
    }
    if (readRules().filter((rule) => rule.code === code).length >= 5) {
      appendRuleAudit({
        actor,
        action: "reject",
        ok: false,
        code,
        kind,
        error: "单只股票规则超过 5 条",
      });
      return { ok: false, content: `✗ ${code} 已有 5 条监控规则，请先清理` };
    }
    const result = addRule({
      code,
      kind,
      value,
      note,
      once: args.once === true,
      cooldownMin: args.cooldownMin === undefined ? undefined : Number(args.cooldownMin),
      ttlHours: args.ttlHours === undefined ? undefined : Number(args.ttlHours),
      windowStartHour: args.startHour === undefined ? undefined : Number(args.startHour),
      windowEndHour: args.endHour === undefined ? undefined : Number(args.endHour),
      steps: Array.isArray(args.steps) ? (args.steps as Array<{ kind: never; value?: number }>) : undefined,
      chainExpireMin: args.chainExpireMin === undefined ? undefined : Number(args.chainExpireMin),
      expression: typeof args.expression === "string" ? args.expression : undefined,
    });
    if (!result.ok) {
      appendRuleAudit({
        actor,
        action: "reject",
        ok: false,
        code,
        kind,
        error: result.error,
      });
      return { ok: false, content: `✗ ${result.error}` };
    }
    appendRuleAudit({
      actor,
      action: "add",
      ok: true,
      code: result.rule.code,
      kind: result.rule.kind,
      ruleId: result.rule.id,
      detail: result.rule.expression ?? result.rule.note,
    });
    return {
      ok: true,
      content: `✓ 已添加监控：${describeRule(result.rule)}（${result.rule.note}）`,
      summary: `监控 ${result.rule.code} ${result.rule.kind}`,
    };
  },
};

const unscheduleTool: ToolDefinition = {
  name: "a_unschedule",
  modes: A_MODES,
  description: "撤销排期：给 id 撤销一条，不给 id 清空全部。",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "排期 id；不传 = 清空" } },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const removed = removeSchedules(typeof args.id === "string" ? args.id : undefined);
    return { ok: true, content: `✓ 已撤销 ${removed} 条排期`, summary: `撤销排期 ${removed}` };
  },
};

const clearRiskTool: ToolDefinition = {
  name: "a_clear_risk",
  modes: A_MODES,
  description:
    "解除当日硬风控（仅在已减仓/风险消失后使用）。解除后 a_order 才能重新买入；不要用它绕过风控。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const state = readRiskState();
    if (!state?.triggered) return { ok: true, content: "当前没有触发的硬风控" };
    clearRiskTrigger();
    return { ok: true, content: "✓ 已解除当日硬风控（请确认已减仓）", summary: "解除硬风控" };
  },
};

const ordersTool: ToolDefinition = {
  name: "a_orders",
  modes: A_MODES,
  description: "查看当前挂单（open / filled / cancelled / expired）。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const orders = listOrders().filter((order) => order.status === "open");
    if (orders.length === 0) return { ok: true, content: "当前没有挂单" };
    return {
      ok: true,
      content: orders.map((order) => `- ${order.id} ${describeOrder(order)} ${order.reason}`).join("\n"),
      summary: `挂单 ${orders.length} 条`,
    };
  },
};

const cancelOrderTool: ToolDefinition = {
  name: "a_cancel_order",
  modes: A_MODES,
  description: "撤销一条挂单：需要 a_orders 返回的 id。",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "挂单 id" } },
    required: ["id"],
  },
  async execute(args): Promise<ToolResult> {
    const id = typeof args.id === "string" ? args.id : "";
    const result = cancelOrder(id);
    if (!result.ok) return { ok: false, content: `✗ ${result.error}` };
    appendAAction({
      kind: "cancel",
      code: result.order?.code,
      ok: true,
      status: "cancelled",
      message: `撤销挂单 ${id}`,
      origin: process.env.XZH_A_INSPECT === "1" ? "inspect" : "manual",
    });
    return { ok: true, content: `✓ 已撤销挂单 ${id}`, summary: `撤销 ${id}` };
  },
};

const removeTriggerTool: ToolDefinition = {
  name: "a_remove_trigger",
  modes: A_MODES,
  description: "删除监控规则：给 id 删一条，给 code 删该股票全部，都不给则清空。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      code: { type: "string" },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const code = typeof args.code === "string" ? args.code : undefined;
    const removed = removeRules({
      id: typeof args.id === "string" ? args.id : undefined,
      code,
    });
    appendRuleAudit({
      actor: process.env.XZH_A_INSPECT === "1" ? "inspect" : "manual",
      action: "remove",
      ok: true,
      code,
      detail: `删除 ${removed} 条`,
    });
    return { ok: true, content: `✓ 已删除 ${removed} 条监控规则`, summary: `删除规则 ${removed}` };
  },
};

export const aShareTools: ToolDefinition[] = [
  snapshotTool,
  screenTool,
  selectTool,
  newsTool,
  quoteTool,
  barsTool,
  accountTool,
  orderTool,
  scheduleTool,
  triggerTool,
  unscheduleTool,
  removeTriggerTool,
  clearRiskTool,
  ordersTool,
  cancelOrderTool,
];
