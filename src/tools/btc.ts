import { activeExchange, type KlineInterval } from "../exchange";
import {
  btcPythonPath,
  btcScriptsReady,
  btcVenvReady,
  ensureBtcAssets,
} from "../btc/bootstrap";
import { fetchAccountSnapshot } from "../btc/account";
import { syncMarketData } from "../btc/market-data";
import {
  cancelOrders,
  closePosition,
  openPosition,
  transferProfitToSpot,
} from "../btc/trading";
import { runRunner } from "../btc/python";
import {
  currentScheduleRole,
  pushSchedule,
  removeSchedules,
} from "../btc/schedule";
import {
  appendPolicy,
  clearPolicy,
  readPolicy,
  replacePolicy,
} from "../btc/policy";
import { getBtcHome } from "../modes";
import type { ToolDefinition, ToolResult } from "./types";

/**
 * btc 模式的交易工具。
 *
 * 分工（这也是「xzh 当常驻后端」的落地方式）：
 * - **Node 侧**：网络（交易所行情，经 `src/exchange` 适配层）、分页、时间窗口、错误归类；
 * - **Python 侧**：指标、三阶段信号、回测（pandas），只依赖 numpy + pandas；
 * - **数据**：`~/.btc/data/btc.db`，只由 Python 读写（时间戳口径集中在一处）。
 *
 * 所有工具都标了 `modes: ["btc"]`：普通 xzh 会话看不到、也执行不了它们。
 */

const BTC_MODES = ["btc"];

interface BtcStatusData {
  symbol: string;
  db_path: string;
  python: string;
  pandas: string;
  start_date: string;
  timeframes: Record<
    string,
    { bars: number; last_ts: number | null; last_utc: string | null }
  >;
  risk: Record<string, unknown>;
}

interface BacktestData {
  symbol: string;
  bars: number;
  first: string;
  last: string;
  params: Record<string, unknown>;
  overrides: Record<string, unknown>;
  metrics: Record<string, number | null>;
  targets: Record<string, boolean>;
  recent_trades: Array<Record<string, unknown>>;
  trade_count: number;
}

function describeEnv(home: string): string[] {
  const lines = [`工作目录：${home}`];
  if (!btcScriptsReady(home)) {
    lines.push("计算脚本：✗ 未释放（assets 缺失）");
  } else if (!btcVenvReady(home)) {
    lines.push(
      `计算脚本：✓ 已释放\n计算环境：✗ 未安装（${btcPythonPath(home)} 不存在）\n` +
        "  → 运行 `xzh btc setup` 创建 venv 并安装 numpy + pandas",
    );
  } else {
    lines.push("计算脚本：✓ 已释放\n计算环境：✓ 已就绪");
  }
  return lines;
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function formatSignal(data: unknown): string {
  const payload = JSON.stringify(data, null, 2);
  const clipped =
    payload.length > 12_000
      ? `${payload.slice(0, 12_000)}\n…（已截断，完整快照可再看一次或查库）`
      : payload;
  return (
    "三阶段买卖点（周线定势 → 日线定向 → 小时线定时）：\n\n" +
    `${clipped}\n\n` +
    "注意：`stage3_hourly.degraded = true` 时表示小时线数据不足或未确认，" +
    "结论里必须明说「小时线未确认」，不能当成三阶段已确认。"
  );
}

function formatBacktest(data: BacktestData): string {
  const m = data.metrics;
  const targetLine = Object.entries(data.targets)
    .map(([key, passed]) => `${key} ${passed ? "✓" : "✗"}`)
    .join(" · ");
  const trades = data.recent_trades
    .map(
      (trade) =>
        `  · ${String(trade.entry_date ?? trade.entry_ts ?? "?")} → ${String(
          trade.exit_date ?? trade.exit_ts ?? "?",
        )}  pnl=${formatNumber(Number(trade.pnl), 0)}  ${
          trade.win ? "盈" : "亏"
        }`,
    )
    .join("\n");

  return [
    `回测结果（${data.symbol}，${data.bars} 根日线，${data.first.slice(0, 10)} → ${data.last.slice(0, 10)}）`,
    "",
    `  累计收益率    ${formatNumber(m.return_pct as number)}%`,
    `  最大回撤      ${formatNumber(m.max_drawdown_pct as number)}%`,
    `  胜率          ${formatNumber(m.win_rate as number)}%`,
    `  盈亏比        ${formatNumber(m.pl_ratio as number, 3)}`,
    `  夏普比率      ${formatNumber(m.sharpe as number, 3)}`,
    `  有效信号率    ${formatNumber(m.signal_rate as number)}%`,
    `  交易次数      ${data.trade_count}（平均持仓 ${formatNumber(
      m.avg_holding_days as number,
      1,
    )} 天）`,
    `  期末权益      $${formatNumber(m.final_equity as number, 0)}`,
    "",
    `目标达成：${targetLine}`,
    "",
    `参数：${JSON.stringify(data.params)}`,
    Object.keys(data.overrides).length > 0
      ? `本次覆盖：${JSON.stringify(data.overrides)}`
      : "本次覆盖：（无）",
    trades ? `\n最近成交：\n${trades}` : "",
    "\n口径：T 日收盘价成交，手续费 0.05%，资金费 0.01%/8h，无滑点（收益偏乐观）。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 行情标的：与 Python 侧 `config.settings.symbol` 读同一个环境变量，避免两边不一致 */
function activeSymbol(): string {
  return process.env.BTC_SYMBOL?.trim() || "BTC/USDT";
}

// ─────────────────────────── btc_price ───────────────────────────

const priceTool: ToolDefinition = {
  name: "btc_price",
  modes: BTC_MODES,
  description:
    "查交易所的最新价、24h 涨跌幅与成交额（实时接口，不读本地库，也不下单）。" +
    "默认币安永续；标的默认 BTC/USDT，可用环境变量 BTC_SYMBOL 改（平台用 BTC_EXCHANGE）。" +
    "判断「现在价格多少」时用它，" +
    "判断「趋势与买卖点」用 btc_signal（后者基于本地库，需要先 btc_sync）。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const { exchange, error } = activeExchange();
    if (error) return { ok: false, content: `✗ ${error}` };
    const symbol = activeSymbol();
    try {
      const ticker = await exchange.fetchTicker(symbol);
      return {
        ok: true,
        content: [
          `${ticker.symbol} 最新价：${ticker.price}`,
          `24h 涨跌：${ticker.changePct > 0 ? "+" : ""}${ticker.changePct.toFixed(2)}%`,
          `24h 区间：${ticker.low24h} — ${ticker.high24h}`,
          `24h 成交额：${(ticker.quoteVolume / 1e8).toFixed(2)} 亿 USDT`,
        ].join("\n"),
        summary: `${ticker.symbol} ${ticker.price}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 获取行情失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ─────────────────────────── btc_status ───────────────────────────

const statusTool: ToolDefinition = {
  name: "btc_status",
  modes: BTC_MODES,
  description:
    "查看 btc 模式的运行环境与本地行情库状态：计算环境是否装好、日线/小时线各多少根、" +
    "最新数据时间、交易标的与风控参数。**任何交易判断之前先调它**，以免拿着过期数据下结论。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const home = getBtcHome();
    const assets = ensureBtcAssets(home);
    const lines = describeEnv(home);

    if (!assets.available) {
      lines.push(
        `✗ 找不到 btc 计算资产（应为 ${assets.assetsDir}）。` +
          "若通过 npm 安装，请重新安装或运行 `xzh btc setup`。",
      );
      return { ok: false, content: lines.join("\n") };
    }
    if (!btcVenvReady(home)) {
      const db = `${home}/data/btc.db`;
      return {
        ok: true,
        content: `${lines.join("\n")}\n数据库：${db}（尚未创建，需先装环境再同步）`,
        summary: "btc 环境未就绪",
      };
    }

    const result = await runRunner<BtcStatusData>("status");
    if (!result.ok) {
      return {
        ok: false,
        content: `${lines.join("\n")}\n✗ 读取状态失败：${result.error}${
          result.detail ? `\n${result.detail}` : ""
        }`,
      };
    }

    const data = result.data;
    const active = activeExchange();
    const exchangeLine = active.error
      ? `交易所配置：✗ ${active.error}`
      : `交易所：${active.exchange.label}（${active.exchange.toNativeSymbol(data.symbol)}）`;
    const tfLines = ["1d", "1h"].map((tf) => {
      const item = data.timeframes[tf];
      if (!item || item.bars === 0) return `  ${tf}：0 根（还没同步，先 btc_sync）`;
      return `  ${tf}：${item.bars} 根，最新 ${item.last_utc ?? "?"}`;
    });

    return {
      ok: true,
      content: [
        ...lines,
        `标的：${data.symbol}`,
        exchangeLine,
        `数据库：${data.db_path}`,
        `Python：${data.python} · pandas ${data.pandas}`,
        `回测起点：${data.start_date}`,
        "行情：",
        ...tfLines,
        `风控：${JSON.stringify(data.risk)}`,
      ].join("\n"),
      summary: "btc 环境与数据状态",
    };
  },
};

// ─────────────────────────── btc_sync ───────────────────────────

const syncTool: ToolDefinition = {
  name: "btc_sync",
  modes: BTC_MODES,
  description:
    "从交易所同步 K 线到本地行情库（增量：从库内最后一根之后开始拉）。" +
    "首次使用、或 btc_status 显示数据过期时先调它。1d 默认拉 750 天、1h 默认 60 天，" +
    "可用 days 覆盖。同步只写本地库，不涉及任何交易。",
  parameters: {
    type: "object",
    properties: {
      timeframe: {
        type: "string",
        enum: ["1d", "1h", "all"],
        description: "要同步的周期，默认 all（日线 + 小时线）",
      },
      days: {
        type: "number",
        description: "缺失部分最多回补多少天；默认 1d=750、1h=60",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const requested = String(args.timeframe ?? "all");
    const targets: KlineInterval[] =
      requested === "1d" ? ["1d"] : requested === "1h" ? ["1h"] : ["1d", "1h"];
    const days =
      typeof args.days === "number" && Number.isFinite(args.days) && args.days > 0
        ? Math.floor(args.days)
        : undefined;

    // 与常驻后端共用同一套同步实现（见 src/btc/market-data.ts）：两边写同一个库，
    // 口径必须一致，不能各写一份「查最后时间 → 增量拉 → 分批写」。
    const result = await syncMarketData({ timeframes: targets, days });
    if (result.error) {
      return { ok: false, content: `✗ ${result.error}` };
    }

    return {
      ok: result.ok,
      content:
        `行情同步（${activeExchange().exchange.label}）：
${result.report.join("\n")}
` +
        (result.written > 0
          ? `\n共写入 ${result.written} 根。`
          : "\n本次没有新增数据。"),
      summary: `同步 ${result.written} 根 K 线`,
    };
  },
};

// ─────────────────────────── btc_signal ───────────────────────────

const signalTool: ToolDefinition = {
  name: "btc_signal",
  modes: BTC_MODES,
  description:
    "三阶段买卖点判断（周线定势 → 日线定向 → 小时线定时），返回每一阶段的判定、" +
    "置信度、建议动作（long/short/wait/stand_aside）、入场与止损目标。" +
    "数据来自本地库：先 btc_status 确认数据新鲜，必要时 btc_sync 补齐（尤其 1h）。" +
    "`action` 为 wait / stand_aside 时不得下单。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    ensureBtcAssets(getBtcHome());
    const result = await runRunner<unknown>("signal", {}, { timeoutMs: 60_000 });
    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 三阶段信号计算失败：${result.error}${
          result.detail ? `\n${result.detail}` : ""
        }`,
      };
    }
    return {
      ok: true,
      content: formatSignal(result.data),
      summary: "三阶段买卖点",
    };
  },
};

// ─────────────────────────── btc_backtest ───────────────────────────

const backtestTool: ToolDefinition = {
  name: "btc_backtest",
  modes: BTC_MODES,
  description:
    "用内置融合策略在本地日线上做全量回测，返回收益/回撤/胜率/盈亏比/夏普等指标。" +
    "overrides 可临时覆盖策略参数做对比实验（不写回源码，例如 {\"leverage\": 5}）。" +
    "对比不同参数时必须保证数据窗口与成本一致，否则结论无效。",
  parameters: {
    type: "object",
    properties: {
      overrides: {
        type: "object",
        description: "临时覆盖的策略参数，如 {\"leverage\": 5, \"sl_atr\": 2.0}",
      },
      start_date: {
        type: "string",
        description: "回测起始日期（北京时间 YYYY-MM-DD）；缺省用配置里的起点",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    ensureBtcAssets(getBtcHome());
    const overrides =
      typeof args.overrides === "object" && args.overrides !== null
        ? (args.overrides as Record<string, unknown>)
        : {};
    const startDate =
      typeof args.start_date === "string" && args.start_date.trim()
        ? args.start_date.trim()
        : undefined;

    const result = await runRunner<BacktestData>(
      "backtest",
      { overrides, start_date: startDate },
      { timeoutMs: 180_000 },
    );
    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 回测失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }
    return {
      ok: true,
      content: formatBacktest(result.data),
      summary: `回测 ${result.data.trade_count} 笔`,
    };
  },
};

// ─────────────────────────── btc_schedule ───────────────────────────

const scheduleTool: ToolDefinition = {
  name: "btc_schedule",
  modes: BTC_MODES,
  description:
    "安排巡检时间。默认 **mode=replace：改写「下一跳」**——原来排在后面的巡检会被取消，" +
    "所以「本来 1 小时后，改成 30 分钟后」直接调一次即可，不会两条都跑。" +
    "mode=add 是额外加一个检查点（不改原有的下一跳）。" +
    "后台每分钟检查一次队列，到点就执行。**后台巡检时必须在结束前调用**，" +
    "间隔由你自己判断：信号刚触发或临近关键位 15–60 分钟；明确观望 2–8 小时；" +
    "预计日线收盘/数据更新前需确认则定在那之前。生效范围 10 分钟–12 小时。",
  parameters: {
    type: "object",
    properties: {
      next_check_minutes: {
        type: "number",
        description: "多少分钟后再巡检（与 next_check_at 二选一）",
      },
      next_check_at: {
        type: "string",
        description: "指定时间点（ISO，如 2026-11-03T15:00:00+08:00）",
      },
      reason: {
        type: "string",
        description: "为什么定这个时间（一句话，会显示在 xzh btc status）",
      },
      decision: {
        type: "string",
        description: "本轮巡检结论（一句话，可选）",
      },
      mode: {
        type: "string",
        enum: ["replace", "add"],
        description:
          "replace（默认）= 改写下一跳，旧的会被取消；add = 额外检查点，不影响下一跳",
      },
    },
    required: ["reason"],
  },
  async execute(args): Promise<ToolResult> {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason) {
      return {
        ok: false,
        content: "错误：必须给 reason，说明为什么把下次巡检定在这个时间。",
      };
    }

    const minutes =
      typeof args.next_check_minutes === "number" &&
      Number.isFinite(args.next_check_minutes)
        ? args.next_check_minutes
        : undefined;
    const at =
      typeof args.next_check_at === "string" ? args.next_check_at.trim() : undefined;
    const slot = args.mode === "add" ? "extra" : "next";

    const result = pushSchedule(
      getBtcHome(),
      {
      minutes,
      at,
      reason,
      decision:
        typeof args.decision === "string" && args.decision.trim()
          ? args.decision.trim()
          : undefined,
        slot,
        origin: process.env.XZH_BTC_INSPECT === "1" ? "inspect" : "manual",
      },
      currentScheduleRole(),
    );

    const waitMin = Math.max(
      1,
      Math.round((Date.parse(result.entry.at) - Date.now()) / 60_000),
    );
    const cancelled = result.replacedEntries
      .map(
        (entry) =>
          `  · 已取消 ${entry.at}（${entry.reason}）`,
      )
      .join("\n");

    return {
      ok: true,
      content:
        `${slot === "next" ? "已改写下一跳" : "已加入额外检查点"}：` +
        `${result.entry.at}（约 ${waitMin} 分钟后，id ${result.entry.id}）\n` +
        `理由：${reason}` +
        (cancelled ? `\n${cancelled}` : "") +
        `\n队列现有 ${result.size} 条` +
        (result.dropped > 0 ? `（超过上限，丢弃了 ${result.dropped} 条最远的）` : "") +
        (result.entry.clamped
          ? `\n（你给的时间超出 10 分钟–12 小时的允许范围，已调整）`
          : ""),
      summary:
        slot === "next"
          ? `${waitMin} 分钟后巡检（已改写下一跳）`
          : `${waitMin} 分钟后额外巡检`,
    };
  },
};

// ─────────────────────────── btc_unschedule ───────────────────────────

const unscheduleTool: ToolDefinition = {
  name: "btc_unschedule",
  modes: BTC_MODES,
  description:
    "撤销巡检计划。默认撤销「下一跳」（后台的下次巡检）；scope=extra 只撤额外检查点；" +
    "all 全部撤销。也可以用 id 精确撤销（id 从 btc_schedule 的返回或 xzh btc status 里拿）。" +
    "注意：全部撤销后后端**不是永久停止**，队列空且超过 60 分钟没巡检时会自行兜底跑一轮；" +
    "要彻底停后台请让用户执行 xzh btc stop。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "要撤销的计划 id（优先于 scope）" },
      scope: {
        type: "string",
        enum: ["next", "extra", "all"],
        description: "没给 id 时撤销哪一类，默认 next",
      },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const id = typeof args.id === "string" ? args.id.trim() : undefined;
    const rawScope = typeof args.scope === "string" ? args.scope : "next";
    const scope =
      rawScope === "extra" || rawScope === "all" ? rawScope : "next";

    const result = removeSchedules(
      getBtcHome(),
      { id, scope },
      currentScheduleRole(),
    );

    if (result.removed.length === 0) {
      return {
        ok: true,
        content: id
          ? `没有找到 id 为 ${id} 的巡检计划（可能已被执行或已撤销）。`
          : "当前队列里没有可撤销的计划。",
      };
    }

    const removed = result.removed
      .map((entry) => `  · ${entry.at}（${entry.reason}）`)
      .join("\n");
    return {
      ok: true,
      content:
        `已撤销 ${result.removed.length} 条计划：\n${removed}\n` +
        `队列剩余 ${result.remaining} 条` +
        (result.remaining === 0
          ? "；队列已空，后端会在 60 分钟兜底再巡检一次（要彻底停请用 xzh btc stop）"
          : ""),
      summary: `撤销 ${result.removed.length} 条计划`,
    };
  },
};

// ─────────────────────────── 真实交易（只做合约） ───────────────────────────

const orderTool: ToolDefinition = {
  name: "btc_order",
  modes: BTC_MODES,
  danger: true,
  description:
    "**真实挂单**（币安 U 本位合约，**限价 GTC**）。需要先配置凭据（xzh btc apikey）。" +
    "必须给 limit_price：不追价、不立即成交，没成交就一直挂着，直到下一次买卖点或主动撤单。" +
    "按 notional（USDT 名义，按限价折算数量）或 quantity 二选一；可带 stop_loss / take_profit，" +
    "它们会作为 closePosition 条件单挂在交易所（触发时按当时仓位全平）。" +
    "硬性风控已触发时本工具会被拒绝。开仓前必须说清方向、限价、仓位、止损与依据。",
  parameters: {
    type: "object",
    properties: {
      side: { type: "string", enum: ["long", "short"], description: "方向" },
      limit_price: {
        type: "number",
        description: "限价（必填）：挂单等待成交，不追价",
      },
      notional: { type: "number", description: "名义金额（USDT）" },
      quantity: { type: "number", description: "币数量（与 notional 二选一）" },
      leverage: { type: "number", description: "杠杆 1–125（可选，会先设置）" },
      stop_loss: { type: "number", description: "止损触发价（可选）" },
      take_profit: { type: "number", description: "止盈触发价（可选）" },
      reason: { type: "string", description: "下单依据（一句话）" },
    },
    required: ["side", "limit_price", "reason"],
  },
  async execute(args): Promise<ToolResult> {
    const side = String(args.side ?? "").toLowerCase();
    if (side !== "long" && side !== "short") {
      return { ok: false, content: "错误：side 只能是 long 或 short。" };
    }
    const notional = typeof args.notional === "number" ? args.notional : undefined;
    const quantity = typeof args.quantity === "number" ? args.quantity : undefined;
    const limitPrice =
      typeof args.limit_price === "number" ? args.limit_price : undefined;
    if (!(limitPrice && limitPrice > 0)) {
      return {
        ok: false,
        content: "错误：开仓统一使用限价单，必须给 limit_price（大于 0）。",
      };
    }
    if (!notional && !quantity) {
      return { ok: false, content: "错误：需要 notional 或 quantity 之一。" };
    }

    try {
      const result = await openPosition({
        side,
        limitPrice,
        notional,
        quantity,
        leverage: typeof args.leverage === "number" ? args.leverage : undefined,
        stopLoss: typeof args.stop_loss === "number" ? args.stop_loss : undefined,
        takeProfit:
          typeof args.take_profit === "number" ? args.take_profit : undefined,
      });
      const lines = [
        `✓ 已挂${side === "long" ? "买入" : "卖出"}限价单 ${result.symbol} ${result.quantity} @ ${result.limitPrice}`,
        `  订单 ${result.orderId ?? "?"} · 状态 ${result.status ?? "?"}（NEW = 等待成交）` +
          `${result.leverage ? ` · ${result.leverage}x` : ""}`,
        `  **未成交前不算持仓**；成交与否用 btc_orders 查，撤单用 btc_cancel all=true。`,
        `  依据：${String(args.reason ?? "")}`,
      ];
      if (result.protection.length > 0) {
        lines.push(`  保护单：${result.protection.join(" · ")}`);
      }
      if (result.warnings.length > 0) {
        lines.push(`  ⚠ ${result.warnings.join("\n  ⚠ ")}`);
      }
      return {
        ok: true,
        content: lines.join("\n"),
        summary: `开${side === "long" ? "多" : "空"} ${result.quantity}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 下单失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const ordersTool: ToolDefinition = {
  name: "btc_orders",
  modes: BTC_MODES,
  description:
    "列出当前合约挂单（含限价开仓单与止损/止盈条件单）与持仓。" +
    "限价单挂出后用它确认是否成交；到下一次买卖点仍未成交时，应先判断是否撤单（btc_cancel）。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    const snapshot = await fetchAccountSnapshot({ force: true });
    if (!snapshot.ok) {
      return {
        ok: false,
        content: `✗ 读取账户失败：${snapshot.error ?? "未知原因"}`,
      };
    }

    const lines: string[] = [];
    if (snapshot.positions.length === 0) {
      lines.push("持仓：无");
    } else {
      lines.push("持仓：");
      for (const position of snapshot.positions) {
        lines.push(
          `  ${position.symbol} ${position.side === "long" ? "多" : "空"} ${position.qty} ` +
            `@ ${position.entryPrice}（浮盈 ${position.unrealized.toFixed(2)}，${position.roePct.toFixed(2)}%）`,
        );
      }
    }

    if (snapshot.orders.length === 0) {
      lines.push("挂单：无");
    } else {
      lines.push(`挂单 ${snapshot.orders.length} 条：`);
      for (const order of snapshot.orders) {
        lines.push(
          `  ${order.symbol} ${order.side === "buy" ? "买" : "卖"} ${order.type} ` +
            `${order.qty} @ ${order.price}${order.reduceOnly ? "（只减仓）" : ""}`,
        );
      }
    }

    return { ok: true, content: lines.join("\n"), summary: "查询挂单与持仓" };
  },
};

const closeTool: ToolDefinition = {
  name: "btc_close",
  modes: BTC_MODES,
  danger: true,
  description:
    "**真实平仓**：市价 + 只减仓（reduceOnly），把当前合约持仓全部平掉。没有持仓时会提示。" +
    "平仓不受硬性风控限制（降低风险的方向）。平仓后应回报成交价与盈亏；" +
    "若用户要求锁利，用 btc_transfer_profit 把约定比例划到现货。",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "平仓原因（一句话）" },
    },
    required: ["reason"],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const result = await closePosition();
      if (!result) {
        return { ok: true, content: "当前没有可平的合约持仓。" };
      }
      return {
        ok: true,
        content:
          `✓ 已平仓 ${result.symbol} ${result.side === "long" ? "多" : "空"} ${result.quantity}\n` +
          `  订单 ${result.orderId ?? "?"} · 状态 ${result.status ?? "?"}` +
          `${result.price ? ` · 参考价 ${result.price}` : ""}\n` +
          `  依据：${String(args.reason ?? "")}`,
        summary: `平仓 ${result.symbol}`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 平仓失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const cancelTool: ToolDefinition = {
  name: "btc_cancel",
  modes: BTC_MODES,
  description:
    "撤单：给 order_id 撤单笔，给 all=true 撤掉该交易对全部挂单（含止损/止盈条件单）。" +
    "撤掉保护单后仓位就没有止损了，务必提醒用户。",
  parameters: {
    type: "object",
    properties: {
      order_id: { type: "string", description: "要撤的订单号" },
      all: { type: "boolean", description: "撤掉当前交易对的全部挂单" },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const orderId =
      typeof args.order_id === "string" && args.order_id.trim()
        ? args.order_id.trim()
        : undefined;
    const all = args.all === true;
    if (!orderId && !all) {
      return { ok: false, content: "错误：需要 order_id 或 all=true。" };
    }
    try {
      const result = await cancelOrders({ orderId, all });
      return {
        ok: true,
        content:
          result.cancelled === "all"
            ? `✓ 已撤掉 ${result.symbol} 的全部挂单`
            : `✓ 已撤单 ${result.orderId}（${result.symbol}）`,
        summary: "已撤单",
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 撤单失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const transferTool: ToolDefinition = {
  name: "btc_transfer_profit",
  modes: BTC_MODES,
  danger: true,
  description:
    "把合约账户的 USDT **划转到现货账户**（单向，用于锁定已实现收益）。" +
    "上限是可用余额的 95%（留保证金）。这是本项目唯一的划转能力：" +
    "不能反向（现货→合约），也不能提到外部地址。" +
    "用户说「把每笔收益的 10% 转出来」时，按平仓金额算出具体 USDT 数再调用。",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "划转金额（USDT），必须大于 0" },
      reason: { type: "string", description: "划转依据（如「锁定本轮收益 10%」）" },
    },
    required: ["amount", "reason"],
  },
  async execute(args): Promise<ToolResult> {
    const amount =
      typeof args.amount === "number" ? args.amount : Number.NaN;
    if (!(Number.isFinite(amount) && amount > 0)) {
      return { ok: false, content: "错误：amount 必须是大于 0 的数字。" };
    }
    try {
      const result = await transferProfitToSpot(amount);
      return {
        ok: true,
        content:
          `✓ 已划转 ${result.amount} USDT 到现货账户\n` +
          `  划转前可用 ${result.availableBefore.toFixed(2)} USDT` +
          `${result.tranId ? ` · 流水 ${result.tranId}` : ""}\n` +
          `  依据：${String(args.reason ?? "")}`,
        summary: `划转 ${result.amount} USDT 到现货`,
      };
    } catch (err) {
      return {
        ok: false,
        content: `✗ 划转失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

// ─────────────────────────── 模拟盘（虚拟账本，不涉及真钱） ───────────────────────────

interface PaperPosition {
  side: string;
  qty: number;
  entry_price: number;
  notional: number;
  stop_price: number | null;
  unrealized: number;
  unrealized_pct: number;
  entry_ts?: string;
}

interface PaperStatusData {
  initial_capital: number;
  /** 未成交的限价挂单（收盘价到达限价才成交） */
  open_orders?: Array<{
    id: number;
    side: string;
    qty: number;
    limit_price: number;
    notional: number;
    reason: string;
  }>;
  cash: number;
  equity: number;
  return_pct: number;
  price: number;
  position: PaperPosition | null;
  trades: number;
  wins: number;
  win_rate: number;
  realized_pnl: number;
  fees_paid: number;
  /** 只有 btc_paper_status 会带明细；开平仓返回的 status 可能没有 */
  recent_trades?: Array<{
    side: string;
    qty: number;
    entry_price: number;
    exit_price: number;
    pnl: number;
    exit_reason: string | null;
  }>;
}

function formatPaperStatus(data: PaperStatusData): string {
  const lines = [
    `模拟盘（虚拟账本，不涉及真钱）· 现价 ${data.price}`,
    `  初始资金 ${formatNumber(data.initial_capital, 0)} · 现金 ${formatNumber(
      data.cash,
    )} · 权益 ${formatNumber(data.equity)}（${data.return_pct >= 0 ? "+" : ""}${formatNumber(
      data.return_pct,
    )}%）`,
  ];

  const pending = data.open_orders ?? [];
  if (pending.length > 0) {
    lines.push("  挂单（未成交）：");
    for (const order of pending) {
      lines.push(
        `    · #${order.id} ${order.side === "long" ? "买" : "卖"} ` +
          `${order.qty} @ ${formatNumber(order.limit_price)}（${order.reason || "无理由"}）`,
      );
    }
  }

  if (data.position) {
    const p = data.position;
    lines.push(
      `  持仓：${p.side === "long" ? "多" : "空"} ${p.qty} @ ${formatNumber(p.entry_price)}` +
        `（名义 ${formatNumber(p.notional, 0)}）· 浮盈 ${p.unrealized >= 0 ? "+" : ""}${formatNumber(
          p.unrealized,
        )}（${formatNumber(p.unrealized_pct)}%）` +
        (p.stop_price ? ` · 止损 ${formatNumber(p.stop_price)}` : ""),
    );
  } else {
    lines.push("  持仓：无");
  }

  lines.push(
    `  已平仓 ${data.trades} 笔 · 胜率 ${formatNumber(data.win_rate)}% · ` +
      `实现盈亏 ${data.realized_pnl >= 0 ? "+" : ""}${formatNumber(data.realized_pnl)} · ` +
      `手续费 ${formatNumber(data.fees_paid)}`,
  );

  const recent = data.recent_trades ?? [];
  if (recent.length > 0) {
    lines.push("  最近成交：");
    for (const trade of recent) {
      lines.push(
        `    · ${trade.side === "long" ? "多" : "空"} ${trade.qty} ` +
          `${formatNumber(trade.entry_price)} → ${formatNumber(trade.exit_price)}  ` +
          `pnl ${trade.pnl >= 0 ? "+" : ""}${formatNumber(trade.pnl)}` +
          (trade.exit_reason ? `（${trade.exit_reason}）` : ""),
      );
    }
  }
  return lines.join("\n");
}

const paperStatusTool: ToolDefinition = {
  name: "btc_paper_status",
  modes: BTC_MODES,
  description:
    "查看模拟盘状态：虚拟账本的初始资金、现金、持仓、浮动盈亏、权益、收益率、历史绩效与最近成交。" +
    "**模拟盘不涉及真钱**，用于验证策略与决策，不要把它当成实盘账户。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(): Promise<ToolResult> {
    ensureBtcAssets(getBtcHome());
    const result = await runRunner<PaperStatusData>("paper-status");
    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 读取模拟盘失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }
    return {
      ok: true,
      content: formatPaperStatus(result.data),
      summary: `模拟盘权益 ${formatNumber(result.data.equity)}`,
    };
  },
};

const paperOpenTool: ToolDefinition = {
  name: "btc_paper_open",
  modes: BTC_MODES,
  description:
    "在模拟盘（虚拟账本）**挂限价单**：不立即成交，最新收盘价到达限价即视为全部成交（扣 0.05%）。" +
    "**不涉及真钱**。同一时间只允许一个持仓、一张未成交挂单；开仓前说清方向、限价、名义金额、止损与依据。",
  parameters: {
    type: "object",
    properties: {
      side: { type: "string", enum: ["long", "short"], description: "方向" },
      limit_price: {
        type: "number",
        description: "限价（必填）：收盘价到达即成交",
      },
      notional: {
        type: "number",
        description: "名义金额（USDT），不能超过可用现金",
      },
      stop_price: { type: "number", description: "止损价（可选，仅记录）" },
      reason: { type: "string", description: "开仓依据（一句话）" },
    },
    required: ["side", "limit_price", "notional", "reason"],
  },
  async execute(args): Promise<ToolResult> {
    const side = String(args.side ?? "").toLowerCase();
    if (side !== "long" && side !== "short") {
      return { ok: false, content: "错误：side 只能是 long 或 short。" };
    }
    const notional = Number(args.notional);
    if (!Number.isFinite(notional) || notional <= 0) {
      return { ok: false, content: "错误：notional 必须是大于 0 的数字。" };
    }
    const limitPrice = Number(args.limit_price);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      return { ok: false, content: "错误：limit_price 必须是大于 0 的数字。" };
    }

    const result = await runRunner<{
      order_id: number;
      side: string;
      qty: number;
      limit_price: number;
      status: PaperStatusData;
    }>("paper-open", {
      side,
      notional,
      limit_price: limitPrice,
      stop_price: typeof args.stop_price === "number" ? args.stop_price : undefined,
      reason: String(args.reason ?? ""),
    });

    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 模拟开仓失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }

    const data = result.data;
    return {
      ok: true,
      content:
        `模拟盘已挂${data.side === "long" ? "买" : "卖"}单 #${data.order_id}：` +
        `${data.qty} @ ${formatNumber(data.limit_price)}\n` +
        `未成交前不算持仓；收盘价到达限价即视为全部成交（下次查看状态时结算）。\n\n` +
        formatPaperStatus(data.status),
      summary: `模拟挂单 ${data.limit_price}`,
    };
  },
};

const paperCloseTool: ToolDefinition = {
  name: "btc_paper_close",
  modes: BTC_MODES,
  description:
    "在模拟盘（虚拟账本）平仓：按库内最新收盘价结算，扣 0.05% 手续费，记录一笔成交。" +
    "**不涉及真钱**。平仓后应回报盈亏与权益变化。",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "平仓原因（一句话）" },
    },
    required: ["reason"],
  },
  async execute(args): Promise<ToolResult> {
    const result = await runRunner<{
      side: string;
      entry_price: number;
      exit_price: number;
      pnl: number;
      fee: number;
      cash_after: number;
      status: PaperStatusData;
    }>("paper-close", { reason: String(args.reason ?? "") });

    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 模拟平仓失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }

    const data = result.data;
    return {
      ok: true,
      content:
        `模拟盘已平仓：${data.side === "long" ? "多" : "空"} ` +
        `${formatNumber(data.entry_price)} → ${formatNumber(data.exit_price)}，` +
        `盈亏 ${data.pnl >= 0 ? "+" : ""}${formatNumber(data.pnl)}（手续费 ${formatNumber(
          data.fee,
        )}）\n\n` +
        formatPaperStatus(data.status),
      summary: `模拟平仓 pnl ${formatNumber(data.pnl)}`,
    };
  },
};

const paperCancelTool: ToolDefinition = {
  name: "btc_paper_cancel",
  modes: BTC_MODES,
  description:
    "撤掉模拟盘未成交的限价单（不传 order_id 撤全部）。**不涉及真钱**。" +
    "到下一次买卖点仍未成交、或信号已经变了，就撤掉重挂。",
  parameters: {
    type: "object",
    properties: {
      order_id: { type: "number", description: "要撤的挂单 id（不传则撤全部）" },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const orderId =
      typeof args.order_id === "number" ? args.order_id : undefined;
    const result = await runRunner<{
      cancelled: number;
      status: PaperStatusData;
    }>("paper-cancel", orderId === undefined ? {} : { order_id: orderId });

    if (!result.ok) {
      return {
        ok: false,
        content: `✗ 撤单失败：${result.error}${result.detail ? `\n${result.detail}` : ""}`,
      };
    }
    return {
      ok: true,
      content:
        `已撤销 ${result.data.cancelled} 张挂单\n\n` +
        formatPaperStatus(result.data.status),
      summary: `撤单 ${result.data.cancelled}`,
    };
  },
};

const paperResetTool: ToolDefinition = {
  name: "btc_paper_reset",
  requiresConfirmation: true,
  modes: BTC_MODES,
  description:
    "清空模拟盘账本（成交记录与持仓全部删除，资金恢复初始值）。**仅在用户明确要求时使用**；" +
    "后台巡检里该操作会被自动拒绝（无人确认）。",
  parameters: {
    type: "object",
    properties: {
      capital: { type: "number", description: "新的初始资金，默认沿用 100000" },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const result = await runRunner<{ reset: boolean; capital: number }>(
      "paper-reset",
      typeof args.capital === "number" ? { capital: args.capital } : {},
    );
    if (!result.ok) {
      return { ok: false, content: `✗ 重置模拟盘失败：${result.error}` };
    }
    return {
      ok: true,
      content: `模拟盘账本已清空，初始资金 ${formatNumber(result.data.capital, 0)}。`,
      summary: "模拟盘已重置",
    };
  },
};

// ─────────────────────────── btc_policy（决策指令） ───────────────────────────

const policyTool: ToolDefinition = {
  name: "btc_policy",
  modes: BTC_MODES,
  description:
    "查看 / 追加 / 替换 / 清空用户的**决策指令**。指令会注入后台每一轮巡检，" +
    "用来落实「以后别逆势」「单笔最多 1%」「只看日线」这类**长期要求**。" +
    "用户在对话里提出的长期偏好必须用本工具落盘 —— 只说一句「记住了」不会传给后台巡检。" +
    "写法要具体可验证（阈值、周期、禁止的动作）；上限 4000 字符，超出按最旧条目丢弃。",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["show", "append", "replace", "clear"],
        description:
          "show 查看 / append 追加一条 / replace 整份替换 / clear 清空（仅用户明确要求时）",
      },
      content: {
        type: "string",
        description: "append 写一条指令；replace 写完整策略。show / clear 不需要",
      },
    },
    required: ["action"],
  },
  async execute(args): Promise<ToolResult> {
    const home = getBtcHome();
    const action = String(args.action ?? "").trim().toLowerCase();
    const content = typeof args.content === "string" ? args.content : "";

    if (action === "show") {
      const text = readPolicy(home);
      return {
        ok: true,
        content: text
          ? `当前决策指令（${text.length} 字符）：\n\n${text}`
          : "当前还没有设定任何决策指令。用户提出长期要求时用 btc_policy append 落盘。",
        summary: "查看决策指令",
      };
    }

    if (action === "append") {
      if (!content.trim()) {
        return { ok: false, content: "错误：append 需要 content（一条具体、可验证的要求）。" };
      }
      const result = appendPolicy(home, content);
      return {
        ok: true,
        content:
          `已追加一条决策指令（当前 ${result.text.length} 字符` +
          (result.dropped > 0 ? `，丢弃 ${result.dropped} 条最旧的` : "") +
          `）：\n\n${result.text}\n\n` +
          "这条指令会注入后台每一轮巡检，下一轮开始生效。",
        summary: "已追加决策指令",
      };
    }

    if (action === "replace") {
      if (!content.trim()) {
        return {
          ok: false,
          content: "错误：replace 需要 content。若想清空请用 action=clear。",
        };
      }
      const result = replacePolicy(home, content);
      return {
        ok: true,
        content:
          `决策指令已整份替换（${result.text.length} 字符` +
          (result.truncated ? "，超出上限已截断最前面的部分" : "") +
          `）：\n\n${result.text}`,
        summary: "已替换决策指令",
      };
    }

    if (action === "clear") {
      clearPolicy(home);
      return {
        ok: true,
        content: "决策指令已清空。后台巡检将回到默认纪律（三阶段 + 风控红线）。",
        summary: "已清空决策指令",
      };
    }

    return {
      ok: false,
      content: "错误：action 只能是 show / append / replace / clear。",
    };
  },
};

export const btcTools: ToolDefinition[] = [
  priceTool,
  statusTool,
  syncTool,
  signalTool,
  backtestTool,
  scheduleTool,
  unscheduleTool,
  policyTool,
  paperStatusTool,
  paperOpenTool,
  paperCloseTool,
  paperCancelTool,
  paperResetTool,
  orderTool,
  ordersTool,
  closeTool,
  cancelTool,
  transferTool,
];
